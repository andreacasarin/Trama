import { Document, type DocumentInterface } from "@langchain/core/documents";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { VectorStore } from "@langchain/core/vectorstores";
import { MarkdownTextSplitter } from "@langchain/textsplitters";
import { sha256 } from "@langchain/core/utils/hash";
import type { NoteStoreCall } from "./note-sqlite/protocol";

interface ScopedEmbeddings extends EmbeddingsInterface<number[]> {
  withSignal?(signal?: AbortSignal): EmbeddingsInterface<number[]>;
}

export interface NoteEmbeddingProfile {
  readonly endpoint: string;
  readonly modelId: string;
  readonly dimensions: number;
}

export function embeddingEndpointFingerprint(rawEndpoint: string): string | undefined {
  const endpoint = new URL(rawEndpoint);
  if (!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash)
    return undefined;
  return sha256(endpoint.href);
}

export function noteEmbeddingProfile(profile: NoteEmbeddingProfile): string {
  const endpoint = new URL(profile.endpoint);
  const endpointFingerprint = embeddingEndpointFingerprint(profile.endpoint);
  endpoint.username = "";
  endpoint.password = "";
  endpoint.search = "";
  endpoint.hash = "";
  return JSON.stringify({
    endpoint: endpoint.href.replace(/\/$/, ""),
    modelId: profile.modelId.trim(),
    dimensions: profile.dimensions,
    splitter: "langchain-markdown-default-v1",
    preprocessing: "raw-markdown-v1",
    ...(endpointFingerprint ? { endpointFingerprint } : {}),
  });
}

export type NoteReader = (path: string) => Promise<string | null>;

interface PendingNote {
  readonly uid: string;
  readonly path: string;
  readonly profile: string;
  readonly markdown: string;
  readonly chunks: DocumentInterface[];
}

const MAX_BATCH_CHUNKS = 512;

export class SqliteNoteVectorStore extends VectorStore {
  private readonly profile: string;
  private readonly dimensions: number;
  private readonly splitter = new MarkdownTextSplitter();
  private readonly runSignal?: AbortSignal;

  constructor(
    embeddings: ScopedEmbeddings,
    private readonly call: NoteStoreCall,
    private readonly readNote: NoteReader,
    profile: NoteEmbeddingProfile | string,
    runSignal?: AbortSignal,
    knownDimensions?: number
  ) {
    super(embeddings, {});
    this.profile = typeof profile === "string" ? profile : noteEmbeddingProfile(profile);
    this.dimensions = typeof profile === "string" ? (knownDimensions ?? 0) : profile.dimensions;
    this.runSignal = runSignal;
    if (
      typeof profile !== "string" &&
      (!Number.isSafeInteger(profile.dimensions) || profile.dimensions < 1)
    )
      throw new TypeError("Embedding dimensions must be a positive integer");
  }

  _vectorstoreType(): string {
    return "sqlite-note";
  }

  get embeddingProfile(): string {
    return this.profile;
  }

  withSignal(signal: AbortSignal): SqliteNoteVectorStore {
    const embeddings =
      (this.embeddings as ScopedEmbeddings).withSignal?.(signal) ?? this.embeddings;
    return new SqliteNoteVectorStore(
      embeddings,
      this.call,
      this.readNote,
      this.profile,
      signal,
      this.dimensions
    );
  }

  reset(signal?: AbortSignal): Promise<unknown> {
    return this.call("noteStoreReset", {}, signal ?? this.runSignal);
  }

  async addDocuments(
    documents: DocumentInterface[],
    options: { signal?: AbortSignal; ids?: string[] } = {}
  ): Promise<string[]> {
    if (options.ids && options.ids.length !== documents.length)
      throw new TypeError("Document UIDs must match document count");
    const signal = options.signal ?? this.runSignal;
    const pending: PendingNote[] = [];
    const uids: string[] = [];
    let pendingChunkCount = 0;
    const flush = async () => {
      if (pending.length === 0) return;
      checkAbort(signal);
      const chunks = pending.flatMap((note) => note.chunks);
      const vectors = await this.embeddings.embedDocuments(
        chunks.map(({ pageContent }) => pageContent)
      );
      if (vectors.length !== chunks.length)
        throw new TypeError("Embedding count did not match chunk count");
      checkAbort(signal);
      let vectorOffset = 0;
      for (const note of pending) {
        const noteVectors = vectors.slice(vectorOffset, vectorOffset + note.chunks.length);
        vectorOffset += note.chunks.length;
        await this.writeNote(
          note.uid,
          note.path,
          note.profile,
          note.markdown,
          noteVectors,
          note.chunks,
          signal
        );
      }
      pending.length = 0;
      pendingChunkCount = 0;
    };

    for (let index = 0; index < documents.length; index++) {
      checkAbort(signal);
      const note = documents[index];
      const path = this.notePath(note);
      const uid = options.ids?.[index] ?? note.id ?? path;
      const profile =
        typeof note.metadata.embeddingProfile === "string"
          ? note.metadata.embeddingProfile
          : this.profile;
      if (!uid) throw new TypeError("A native document UID is required");
      const split = await this.splitter.splitDocuments([
        new Document({ pageContent: note.pageContent, metadata: { path } }),
      ]);
      const chunks = split.map(
        (chunk, ordinal) =>
          new Document({ pageContent: chunk.pageContent, metadata: { path, ordinal } })
      );
      uids.push(uid);

      if (chunks.length === 0) {
        await flush();
        checkAbort(signal);
        await this.writeNote(uid, path, profile, note.pageContent, [], [], signal);
      } else if (chunks.length > MAX_BATCH_CHUNKS) {
        await flush();
        const vectors: number[][] = [];
        for (let offset = 0; offset < chunks.length; offset += MAX_BATCH_CHUNKS) {
          checkAbort(signal);
          const batchChunks = chunks.slice(offset, offset + MAX_BATCH_CHUNKS);
          const batch = await this.embeddings.embedDocuments(
            batchChunks.map(({ pageContent }) => pageContent)
          );
          if (batch.length !== batchChunks.length)
            throw new TypeError("Embedding count did not match chunk count");
          vectors.push(...batch);
        }
        checkAbort(signal);
        await this.writeNote(uid, path, profile, note.pageContent, vectors, chunks, signal);
      } else {
        if (pendingChunkCount + chunks.length > MAX_BATCH_CHUNKS) await flush();
        pending.push({ uid, path, profile, markdown: note.pageContent, chunks });
        pendingChunkCount += chunks.length;
      }
    }
    await flush();
    return uids;
  }

  async addVectors(
    vectors: number[][],
    documents: DocumentInterface[],
    options: { note?: DocumentInterface; signal?: AbortSignal; ids?: string[] } = {}
  ): Promise<void> {
    const note = options.note;
    if (!note) throw new TypeError("The source note is required");
    const path = this.notePath(note);
    const split = await this.splitter.splitDocuments([
      new Document({ pageContent: note.pageContent, metadata: { path } }),
    ]);
    if (split.length !== documents.length) throw new TypeError("Chunk and vector counts differ");
    const uid = options.ids?.[0] ?? note.id ?? path;
    if (!uid) throw new TypeError("A native document UID is required");
    await this.writeNote(
      uid,
      path,
      typeof note.metadata.embeddingProfile === "string"
        ? note.metadata.embeddingProfile
        : this.profile,
      note.pageContent,
      vectors,
      documents,
      options.signal ?? this.runSignal
    );
  }

  private async writeNote(
    uid: string,
    path: string,
    profile: string,
    markdown: string,
    vectors: number[][],
    documents: DocumentInterface[],
    signal?: AbortSignal
  ): Promise<void> {
    if (!path || !uid || vectors.length !== documents.length)
      throw new TypeError("Note path and vector count are invalid");
    for (let index = 0; index < documents.length; index++) {
      if (documents[index].metadata.path !== path || documents[index].metadata.ordinal !== index)
        throw new TypeError("Chunks must have one path and consecutive ordinals");
      if (vectors[index].length !== this.dimensions && this.dimensions !== 0)
        throw new TypeError("Embedding dimensions do not match the configured profile");
      if (!vectors[index].length || vectors[index].some((value) => !Number.isFinite(value)))
        throw new TypeError("Embedding vectors must contain finite values");
    }
    await this.call(
      "noteStoreReplace",
      {
        uid,
        path,
        profile,
        markdown,
        vectors,
      },
      signal
    );
  }

  private notePath(note: DocumentInterface): string {
    const path = note.metadata.path;
    if (typeof path !== "string" || !path || typeof note.pageContent !== "string")
      throw new TypeError("A note document needs a path and markdown content");
    return path;
  }

  async delete(params: { ids?: string[] }): Promise<void> {
    if (!params.ids) throw new TypeError("Document UIDs are required for deletion");
    await this.call("noteStoreDelete", { uids: params.ids }, this.runSignal);
  }

  async similaritySearchVectorWithScore(
    query: number[],
    k: number
  ): Promise<[DocumentInterface, number][]> {
    if (
      query.some((value) => !Number.isFinite(value)) ||
      !query.length ||
      (this.dimensions && query.length !== this.dimensions)
    )
      throw new TypeError("Query vector dimensions or values are invalid");
    const hits = (await this.call("noteStoreSemantic", {
      vector: query,
      profile: this.profile,
      k,
    })) as { path: string; score: number }[];
    const result: [DocumentInterface, number][] = [];
    for (const hit of hits) {
      const markdown = await this.readNote(hit.path);
      if (markdown !== null)
        result.push([
          new Document({ id: hit.path, pageContent: markdown, metadata: { path: hit.path } }),
          hit.score,
        ]);
    }
    return result;
  }
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Request cancelled", "AbortError");
}
