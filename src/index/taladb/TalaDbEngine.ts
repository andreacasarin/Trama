import { openDB, type TalaDB } from "taladb";
import { chunkMarkdown } from "@/index/chunking";
import { sha256Hex } from "@/index/corpus/Hash";
import type {
  TalaCheckpoint,
  TalaChunkInput,
  TalaHydratedChunk,
  TalaNoteInput,
  TalaSchemaInfo,
  TalaSearchHit,
  TalaState,
  TalaStorageInfo,
} from "./protocol";
import { createTalaNamespace, type TalaNamespace } from "./namespace";

export interface TalaDurability {
  writeState?(state: TalaState): Promise<void>;
  writeNote?(note: TalaNoteInput): Promise<void>;
  deleteNote?(path: string): Promise<void>;
  flush?(): Promise<void>;
}

export interface TalaDbEngineOptions {
  /** Production defaults to TalaDB. `memory` is only for repository-contained tests. */
  readonly backend?: "native" | "memory";
  readonly dimensions?: number;
  readonly fingerprint?: string;
  readonly namespace?: TalaNamespace;
  readonly durability?: TalaDurability;
  /** Optional database name; the browser binding uses its local Worker/OPFS or IDB fallback. */
  readonly native?: { readonly databaseName?: string };
  /** Persisted marker supplied by the lifecycle wrapper before opening the DB. */
  readonly initialState?: TalaState;
}

type NoteRow = TalaNoteInput & {
  readonly contentId: string;
  readonly chunks: readonly ChunkRow[];
  readonly chunkCount?: number;
};
type ChunkRow = TalaChunkInput & {
  readonly rowId: string;
  readonly canonicalId: string;
  readonly path: string;
  readonly contentId: string;
};
type NativeDocument = {
  readonly _id?: string;
  readonly path: string;
  readonly contentId?: string;
  readonly revision?: string | null;
  readonly chunkCount?: number;
  readonly rowId?: string;
  readonly canonicalId?: string;
  readonly ordinal?: number;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly body?: string;
  readonly filename?: string;
  readonly pathText?: string;
  readonly embedding?: number[];
  readonly key?: string;
  readonly status?: TalaState["status"];
  readonly syncNeeded?: boolean;
  readonly operation?: TalaState["operation"];
  readonly revisionNumber?: number;
  readonly dimensions?: number;
  readonly fingerprint?: string;
};
type NativeStateDocument = {
  readonly _id?: string;
  readonly key: string;
  readonly status: TalaState["status"];
  readonly syncNeeded: boolean;
  readonly operation: TalaState["operation"];
  readonly revisionNumber: number;
  readonly fingerprint: string;
  readonly dimensions: number;
};

function cancelled(): Error {
  return new Error("Tala operation cancelled");
}
function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelled();
}
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function compareHit(a: TalaSearchHit, b: TalaSearchHit): number {
  if (a.score !== b.score) return b.score - a.score;
  return compareText(a.path, b.path) || a.ordinal - b.ordinal || compareText(a.rowId, b.rowId);
}
function vector(value: readonly number[], dimensions: number): Float32Array {
  if (value.length !== dimensions || value.some((x) => !Number.isFinite(x)))
    throw new Error("Vector dimensions mismatch");
  let norm = 0;
  for (const x of value) norm += x * x;
  if (norm === 0) throw new Error("Zero vector is not searchable");
  const result = new Float32Array(dimensions);
  const scale = 1 / Math.sqrt(norm);
  for (let i = 0; i < dimensions; i++) result[i] = value[i] * scale;
  return result;
}
function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let score = 0;
  for (let i = 0; i < a.length; i++) score += a[i] * b[i];
  return Math.max(-1, Math.min(1, score));
}
function tokens(value: string): string[] {
  return (
    value
      .toLocaleLowerCase()
      .normalize("NFKC")
      .match(/[\p{L}\p{N}_-]+/gu) ?? []
  );
}
function contentFingerprint(path: string, content: string, fingerprint: string): Promise<string> {
  return sha256Hex(`${fingerprint}\u0000${path}\u0000${content}`);
}
function rowIdentity(path: string, contentId: string, ordinal: number): Promise<string> {
  return sha256Hex(`${path}\u0000${contentId}\u0000${ordinal}`);
}

/** Trama-owned mutable Tala index. The package boundary is private to this module. */
export class TalaDbEngine {
  readonly namespace: TalaNamespace;
  private readonly dimensions: number;
  private readonly fingerprint: string;
  private readonly durability?: TalaDurability;
  private readonly nativeName?: string;
  private readonly backend: "native" | "memory";
  private readonly notesByPath = new Map<string, NoteRow>();
  private readonly chunksByRow = new Map<string, ChunkRow>();
  private stateValue: TalaState;
  private closed = false;
  private quiesced = false;
  private nativeDb?: TalaDB;
  private nativeInitialized = false;
  private opening?: Promise<void>;
  private closing?: Promise<void>;

  constructor(options: TalaDbEngineOptions = {}) {
    this.namespace = options.namespace ?? createTalaNamespace();
    this.backend = options.backend ?? "native";
    this.dimensions = options.dimensions ?? 768;
    if (!Number.isSafeInteger(this.dimensions) || this.dimensions < 1)
      throw new Error("Invalid Tala dimensions");
    this.fingerprint = options.fingerprint ?? "default";
    this.durability = options.durability;
    this.stateValue = options.initialState ?? this.makeState("ready", false, "idle", 0);
    this.nativeName = options.native?.databaseName ?? this.namespace.database;
  }

  private makeState(
    status: TalaState["status"],
    syncNeeded: boolean,
    operation: TalaState["operation"],
    revision: number
  ): TalaState {
    return Object.freeze({
      status,
      syncNeeded,
      operation,
      revision,
      fingerprint: this.fingerprint,
      dimensions: this.dimensions,
    });
  }
  private async persistState(): Promise<void> {
    if (this.nativeDb) {
      const state = this.nativeDb.collection<NativeStateDocument>("state");
      const document = {
        key: "state",
        status: this.stateValue.status,
        syncNeeded: this.stateValue.syncNeeded,
        operation: this.stateValue.operation,
        revisionNumber: this.stateValue.revision,
        fingerprint: this.stateValue.fingerprint,
        dimensions: this.stateValue.dimensions,
      };
      if (await state.findOne({ key: "state" }))
        await state.updateOne({ key: "state" }, { $set: document });
      else await state.insert(document);
      await this.nativeDb.flush?.();
    }
    await this.durability?.writeState?.(this.stateValue);
    await this.durability?.flush?.();
  }
  private async ensureBackend(): Promise<void> {
    this.ensureOpen();
    if (this.backend === "native" && !this.nativeDb) await this.openNative(this.nativeName);
    if (this.nativeDb && !this.nativeInitialized) await this.initializeNativeSchema();
  }
  private ensureOpen(): void {
    if (this.closed) throw new Error("Tala database is closed");
  }
  private async begin(operation: "rebuilding" | "syncing"): Promise<void> {
    this.ensureOpen();
    if (this.quiesced) throw new Error("Tala database is quiesced");
    this.quiesced = false;
    this.stateValue = this.makeState("dirty", true, operation, this.stateValue.revision + 1);
    await this.persistState();
  }
  private async finish(): Promise<TalaState> {
    await this.validate();
    this.stateValue = this.makeState("ready", false, "idle", this.stateValue.revision + 1);
    await this.persistState();
    return this.stateValue;
  }
  /** Complete one explicit batch after all its writes have been applied. */
  async commitReady(): Promise<TalaState> {
    this.ensureOpen();
    if (this.stateValue.status === "ready" && !this.stateValue.syncNeeded) return this.stateValue;
    return this.finish();
  }
  /** Explicit package open hook; state reads are local and network silent. */
  async open(): Promise<TalaState> {
    this.ensureOpen();
    await this.ensureBackend();
    await this.loadNativeRows();
    return this.stateValue;
  }
  async openNative(databaseName = this.namespace.database): Promise<void> {
    this.ensureOpen();
    if (this.nativeDb) return;
    if (this.opening) return this.opening;
    // TalaDB's public browser openDB owns the dedicated Worker and its
    // Web-Lock/BroadcastChannel writer isolation.  Keep that lifecycle in the
    // dependency; Trama only wraps its neutral collection API.
    this.opening = openDB(databaseName, { durability: { flush_every_write: true } })
      .then((db) => {
        this.nativeDb = db;
      })
      .finally(() => {
        this.opening = undefined;
      });
    return this.opening;
  }
  private async initializeNativeSchema(): Promise<void> {
    if (!this.nativeDb || this.nativeInitialized) return;
    const notes = this.nativeDb.collection("notes");
    const chunks = this.nativeDb.collection("chunks");
    const noteIndexes = await notes.listIndexes();
    const chunkIndexes = await chunks.listIndexes();
    if (!noteIndexes.btree.includes("path")) await notes.createIndex("path");
    if (!noteIndexes.btree.includes("contentId")) await notes.createIndex("contentId");
    if (!chunkIndexes.btree.includes("rowId")) await chunks.createIndex("rowId");
    if (!chunkIndexes.btree.includes("path")) await chunks.createIndex("path");
    if (!chunkIndexes.btree.includes("ordinal")) await chunks.createIndex("ordinal");
    if (!chunkIndexes.fts.includes("body")) await chunks.createFtsIndex("body");
    if (!chunkIndexes.fts.includes("filename")) await chunks.createFtsIndex("filename");
    if (!chunkIndexes.fts.includes("pathText")) await chunks.createFtsIndex("pathText");
    if (!chunkIndexes.vector.includes("embedding"))
      await chunks.createVectorIndex("embedding", {
        dimensions: this.dimensions,
        metric: "cosine",
        indexType: "flat",
      });
    this.nativeInitialized = true;
  }
  private async loadNativeRows(): Promise<void> {
    if (!this.nativeDb || this.notesByPath.size) return;
    const notes = await this.nativeDb.collection<NativeDocument>("notes").find();
    const persisted = await this.nativeDb
      .collection<NativeStateDocument>("state")
      .findOne({ key: "state" });
    if (
      persisted &&
      persisted.fingerprint === this.fingerprint &&
      persisted.dimensions === this.dimensions &&
      persisted.status &&
      persisted.operation &&
      typeof persisted.revisionNumber === "number"
    ) {
      this.stateValue = this.makeState(
        persisted.status,
        Boolean(persisted.syncNeeded),
        persisted.operation,
        persisted.revisionNumber
      );
    }
    for (const note of notes) {
      const contentId = note.contentId ?? "";
      this.putNote({
        path: note.path,
        content: "",
        contentId,
        revision: note.revision ?? undefined,
        chunkCount: note.chunkCount,
        chunks: [],
      });
    }
  }
  private async nativeReplaceNote(note: NoteRow): Promise<void> {
    if (!this.nativeDb) return;
    const notes = this.nativeDb.collection<NativeDocument>("notes");
    const chunks = this.nativeDb.collection<NativeDocument>("chunks");
    await chunks.deleteMany({ path: note.path });
    await notes.deleteMany({ path: note.path });
    await notes.insert({
      path: note.path,
      contentId: note.contentId,
      revision: note.revision ?? null,
      chunkCount: note.chunks.length,
    });
    for (const chunk of note.chunks) {
      await chunks.insert({
        rowId: chunk.rowId,
        canonicalId: chunk.canonicalId,
        path: chunk.path,
        ordinal: chunk.ordinal,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        body: chunk.text,
        filename: chunk.path.split("/").at(-1) ?? chunk.path,
        pathText: chunk.path,
        embedding: [...chunk.vector],
      });
    }
    await this.nativeDb.flush?.();
  }
  private async nativeDeleteNote(path: string): Promise<void> {
    if (!this.nativeDb) return;
    await this.nativeDb.collection("chunks").deleteMany({ path });
    await this.nativeDb.collection("notes").deleteMany({ path });
    await this.nativeDb.flush?.();
  }
  state(): TalaState {
    this.ensureOpen();
    return this.stateValue;
  }
  /** Marks a planned mutation before callers perform read/embed work. */
  async markDirty(operation: "rebuilding" | "syncing"): Promise<TalaState> {
    await this.ensureBackend();
    await this.begin(operation);
    return this.stateValue;
  }
  storageInfo(): TalaStorageInfo {
    return {
      storage: this.backend === "native" ? "opfs" : this.durability ? "injected" : "memory",
      durableWrites: true,
      owner: true,
    };
  }
  schema(): TalaSchemaInfo {
    return {
      version: 1,
      dimensions: this.dimensions,
      collections: ["state", "notes", "chunks"],
      indexes: {
        notes: ["path", "contentId"],
        chunks: [
          "rowId",
          "canonicalId",
          "path",
          "ordinal",
          "body",
          "filename",
          "pathText",
          "embedding",
        ],
      },
    };
  }

  private async normalizeNote(input: TalaNoteInput, signal?: AbortSignal): Promise<NoteRow> {
    check(signal);
    if (!input.path || input.path.startsWith("/") || input.path.includes("\\"))
      throw new Error("Invalid note path");
    const contentId =
      input.contentId ?? (await contentFingerprint(input.path, input.content, this.fingerprint));
    const source: readonly TalaChunkInput[] =
      input.chunks ??
      chunkMarkdown(input.content).map((chunk, ordinal) => ({
        ...chunk,
        ordinal,
        // A note without embeddings is not indexable; retaining the explicit failure
        // keeps accidental query-time embedding work out of this layer.
        vector: [],
      }));
    const chunks: ChunkRow[] = [];
    for (const item of source) {
      check(signal);
      if (!Number.isSafeInteger(item.ordinal) || item.ordinal < 0)
        throw new Error("Invalid chunk ordinal");
      const values = vector(item.vector, this.dimensions);
      const rowId = item.rowId ?? (await rowIdentity(input.path, contentId, item.ordinal));
      const canonicalId = item.canonicalId ?? `${contentId}:${item.ordinal}`;
      chunks.push({
        ...item,
        vector: [...values],
        rowId,
        canonicalId,
        path: input.path,
        contentId,
      });
    }
    chunks.sort((a, b) => a.ordinal - b.ordinal || compareText(a.rowId, b.rowId));
    return { ...input, contentId, chunks };
  }

  async rebuild(inputs: readonly TalaNoteInput[], signal?: AbortSignal): Promise<TalaState> {
    await this.ensureBackend();
    if (this.stateValue.status !== "dirty" || this.stateValue.operation !== "rebuilding")
      await this.begin("rebuilding");
    this.notesByPath.clear();
    this.chunksByRow.clear();
    if (this.nativeDb) {
      await this.nativeDb.collection("notes").deleteMany({});
      await this.nativeDb.collection("chunks").deleteMany({});
    }
    try {
      const sorted = [...inputs].sort((a, b) => compareText(a.path, b.path));
      for (const input of sorted) {
        const note = await this.normalizeNote(input, signal);
        this.putNote(note);
        await this.nativeReplaceNote(note);
        await this.durability?.writeNote?.(note);
        await this.persistState();
      }
      return await this.finish();
    } catch (error) {
      this.stateValue = this.makeState("dirty", true, "idle", this.stateValue.revision + 1);
      await this.persistState();
      throw error;
    }
  }

  async reconcile(
    input: TalaNoteInput | null,
    path = input?.path ?? "",
    signal?: AbortSignal
  ): Promise<TalaState> {
    this.ensureOpen();
    await this.ensureBackend();
    try {
      if (!path) throw new Error("Missing note path");
      const previous = this.notesByPath.get(path);
      if (input === null) {
        if (!previous) return this.stateValue;
        await this.beginIfNeeded("syncing");
        this.removeNote(path);
        await this.nativeDeleteNote(path);
        await this.durability?.deleteNote?.(path);
      } else {
        const note = await this.normalizeNote(input, signal);
        if (
          previous &&
          previous.contentId === note.contentId &&
          previous.chunks.length === note.chunks.length
        )
          return this.stateValue;
        await this.beginIfNeeded("syncing");
        this.putNote(note);
        await this.nativeReplaceNote(note);
        await this.durability?.writeNote?.(note);
      }
      await this.persistState();
      // A single reconcile is a write primitive.  The lifecycle owner commits
      // ready once after a batch, so observers cannot see false readiness
      // between note mutations.
      return this.stateValue;
    } catch (error) {
      this.stateValue = this.makeState("dirty", true, "idle", this.stateValue.revision + 1);
      await this.persistState();
      throw error;
    }
  }
  private async beginIfNeeded(operation: "rebuilding" | "syncing"): Promise<void> {
    if (this.stateValue.status === "dirty" && this.stateValue.operation === operation) return;
    await this.begin(operation);
  }
  async delete(path: string): Promise<TalaState> {
    return this.reconcile(null, path);
  }
  private putNote(note: NoteRow): void {
    this.removeNote(note.path);
    this.notesByPath.set(note.path, note);
    for (const chunk of note.chunks) this.chunksByRow.set(chunk.rowId, chunk);
  }
  private removeNote(path: string): void {
    const old = this.notesByPath.get(path);
    if (!old) return;
    this.notesByPath.delete(path);
    for (const chunk of old.chunks) this.chunksByRow.delete(chunk.rowId);
  }

  async validate(): Promise<TalaState> {
    this.ensureOpen();
    await this.ensureBackend();
    for (const [rowId, chunk] of this.chunksByRow) {
      if (
        rowId !== chunk.rowId ||
        chunk.path.length === 0 ||
        chunk.vector.length !== this.dimensions
      )
        throw new Error("Invalid Tala chunk row");
    }
    return this.stateValue;
  }
  async search(
    query: readonly number[],
    limit = 20,
    excludePath?: string
  ): Promise<readonly TalaSearchHit[]> {
    await this.ensureBackend();
    const q = vector(query, this.dimensions);
    const max = Math.max(0, Math.min(1000, Math.floor(limit)));
    if (this.nativeDb) {
      const filter = excludePath ? { path: { $ne: excludePath } } : undefined;
      const chunks = this.nativeDb.collection<NativeDocument>("chunks");
      const total = await chunks.count(filter);
      if (!total || !max) return [];
      let requested = Math.min(total, Math.max(max + 1, 2));
      let nativeHits = await chunks.findNearest("embedding", [...q], requested, filter);
      const boundary = nativeHits[max - 1]?.score;
      // Tala's native ordering is intentionally unspecified for equal scores.
      // Expand while the response ends at the kth score so every kth-tied row
      // reaches Trama's deterministic path/ordinal/row-id comparator.
      while (
        boundary !== undefined &&
        nativeHits.length === requested &&
        nativeHits.at(-1)?.score === boundary &&
        requested < total
      ) {
        requested = Math.min(total, Math.max(requested + 1, requested * 2));
        nativeHits = await chunks.findNearest("embedding", [...q], requested, filter);
      }
      return nativeHits
        .map((hit) => ({
          rowId: hit.document.rowId ?? "",
          canonicalId: hit.document.canonicalId ?? "",
          path: hit.document.path,
          ordinal: hit.document.ordinal ?? 0,
          score: hit.score,
        }))
        .filter((hit) => hit.rowId)
        .sort(compareHit)
        .slice(0, max);
    }
    return [...this.chunksByRow.values()]
      .filter((row) => row.path !== excludePath)
      .map((row) => ({
        rowId: row.rowId,
        canonicalId: row.canonicalId,
        path: row.path,
        ordinal: row.ordinal,
        score: dot(q, row.vector),
      }))
      .sort(compareHit)
      .slice(0, max);
  }
  async lexicalSearch(
    query: string,
    limit = 20,
    excludePath?: string
  ): Promise<readonly TalaSearchHit[]> {
    await this.ensureBackend();
    const terms = tokens(query);
    const max = Math.max(0, Math.min(1000, Math.floor(limit)));
    if (!terms.length) return [];
    if (this.nativeDb) {
      const filter = excludePath ? { path: { $ne: excludePath } } : undefined;
      const chunks = this.nativeDb.collection<NativeDocument>("chunks");
      // TalaDB exposes independent FTS calls, not a weighted multi-field
      // query. Retrieve the complete matching candidate set per channel before
      // applying Trama's explicit 3/2/1 deterministic channel weights; using
      // only each channel's top-k is not sufficient because a lower-ranked hit
      // in one channel can win after combining another channel.
      const total = await chunks.count(filter);
      if (!total || !max) return [];
      const all = new Map<string, TalaSearchHit>();
      for (const field of ["body", "filename", "pathText"] as const) {
        const weight = field === "filename" ? 3 : field === "pathText" ? 2 : 1;
        const hits = await chunks.searchText(field, query, total, filter);
        for (const hit of hits) {
          const row = {
            rowId: hit.document.rowId ?? "",
            canonicalId: hit.document.canonicalId ?? "",
            path: hit.document.path,
            ordinal: hit.document.ordinal ?? 0,
            score: hit.score,
          };
          row.score *= weight;
          const previous = all.get(row.rowId);
          if (previous) all.set(row.rowId, { ...previous, score: previous.score + row.score });
          else all.set(row.rowId, row);
        }
      }
      return [...all.values()]
        .filter((hit) => hit.rowId)
        .sort(compareHit)
        .slice(0, max);
    }
    const docs = [...this.chunksByRow.values()].filter((row) => row.path !== excludePath);
    const fields = (row: ChunkRow): readonly [string[], string[], string[]] => [
      tokens(row.text),
      tokens(row.path.split("/").at(-1) ?? row.path),
      tokens(row.path),
    ];
    const documentFrequency = new Map<string, number>();
    for (const term of terms) {
      const seen = new Set<string>();
      for (const row of docs)
        if (fields(row).some((field) => field.includes(term))) seen.add(row.rowId);
      documentFrequency.set(term, seen.size);
    }
    const n = docs.length || 1;
    return docs
      .map((row) => {
        const values = fields(row);
        let score = 0;
        for (const term of terms) {
          const idf = Math.log(1 + n / (1 + (documentFrequency.get(term) ?? 0)));
          for (const [index, field] of values.entries()) {
            const frequency = field.filter((token) => token === term).length;
            if (frequency) {
              const channelWeight = index === 1 ? 3 : index === 2 ? 2 : 1;
              score += channelWeight * (1 + Math.log(1 + frequency)) * idf;
            }
          }
        }
        return {
          rowId: row.rowId,
          canonicalId: row.canonicalId,
          path: row.path,
          ordinal: row.ordinal,
          score,
        };
      })
      .filter((row) => row.score > 0)
      .sort(compareHit)
      .slice(0, max);
  }
  async hydrate(rowIds: readonly string[]): Promise<readonly TalaHydratedChunk[]> {
    await this.ensureBackend();
    const result: TalaHydratedChunk[] = [];
    for (const id of rowIds) {
      let row = this.chunksByRow.get(id);
      if (!row && this.nativeDb) {
        const document = await this.nativeDb
          .collection<NativeDocument>("chunks")
          .findOne({ rowId: id });
        if (document?.rowId && document.embedding)
          row = {
            rowId: document.rowId,
            canonicalId: document.canonicalId ?? "",
            path: document.path,
            contentId: "",
            ordinal: document.ordinal ?? 0,
            startLine: document.startLine ?? 1,
            endLine: document.endLine ?? 1,
            text: document.body ?? "",
            vector: document.embedding,
          };
      }
      if (row)
        result.push({
          rowId: row.rowId,
          canonicalId: row.canonicalId,
          path: row.path,
          ordinal: row.ordinal,
          score: 0,
          startLine: row.startLine,
          endLine: row.endLine,
          text: row.text,
          vector: [...row.vector],
        });
    }
    return result;
  }
  async noteChunks(path: string): Promise<readonly TalaChunkInput[]> {
    await this.ensureBackend();
    if (this.nativeDb) {
      const rows = await this.nativeDb.collection<NativeDocument>("chunks").find({ path });
      return rows
        .filter((row): row is NativeDocument & { rowId: string; embedding: number[] } =>
          Boolean(row.rowId && row.embedding)
        )
        .map((row) => ({
          ordinal: row.ordinal ?? 0,
          startLine: row.startLine ?? 1,
          endLine: row.endLine ?? 1,
          text: row.body ?? "",
          vector: row.embedding,
          rowId: row.rowId,
          canonicalId: row.canonicalId,
        }))
        .sort((a, b) => a.ordinal - b.ordinal);
    }
    return [...(this.notesByPath.get(path)?.chunks ?? [])].map((chunk) => ({
      ordinal: chunk.ordinal,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      text: chunk.text,
      vector: [...chunk.vector],
      rowId: chunk.rowId,
      canonicalId: chunk.canonicalId,
    }));
  }
  noteCatalog(): readonly { path: string; contentId: string; chunkCount: number }[] {
    return [...this.notesByPath.values()].map((note) => ({
      path: note.path,
      contentId: note.contentId,
      chunkCount: note.chunkCount ?? note.chunks.length,
    }));
  }
  async related(
    path: string,
    query: readonly number[],
    limit = 20
  ): Promise<readonly TalaSearchHit[]> {
    return this.search(query, limit, path);
  }

  checkpoint(): TalaCheckpoint {
    this.ensureOpen();
    const notes = [...this.notesByPath.values()]
      .sort((a, b) => compareText(a.path, b.path))
      .map((note) => ({
        ...note,
        chunks: note.chunks.map((chunk) => ({
          ordinal: chunk.ordinal,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          text: chunk.text,
          vector: [...chunk.vector],
          rowId: chunk.rowId,
          canonicalId: chunk.canonicalId,
        })),
      }));
    return { version: 1, namespace: this.namespace.root, state: this.stateValue, notes };
  }
  async exportCheckpoint(): Promise<TalaCheckpoint> {
    this.ensureOpen();
    await this.ensureBackend();
    const notes: TalaNoteInput[] = [];
    for (const note of this.notesByPath.values()) {
      notes.push({
        path: note.path,
        content: note.content,
        contentId: note.contentId,
        revision: note.revision,
        chunks: await this.noteChunks(note.path),
      });
    }
    notes.sort((a, b) => compareText(a.path, b.path));
    return { version: 1, namespace: this.namespace.root, state: this.stateValue, notes };
  }
  async importCheckpoint(checkpoint: TalaCheckpoint, signal?: AbortSignal): Promise<TalaState> {
    this.ensureOpen();
    await this.ensureBackend();
    if (checkpoint.version !== 1 || checkpoint.namespace !== this.namespace.root)
      throw new Error("Incompatible Tala checkpoint");
    await this.beginIfNeeded("syncing");
    const normalizedNotes: NoteRow[] = [];
    try {
      for (const note of checkpoint.notes) {
        check(signal);
        const normalized = await this.normalizeNote(note, signal);
        normalizedNotes.push(normalized);
      }
      // Validate every byte and vector before replacing the current object.
      // A corrupt checkpoint therefore leaves the last good rows searchable,
      // albeit explicitly dirty for the caller to reconcile.
      this.notesByPath.clear();
      this.chunksByRow.clear();
      if (this.nativeDb) {
        await this.nativeDb.collection("notes").deleteMany({});
        await this.nativeDb.collection("chunks").deleteMany({});
      }
      for (const note of normalizedNotes) {
        this.putNote(note);
        await this.nativeReplaceNote(note);
        await this.durability?.writeNote?.(note);
      }
      return await this.finish();
    } catch (error) {
      this.stateValue = this.makeState("dirty", true, "idle", this.stateValue.revision + 1);
      await this.persistState();
      throw error;
    }
  }
  async quiesce(): Promise<{ readonly quiesced: true }> {
    this.ensureOpen();
    this.quiesced = true;
    return { quiesced: true };
  }
  async close(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.closed) return;
    this.closing = (async () => {
      this.closed = true;
      await this.opening?.catch(() => undefined);
      await this.nativeDb?.close();
      this.nativeDb = undefined;
      // Release the in-process row/vector cache as part of close.  Native
      // restart callers may retain the old engine until their manager is
      // collected; keeping 768d vectors here doubles the peak for large DBs.
      this.notesByPath.clear();
      this.chunksByRow.clear();
    })();
    try {
      await this.closing;
    } finally {
      this.closing = undefined;
    }
  }
}

export { rowIdentity as deriveTalaRowId, contentFingerprint as deriveTalaContentId };
