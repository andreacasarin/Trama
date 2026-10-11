import { Document, type DocumentInterface } from "@langchain/core/documents";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { VectorStore } from "@langchain/core/vectorstores";
import { MarkdownTextSplitter } from "@langchain/textsplitters";
import type { NoteStoreCall } from "./note-sqlite/protocol";

interface ScopedEmbeddings extends EmbeddingsInterface<number[]> {
  withSignal?(signal?: AbortSignal): EmbeddingsInterface<number[]>;
}

export interface NoteEmbeddingProfile {
  readonly endpoint: string;
  readonly modelId: string;
  readonly dimensions: number;
}

export function noteEmbeddingProfile(profile: NoteEmbeddingProfile): string {
  const endpoint = new URL(profile.endpoint);
  endpoint.search = "";
  endpoint.hash = "";
  return JSON.stringify({
    endpoint: endpoint.href.replace(/\/$/, ""),
    modelId: profile.modelId.trim(),
    dimensions: profile.dimensions,
    splitter: "langchain-markdown-default-v1",
    preprocessing: "raw-markdown-v1",
  });
}

export type NoteReader = (path: string) => Promise<string | null>;

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
    if (documents.length !== 1) throw new TypeError("Exactly one note must be indexed per call");
    const note = documents[0];
    const path = this.notePath(note);
    const uid = options.ids?.[0] ?? note.id ?? path;
    const profile =
      typeof note.metadata.embeddingProfile === "string"
        ? note.metadata.embeddingProfile
        : this.profile;
    const signal = options.signal ?? this.runSignal;
    if (!uid) throw new TypeError("A native document UID is required");
    checkAbort(signal);

    const split = await this.splitter.splitDocuments([
      new Document({ pageContent: note.pageContent, metadata: { path } }),
    ]);
    const chunks = split.map(
      (chunk, ordinal) =>
        new Document({ pageContent: chunk.pageContent, metadata: { path, ordinal } })
    );
    const vectors: number[][] = [];
    for (let offset = 0; offset < chunks.length; offset += 512) {
      checkAbort(signal);
      const batch = await this.embeddings.embedDocuments(
        chunks.slice(offset, offset + 512).map(({ pageContent }) => pageContent)
      );
      if (batch.length !== Math.min(512, chunks.length - offset))
        throw new TypeError("Embedding count did not match chunk count");
      vectors.push(...batch);
    }
    checkAbort(signal);
    await this.writeNote(uid, path, profile, note.pageContent, vectors, chunks, signal);
    return [uid];
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
