import { index } from "@langchain/core/indexing";
import { Document } from "@langchain/core/documents";
import { checkAbort, isCancelled } from "@/domain/errors";
import { SqliteNoteRecordManager } from "./SqliteNoteRecordManager";
import { SqliteNoteVectorStore } from "./SqliteNoteVectorStore";
import type { ConsoleDebug } from "@/plugin/ConsoleDebug";

const INDEX_BATCH_SIZE = 100;

export interface ManualIndexNote {
  readonly path: string;
  readonly content: string;
  readonly revision?: string;
}

export interface ManualIndexVault {
  getRevision?(path: string): string | undefined;
  listMarkdownPaths(signal: AbortSignal): Promise<readonly string[]>;
  readMarkdown(path: string, signal: AbortSignal): Promise<ManualIndexNote>;
}

export interface ManualIndexArtifacts {
  importAvailable(signal: AbortSignal): Promise<void>;
  publishAvailable(signal: AbortSignal): Promise<void>;
}

export interface ManualIndexResult {
  readonly visited: number;
  readonly deleted: number;
  readonly numAdded: number;
  readonly numUpdated: number;
  readonly numSkipped: number;
  readonly sharing: "complete" | "incomplete" | "cancelled";
}

export class ManualIndex {
  private active?: {
    readonly controller: AbortController;
    readonly promise: Promise<ManualIndexResult>;
  };

  constructor(
    private readonly vault: ManualIndexVault,
    private readonly store: SqliteNoteVectorStore,
    private readonly records: SqliteNoteRecordManager,
    private readonly artifacts?: ManualIndexArtifacts,
    private readonly consoleDebug?: ConsoleDebug
  ) {}

  update(verifyContent = false): Promise<ManualIndexResult> {
    return this.start(false, verifyContent);
  }
  rebuild(): Promise<ManualIndexResult> {
    return this.start(true);
  }
  cancel(): void {
    this.active?.controller.abort();
  }

  private start(rebuild: boolean, verifyContent = false): Promise<ManualIndexResult> {
    if (this.active) return Promise.reject(new Error("An indexing run is already active"));
    const controller = new AbortController();
    const promise = this.run(rebuild, controller.signal, verifyContent).finally(() => {
      if (this.active?.controller === controller) this.active = undefined;
    });
    this.active = { controller, promise };
    return promise;
  }

  private async run(
    rebuild: boolean,
    signal: AbortSignal,
    verifyContent: boolean
  ): Promise<ManualIndexResult> {
    const store = this.store.withSignal(signal);
    let sharing: ManualIndexResult["sharing"] = "complete";
    try {
      await this.artifacts?.importAvailable(signal);
    } catch (error) {
      if (isCancelled(error)) throw error;
      checkAbort(signal);
      sharing = "incomplete";
      this.consoleDebug?.warn("Embedding cache import failed; continuing local indexing", error);
    }
    if (rebuild) await store.reset(signal);
    const paths = await this.vault.listMarkdownPaths(signal);
    const records = this.records.forRun(await this.records.getTime(signal), signal);
    let numAdded = 0;
    let numUpdated = 0;
    let numSkipped = 0;

    for (let offset = 0; offset < paths.length; offset += INDEX_BATCH_SIZE) {
      const batch = paths.slice(offset, offset + INDEX_BATCH_SIZE);
      const sources =
        !verifyContent && this.vault.getRevision
          ? batch.flatMap((path) => {
              const revision = this.vault.getRevision!(path);
              return revision === undefined ? [] : [{ path, revision }];
            })
          : [];
      const unchanged = new Set(sources.length ? await store.checkSources(sources) : []);
      numSkipped += unchanged.size;
      const remembered: { path: string; revision: string }[] = [];
      const docs: Document[] = [];
      for (const path of batch) {
        if (unchanged.has(path)) continue;
        checkAbort(signal);
        const note = await this.vault.readMarkdown(path, signal);
        checkAbort(signal);
        if (note.path !== path) throw new Error("Vault returned a note for a different path");
        if (note.revision !== undefined) remembered.push({ path, revision: note.revision });
        docs.push(
          new Document({
            pageContent: note.content,
            metadata: { path, embeddingProfile: this.store.embeddingProfile },
          })
        );
      }
      const result = await index({
        docsSource: docs,
        recordManager: records,
        vectorStore: store,
        options: { batchSize: INDEX_BATCH_SIZE, sourceIdKey: "path" },
      });
      if (remembered.length) await store.rememberSources(remembered);
      numAdded += result.numAdded;
      numUpdated += result.numUpdated;
      numSkipped += result.numSkipped;
    }

    checkAbort(signal);
    const cleanup = await index({
      docsSource: [],
      recordManager: records,
      vectorStore: store,
      options: { cleanup: "full", cleanupBatchSize: 1000, sourceIdKey: "path" },
    });
    const finishPublish = this.artifacts
      ? this.consoleDebug?.start("Embedding cache publication")
      : undefined;
    try {
      await this.artifacts?.publishAvailable(signal);
      finishPublish?.("completed");
    } catch (error) {
      sharing = signal.aborted ? "cancelled" : "incomplete";
      finishPublish?.(
        sharing,
        undefined,
        sharing === "cancelled" ? undefined : error,
        sharing === "cancelled" ? "info" : "warn"
      );
    }
    return {
      visited: paths.length,
      deleted: cleanup.numDeleted,
      numAdded,
      numUpdated,
      numSkipped,
      sharing,
    };
  }
}
