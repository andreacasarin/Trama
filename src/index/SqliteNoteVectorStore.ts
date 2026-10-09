import { Document, type DocumentInterface } from "@langchain/core/documents";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { VectorStore } from "@langchain/core/vectorstores";
import { MarkdownTextSplitter } from "@langchain/textsplitters";
import type { NoteStoreCall, NoteStoreEntry } from "./note-sqlite/protocol";

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

export async function noteContentHash(markdown: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(markdown)
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class SqliteNoteVectorStore extends VectorStore {
  private readonly profile: string;
  private readonly dimensions: number;
  private readonly splitter = new MarkdownTextSplitter();

  constructor(
    embeddings: ScopedEmbeddings,
    private readonly call: NoteStoreCall,
    private readonly readNote: NoteReader,
    profile: NoteEmbeddingProfile | string
  ) {
    super(embeddings, {});
    this.profile = typeof profile === "string" ? profile : noteEmbeddingProfile(profile);
    this.dimensions = typeof profile === "string" ? 0 : profile.dimensions;
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

  getEntry(path: string, signal?: AbortSignal): Promise<NoteStoreEntry | null> {
    return this.call("noteStoreGet", { path }, signal) as Promise<NoteStoreEntry | null>;
  }

  async *indexedPathPages(signal?: AbortSignal): AsyncGenerator<readonly string[]> {
    let afterPath: string | undefined;
    for (;;) {
      checkAbort(signal);
      const page = (await this.call(
        "noteStoreListPaths",
        { afterPath, limit: 512 },
        signal
      )) as string[];
      if (page.length === 0) return;
      yield page;
      if (page.length < 512) return;
      afterPath = page[page.length - 1];
    }
  }

  reset(signal?: AbortSignal): Promise<unknown> {
    return this.call("noteStoreReset", {}, signal);
  }

  async replaceLexical(note: DocumentInterface, signal?: AbortSignal): Promise<void> {
    const path = typeof note.metadata.path === "string" ? note.metadata.path : note.id;
    if (
      !path ||
      note.id !== path ||
      note.metadata.path !== path ||
      typeof note.pageContent !== "string"
    )
      throw new TypeError("A note document must use its path as id and metadata.path");
    checkAbort(signal);
    await this.call(
      "noteStoreReplace",
      {
        path,
        hash: await noteContentHash(note.pageContent),
        profile: null,
        markdown: note.pageContent,
        vectors: [],
      },
      signal
    );
  }

  async addDocuments(
    documents: DocumentInterface[],
    options: { signal?: AbortSignal } = {}
  ): Promise<string[]> {
    if (documents.length !== 1) throw new TypeError("Exactly one note must be indexed per call");
    const note = documents[0];
    const path = typeof note.metadata.path === "string" ? note.metadata.path : note.id;
    if (
      !path ||
      note.id !== path ||
      note.metadata.path !== path ||
      typeof note.pageContent !== "string"
    )
      throw new TypeError("A note document must use its path as id and metadata.path");
    const hash = await noteContentHash(note.pageContent);
    const existing = (await this.call(
      "noteStoreGet",
      { path },
      options.signal
    )) as NoteStoreEntry | null;
    if (
      existing?.hash === hash &&
      existing.profile === this.profile &&
      existing.chunkCount === existing.vectorCount
    )
      return [path];

    const split = await this.splitter.splitDocuments([
      new Document({ pageContent: note.pageContent, metadata: { path } }),
    ]);
    const chunks = split.map(
      (chunk, ordinal) =>
        new Document({ pageContent: chunk.pageContent, metadata: { path, ordinal } })
    );
    const vectors: number[][] = [];
    const embeddings =
      (this.embeddings as ScopedEmbeddings).withSignal?.(options.signal) ?? this.embeddings;
    for (let offset = 0; offset < chunks.length; offset += 512) {
      checkAbort(options.signal);
      const batch = await embeddings.embedDocuments(
        chunks.slice(offset, offset + 512).map(({ pageContent }) => pageContent)
      );
      if (batch.length !== Math.min(512, chunks.length - offset))
        throw new TypeError("Embedding count did not match chunk count");
      vectors.push(...batch);
    }
    checkAbort(options.signal);
    await this.writeNote(hash, note, vectors, chunks, options.signal);
    return [path];
  }

  async addVectors(
    vectors: number[][],
    documents: DocumentInterface[],
    options: { note?: DocumentInterface; signal?: AbortSignal } = {}
  ): Promise<void> {
    const note = options.note;
    if (!note) throw new TypeError("The source note is required");
    await this.writeNote(
      await noteContentHash(note.pageContent),
      note,
      vectors,
      documents,
      options.signal
    );
  }

  private async writeNote(
    hash: string,
    note: DocumentInterface,
    vectors: number[][],
    documents: DocumentInterface[],
    signal?: AbortSignal
  ): Promise<void> {
    const path = note.metadata.path;
    if (
      typeof path !== "string" ||
      !path ||
      note.id !== path ||
      vectors.length !== documents.length
    )
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
        path,
        hash,
        profile: this.profile,
        markdown: note.pageContent,
        vectors,
      },
      signal
    );
  }

  async delete(params: { ids?: string[] }): Promise<void> {
    if (!params.ids) throw new TypeError("Note paths are required for deletion");
    await this.call("noteStoreDelete", { paths: params.ids });
  }

  async deleteNotes(paths: readonly string[], signal?: AbortSignal): Promise<void> {
    await this.call("noteStoreDelete", { paths }, signal);
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
