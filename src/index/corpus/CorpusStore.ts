import { decodeBinarySegment, encodeSegmentParts, type BinarySegmentRecord } from "./BinarySegment";
import {
  decodeCorpusManifest,
  decodeCorpusPointer,
  encodeCorpusManifest,
  serializeManifest,
  compareCodeUnits,
  type CorpusManifestRoot,
  type CorpusManifestPage,
  type CorpusPointer,
  type ManifestNote,
  type ManifestSegment,
} from "./CorpusManifest";
import { equalBytes } from "./Hash";
import type { IndexStorage } from "../storage";
import {
  emitTramaDiagnostic,
  NOOP_TRAMA_DIAGNOSTICS,
  projectDiagnosticError,
  type TramaDiagnostics,
} from "@/diagnostics/TramaDiagnostics";

export interface CorpusNoteInput {
  path: string;
  contentId: string;
  records: readonly BinarySegmentRecord[];
}
export interface CorpusNoteCatalog extends Omit<ManifestNote, "segments"> {
  readonly path: string;
  readonly segments: readonly ManifestSegment[];
}
export interface CorpusSegmentView {
  readonly id: string;
  readonly checksum: string;
  readonly chunkCount: number;
  readonly segment: Awaited<ReturnType<typeof decodeBinarySegment>>;
}
export interface CorpusSnapshot {
  readonly generationId: string;
  readonly fingerprint: string;
  readonly notes: readonly CorpusNoteCatalog[];
  readonly root: CorpusManifestRoot;
  pin(): CorpusSnapshot;
  release(): Promise<void>;
  getNote(path: string): CorpusNoteCatalog | undefined;
  readSegment(id: string): Promise<CorpusSegmentView>;
  hydrateNote(path: string): Promise<readonly CorpusSegmentView[]>;
  hydrateChunk(path: string, ordinal: number): Promise<BinarySegmentRecord | undefined>;
}

export interface CorpusBuildOptions {
  signal?: AbortSignal;
  onProgress?: (event: { phase: string; completed: number; total?: number; unit: string }) => void;
}
export interface CorpusStoreResult {
  snapshot: CorpusSnapshot;
  generationId: string;
  writes: number;
}
export interface CorpusTransaction {
  readonly snapshot: CorpusSnapshot;
  commit(): Promise<CorpusStoreResult>;
  abort(): Promise<void>;
}
export interface IncrementalChange {
  type: "create" | "modify" | "delete" | "rename" | "empty" | "unchanged";
  path: string;
  previousPath?: string;
  note?: CorpusNoteInput;
}

const pointerPath = "active.json";
const segmentPath = (id: string) => `segments/${id}.seg`;
const rootPath = (generation: string) => `generations/${generation}/root.json`;
const pagePath = (generation: string, index: number) =>
  `generations/${generation}/page-${index}.json`;
const cancelled = () => new Error("Corpus operation cancelled");
function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelled();
}
function yieldMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
function reportProgress(
  callback: CorpusBuildOptions["onProgress"],
  event: { phase: string; completed: number; total?: number; unit: string }
): void {
  try {
    callback?.(event);
  } catch {
    // Progress is observational and must not affect corpus operations.
  }
}
function immutableNote(note: ManifestNote): CorpusNoteCatalog {
  return Object.freeze({
    ...note,
    segments: Object.freeze(note.segments.map((s) => Object.freeze({ ...s }))),
  });
}

class Snapshot implements CorpusSnapshot {
  private pins = 1;
  private cache = new Map<string, Promise<CorpusSegmentView>>();
  constructor(
    private readonly store: CorpusStore,
    readonly root: CorpusManifestRoot,
    readonly notes: readonly CorpusNoteCatalog[],
    private readonly pages: readonly CorpusManifestPage[]
  ) {}
  get pinCount(): number {
    return this.pins;
  }
  get generationId(): string {
    return this.root.generationId;
  }
  get fingerprint(): string {
    return this.root.fingerprint;
  }
  pin(): CorpusSnapshot {
    if (this.pins < 1) throw new Error("Snapshot is released");
    this.pins++;
    return this;
  }
  async release(): Promise<void> {
    if (this.pins > 0) this.pins--;
    if (this.pins === 0) await this.store.onSnapshotReleased(this);
  }
  getNote(path: string): CorpusNoteCatalog | undefined {
    return this.notes.find((n) => n.path === path);
  }
  readSegment(id: string): Promise<CorpusSegmentView> {
    const known = this.notes.some((n) => n.segments.some((s) => s.id === id));
    if (!known) return Promise.reject(new Error("Segment is not reachable from snapshot"));
    let value = this.cache.get(id);
    if (!value) {
      const owner = this.notes.find((n) => n.segments.some((s) => s.id === id));
      const descriptor = owner?.segments.find((s) => s.id === id);
      value = this.store.loadSegment(id, descriptor, owner?.contentId).then((segment) => ({
        id,
        checksum: descriptor?.checksum ?? segment.checksum,
        chunkCount: descriptor?.chunkCount ?? segment.records.length,
        segment,
      }));
      this.cache.set(id, value);
    }
    return value;
  }
  async hydrateNote(path: string): Promise<readonly CorpusSegmentView[]> {
    const note = this.getNote(path);
    if (!note) return [];
    return Promise.all(
      [...note.segments]
        .sort((a, b) => (a.firstOrdinal ?? 0) - (b.firstOrdinal ?? 0))
        .map((s) => this.readSegment(s.id))
    );
  }
  async hydrateChunk(path: string, ordinal: number): Promise<BinarySegmentRecord | undefined> {
    const note = this.getNote(path);
    if (!note || !Number.isSafeInteger(ordinal) || ordinal < 0) return undefined;
    let offset = 0;
    for (const view of await this.hydrateNote(path)) {
      if (ordinal < offset + view.segment.records.length)
        return view.segment.records[ordinal - offset];
      offset += view.segment.records.length;
    }
    return undefined;
  }
}

export class CorpusStore {
  private writing = false;
  private diagnosticsEnabled = false;
  private active?: Snapshot;
  private retired = new Set<Snapshot>();
  private snapshots = new Set<Snapshot>();
  constructor(
    private readonly storage: IndexStorage,
    private readonly diagnostics: TramaDiagnostics = NOOP_TRAMA_DIAGNOSTICS
  ) {}

  enableDiagnostics(): void {
    this.diagnosticsEnabled = true;
  }

  private emit(
    operation: "corpus" | "segment" | "manifest" | "GC",
    stage: "started" | "completed" | "failed" | "cancelled",
    extra: Record<string, unknown> = {}
  ): void {
    if (!this.diagnosticsEnabled) return;
    emitTramaDiagnostic(this.diagnostics, {
      area: "index",
      event: "index_operation",
      operation,
      stage,
      ...extra,
    } as Parameters<TramaDiagnostics["emit"]>[0]);
  }

  private async writeSegment(
    segment: Awaited<ReturnType<typeof encodeSegmentParts>>[number]
  ): Promise<number> {
    const path = segmentPath(segment.segmentId);
    const existing = this.storage.readBinary
      ? await this.storage.readBinary(path).catch(() => null)
      : null;
    if (existing) {
      const checked = await decodeBinarySegment(existing);
      if (
        checked.segmentId !== segment.segmentId ||
        checked.checksum !== segment.checksum ||
        !equalBytes(checked.bytes, segment.bytes)
      )
        throw new Error("Content-addressed segment collision");
      return 0;
    }
    if (!this.storage.writeBinary) throw new Error("Binary storage is unavailable");
    await this.storage.writeBinary(path, segment.bytes);
    return 1;
  }
  private async publish(
    notes: readonly ManifestNote[],
    fingerprint: string,
    options: CorpusBuildOptions = {}
  ): Promise<CorpusStoreResult> {
    check(options.signal);
    const built = await encodeCorpusManifest({
      fingerprint,
      notes: notes.map((n) => ({ ...n, segments: [...n.segments] })),
    });
    let writes = 0;
    for (const page of built.pages) {
      check(options.signal);
      await this.storage.write(
        pagePath(built.root.generationId, page.page),
        serializeManifest(page)
      );
      writes++;
      reportProgress(options.onProgress, {
        phase: "encode-write",
        completed: page.page + 1,
        total: built.pages.length,
        unit: "pages",
      });
    }
    await this.storage.write(rootPath(built.root.generationId), serializeManifest(built.root));
    writes++;
    const previous = this.active?.generationId;
    const pointer: CorpusPointer =
      previous && previous !== built.root.generationId
        ? { schema: 1, current: built.root.generationId, previous }
        : built.pointer;
    const snapshot = await this.loadGeneration(built.root.generationId);
    check(options.signal);
    await this.storage.activate(pointerPath, serializeManifest(pointer), options.signal);
    const old = this.active;
    this.active = snapshot;
    if (old) {
      this.retired.add(old);
      await old.release();
    }
    return { snapshot, generationId: snapshot.generationId, writes };
  }
  /** Stage a complete prepared corpus without changing the active pointer. */
  async stage(
    notes: Iterable<CorpusNoteInput> | AsyncIterable<CorpusNoteInput>,
    fingerprint: string,
    options: CorpusBuildOptions = {}
  ): Promise<CorpusTransaction> {
    if (this.writing) throw new Error("CorpusStore writer is busy");
    this.writing = true;
    let closed = false;
    try {
      await this.storage.prepare?.();
      const descriptors: ManifestNote[] = [];
      let artifacts = 0;
      for await (const note of notes) {
        check(options.signal);
        const segments = note.records.length
          ? await encodeSegmentParts({
              dimensions: note.records[0].vector.length,
              noteContentId: note.contentId,
              records: note.records,
            })
          : [];
        for (const segment of segments) {
          artifacts += await this.writeSegment(segment);
          reportProgress(options.onProgress, {
            phase: "encode-write",
            completed: artifacts,
            unit: "artifacts",
          });
        }
        descriptors.push({
          path: note.path,
          contentId: note.contentId,
          chunkCount: note.records.length,
          segments: segments.map((s) => ({
            id: s.segmentId,
            checksum: s.checksum,
            chunkCount: s.records.length,
            firstOrdinal: s.firstOrdinal,
            byteLength: s.bytes.byteLength,
          })),
        });
      }
      const built = await encodeCorpusManifest({ fingerprint, notes: descriptors });
      for (const page of built.pages)
        await this.storage.write(
          pagePath(built.root.generationId, page.page),
          serializeManifest(page)
        );
      await this.storage.write(rootPath(built.root.generationId), serializeManifest(built.root));
      const snapshot = await this.loadGeneration(built.root.generationId);
      const previous = this.active?.generationId;
      const pointer: CorpusPointer =
        previous && previous !== built.root.generationId
          ? { schema: 1, current: built.root.generationId, previous }
          : built.pointer;
      const finish = () => {
        if (!closed) {
          closed = true;
          this.writing = false;
        }
      };
      return {
        snapshot,
        commit: async () => {
          if (closed) throw new Error("Corpus transaction is closed");
          // Deliberately omit AbortSignal: activation is the commit boundary.
          await this.storage.activate(pointerPath, serializeManifest(pointer));
          const old = this.active;
          this.active = snapshot as Snapshot;
          if (old) {
            this.retired.add(old);
            await old.release();
          }
          finish();
          return { snapshot, generationId: snapshot.generationId, writes: 0 };
        },
        abort: async () => {
          if (!closed) {
            closed = true;
            await snapshot.release();
            this.writing = false;
          }
        },
      };
    } catch (error) {
      this.writing = false;
      throw error;
    }
  }

  /** Stage manifest-only incremental changes against a pinned base snapshot. */
  async stageIncremental(
    base: CorpusSnapshot,
    changes: Iterable<IncrementalChange> | AsyncIterable<IncrementalChange>,
    fingerprint: string,
    options: CorpusBuildOptions = {}
  ): Promise<CorpusTransaction> {
    if (base.fingerprint !== fingerprint) throw new Error("Corpus base fingerprint mismatch");
    if (this.writing) throw new Error("CorpusStore writer is busy");
    this.writing = true;
    base.pin();
    let closed = false;
    const finish = async () => {
      if (!closed) {
        closed = true;
        this.writing = false;
        await base.release();
      }
    };
    try {
      await this.storage.prepare?.();
      const map = new Map(base.notes.map((n) => [n.path, n]));
      let artifacts = 0;
      for await (const change of changes) {
        check(options.signal);
        if (change.type === "delete") map.delete(change.path);
        else if (change.type === "rename" && change.previousPath) {
          const old = map.get(change.previousPath);
          if (old) {
            map.delete(change.previousPath);
            map.set(
              change.path,
              immutableNote({ ...old, path: change.path, segments: [...old.segments] })
            );
          }
        } else if (change.type !== "unchanged") {
          if (!change.note) throw new Error("Changed note is missing data");
          const parts = change.note.records.length
            ? await encodeSegmentParts({
                dimensions: change.note.records[0].vector.length,
                noteContentId: change.note.contentId,
                records: change.note.records,
              })
            : [];
          for (const part of parts) {
            artifacts += await this.writeSegment(part);
            reportProgress(options.onProgress, {
              phase: "encode-write",
              completed: artifacts,
              unit: "artifacts",
            });
          }
          map.set(change.path, {
            path: change.path,
            contentId: change.note.contentId,
            chunkCount: change.note.records.length,
            segments: parts.map((p) => ({
              id: p.segmentId,
              checksum: p.checksum,
              chunkCount: p.records.length,
              firstOrdinal: p.firstOrdinal,
              byteLength: p.bytes.byteLength,
            })),
          });
        }
      }
      const built = await encodeCorpusManifest({
        fingerprint,
        notes: [...map.values()].map((n) => ({ ...n, segments: [...n.segments] })),
      });
      for (const page of built.pages)
        await this.storage.write(
          pagePath(built.root.generationId, page.page),
          serializeManifest(page)
        );
      await this.storage.write(rootPath(built.root.generationId), serializeManifest(built.root));
      const snapshot = await this.loadGeneration(built.root.generationId);
      const previous = this.active?.generationId ?? base.generationId;
      const pointer: CorpusPointer =
        previous && previous !== built.root.generationId
          ? { schema: 1, current: built.root.generationId, previous }
          : built.pointer;
      return {
        snapshot,
        commit: async () => {
          if (closed) throw new Error("Corpus transaction is closed");
          await this.storage.activate(pointerPath, serializeManifest(pointer));
          const old = this.active;
          this.active = snapshot as Snapshot;
          if (old) {
            this.retired.add(old);
            await old.release();
          }
          await finish();
          return { snapshot, generationId: snapshot.generationId, writes: 0 };
        },
        abort: async () => {
          if (!closed) {
            await snapshot.release();
            await finish();
          }
        },
      };
    } catch (error) {
      await finish();
      throw error;
    }
  }
  async build(
    notes: Iterable<CorpusNoteInput> | AsyncIterable<CorpusNoteInput>,
    fingerprint: string,
    options?: CorpusBuildOptions
  ): Promise<CorpusStoreResult> {
    const transaction = await this.stage(notes, fingerprint, options);
    try {
      return await transaction.commit();
    } catch (error) {
      await transaction.abort();
      throw error;
    }
  }
  async incremental(
    changes: Iterable<IncrementalChange> | AsyncIterable<IncrementalChange>,
    fingerprint: string,
    options?: CorpusBuildOptions
  ): Promise<CorpusStoreResult> {
    if (this.writing) throw new Error("CorpusStore writer is busy");
    this.writing = true;
    try {
      await this.storage.prepare?.();
      const current = await this.load();
      const map = new Map(current.notes.map((n) => [n.path, n]));
      let artifacts = 0;
      for await (const change of changes) {
        check(options?.signal);
        if (change.type === "delete") map.delete(change.path);
        else if (change.type === "rename" && change.previousPath) {
          const old = map.get(change.previousPath);
          if (old) {
            map.delete(change.previousPath);
            map.set(
              change.path,
              immutableNote({ ...old, path: change.path, segments: [...old.segments] })
            );
          }
        } else if (change.type !== "unchanged") {
          if (!change.note) throw new Error("Changed note is missing data");
          const parts = change.note.records.length
            ? await encodeSegmentParts({
                dimensions: change.note.records[0].vector.length,
                noteContentId: change.note.contentId,
                records: change.note.records,
              })
            : [];
          for (const p of parts) {
            artifacts += await this.writeSegment(p);
            reportProgress(options?.onProgress, {
              phase: "encode-write",
              completed: artifacts,
              unit: "artifacts",
            });
          }
          map.set(change.path, {
            path: change.path,
            contentId: change.note.contentId,
            chunkCount: change.note.records.length,
            segments: parts.map((p) => ({
              id: p.segmentId,
              checksum: p.checksum,
              chunkCount: p.records.length,
              firstOrdinal: p.firstOrdinal,
              byteLength: p.bytes.byteLength,
            })),
          });
        }
      }
      return await this.publish(
        [...map.values()].map((n) => ({ ...n, segments: [...n.segments] })),
        fingerprint,
        options
      );
    } finally {
      this.writing = false;
    }
  }
  async load(): Promise<CorpusSnapshot> {
    this.emit("corpus", "started");
    for (const pointerFile of [pointerPath, "active.json.bak"]) {
      const raw = await this.storage.read(pointerFile);
      if (!raw) continue;
      try {
        const pointer = decodeCorpusPointer(raw);
        for (const generation of [pointer.current, pointer.previous].filter(Boolean) as string[]) {
          try {
            const snapshot = await this.loadGeneration(generation);
            this.active = snapshot;
            this.emit("corpus", "completed", { generation: snapshot.generationId });
            return snapshot;
          } catch (error) {
            this.emit("manifest", "failed", { error: projectDiagnosticError(error) });
          }
        }
      } catch (error) {
        this.emit("manifest", "failed", { error: projectDiagnosticError(error) });
      }
    }
    this.emit("corpus", "failed", { error: { name: "Error", code: "unavailable" } });
    throw new Error("No valid corpus generation");
  }
  private async loadGeneration(generation: string): Promise<Snapshot> {
    const raw = await this.storage.read(rootPath(generation));
    if (!raw) throw new Error("Missing corpus root");
    // Validate the bounded root before trusting pageCount for storage reads.
    const root = await decodeCorpusManifest(raw);
    if (root.generationId !== generation) throw new Error("Corpus generation cross-link mismatch");
    const pages: string[] = [];
    for (let i = 0; i < root.pageCount; i++) {
      const page = await this.storage.read(pagePath(generation, i));
      if (!page) throw new Error("Missing corpus page");
      pages.push(page);
    }
    await decodeCorpusManifest(raw, pages);
    const parsed = pages.map((p) => JSON.parse(p) as CorpusManifestPage);
    const notes = Object.freeze(
      parsed
        .flatMap((p) => p.notes)
        .sort((a, b) => compareCodeUnits(a.path, b.path))
        .map(immutableNote)
    );
    // A generation is usable only when every artifact it references is intact. This
    // lets startup safely fall back from a corrupt current generation to previous.
    let validatedSegments = 0;
    for (const note of notes)
      for (const descriptor of note.segments) {
        await this.validateSegmentArtifact(descriptor.id, descriptor, note.contentId);
        if ((++validatedSegments & 31) === 0) await yieldMacrotask();
      }
    const snapshot = new Snapshot(this, root, notes, parsed);
    this.snapshots.add(snapshot);
    return snapshot;
  }
  async loadSegment(
    id: string,
    descriptor?: ManifestSegment,
    noteContentId?: string
  ): Promise<Awaited<ReturnType<typeof decodeBinarySegment>>> {
    this.emit("segment", "started");
    try {
      const segment = await this.validateSegmentArtifact(id, descriptor, noteContentId);
      this.emit("segment", "completed");
      return segment;
    } catch (error) {
      this.emit("segment", "failed", { error: projectDiagnosticError(error) });
      throw error;
    }
  }
  private async validateSegmentArtifact(
    id: string,
    descriptor?: ManifestSegment,
    noteContentId?: string
  ): Promise<Awaited<ReturnType<typeof decodeBinarySegment>>> {
    if (!this.storage.readBinary) throw new Error("Binary storage is unavailable");
    let raw: ArrayBuffer;
    try {
      raw = await this.storage.readBinary(segmentPath(id));
    } catch {
      raw = await this.storage.readBinary(`segments/${id}.bin`);
    }
    const segment = await decodeBinarySegment(raw);
    if (
      segment.segmentId !== id ||
      (descriptor &&
        (segment.checksum !== descriptor.checksum ||
          segment.records.length !== descriptor.chunkCount)) ||
      (descriptor?.byteLength !== undefined &&
        segment.bytes.byteLength !== descriptor.byteLength) ||
      (noteContentId !== undefined && segment.noteContentId !== noteContentId.toLowerCase())
    )
      throw new Error("Segment descriptor mismatch");
    return segment;
  }
  async onSnapshotReleased(snapshot: Snapshot): Promise<void> {
    this.retired.delete(snapshot);
    this.snapshots.delete(snapshot);
  }

  /** Best-effort reachability collection. Unknown files are never removed. */
  async collectGarbage(
    onProgress?: CorpusBuildOptions["onProgress"]
  ): Promise<{ removed: number; errors: number }> {
    if (!this.storage.list) return { removed: 0, errors: 0 };
    const reachable = new Set<string>();
    const reachableSegments = new Set<string>();
    let removed = 0;
    let errors = 0;
    const retainedByPointer = new Set<string>();
    for (const pointerFile of [pointerPath, "active.json.bak"]) {
      const pointerRaw = await this.storage.read(pointerFile).catch(() => null);
      if (!pointerRaw) continue;
      try {
        const pointer = decodeCorpusPointer(pointerRaw);
        retainedByPointer.add(pointer.current);
        if (pointer.previous) retainedByPointer.add(pointer.previous);
      } catch {
        return { removed: 0, errors: 1 };
      }
    }

    for (const generation of retainedByPointer) reachable.add(generation);
    for (const snapshot of this.snapshots) {
      if (snapshot.pinCount < 1) continue;
      reachable.add(snapshot.generationId);
      for (const note of snapshot.notes)
        for (const segment of note.segments) reachableSegments.add(segment.id);
    }

    // GC is validate-first: a missing or malformed retained generation makes its
    // complete segment reachability unknowable, so no destructive pass may start.
    for (const generation of retainedByPointer) {
      try {
        const raw = await this.storage.read(rootPath(generation));
        if (!raw) throw new Error("Missing retained corpus root");
        const root = await decodeCorpusManifest(raw);
        if (root.generationId !== generation)
          throw new Error("Retained corpus generation cross-link mismatch");
        const rawPages: string[] = [];
        for (let i = 0; i < root.pageCount; i++) {
          const pageRaw = await this.storage.read(pagePath(generation, i));
          if (!pageRaw) throw new Error("Missing retained corpus page");
          rawPages.push(pageRaw);
        }
        await decodeCorpusManifest(raw, rawPages);
        for (const pageRaw of rawPages) {
          const page = JSON.parse(pageRaw) as CorpusManifestPage;
          for (const note of page.notes) {
            for (const segment of note.segments) {
              await this.validateSegmentArtifact(segment.id, segment, note.contentId);
              reachableSegments.add(segment.id);
            }
          }
        }
      } catch {
        return { removed: 0, errors: errors + 1 };
      }
    }
    // Pinned snapshots may no longer be named by either pointer but remain retained.
    // Validate them too before entering the destructive phase.
    try {
      for (const snapshot of this.snapshots) {
        if (snapshot.pinCount < 1) continue;
        for (const note of snapshot.notes)
          for (const segment of note.segments)
            await this.validateSegmentArtifact(segment.id, segment, note.contentId);
      }
    } catch {
      return { removed: 0, errors: errors + 1 };
    }
    try {
      const listing = await this.storage.list("generations");
      for (const file of listing.files) {
        if (!/^\d+\.json(?:\.tmp)?$/.test(file)) continue;
        try {
          await this.storage.remove(`generations/${file}`);
          removed++;
        } catch {
          errors++;
        }
      }
      for (const folder of listing.folders) {
        if (!/^[0-9a-f]{64}$/.test(folder) || reachable.has(folder)) continue;
        const generation = await this.storage.list(`generations/${folder}`);
        for (const file of generation.files) {
          if (!/^(?:root\.json|page-\d+\.json)(?:\.tmp)?$/.test(file)) continue;
          try {
            await this.storage.remove(`generations/${folder}/${file}`);
            removed++;
            reportProgress(onProgress, {
              phase: "GC",
              completed: removed,
              unit: "artifacts",
            });
          } catch {
            errors++;
          }
        }
        if (
          generation.folders.length === 0 &&
          generation.files.every((file) => /^(?:root\.json|page-\d+\.json)(?:\.tmp)?$/.test(file))
        )
          await this.storage.remove(`generations/${folder}`).catch(() => undefined);
      }
      // Reclaim only recognized content-addressed segment artifacts.
      const segments = await this.storage.list("segments");
      for (const file of segments.files) {
        const match = /^(?<id>[0-9a-f]{64})\.(?:seg|bin)(?:\.tmp)?$/.exec(file);
        if (!match || reachableSegments.has(match.groups!.id)) continue;
        try {
          await this.storage.remove(`segments/${file}`);
          removed++;
        } catch {
          errors++;
        }
      }
    } catch {
      errors++;
    }
    return { removed, errors };
  }
}
