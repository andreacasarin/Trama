import { index } from "@langchain/core/indexing";
import { Document } from "@langchain/core/documents";
import { StructuredError } from "@/domain/errors";
import { SqliteNoteRecordManager } from "./SqliteNoteRecordManager";
import { SqliteNoteVectorStore } from "./SqliteNoteVectorStore";

const INDEX_BATCH_SIZE = 100;

export interface ManualIndexNote {
  readonly path: string;
  readonly content: string;
}

export interface ManualIndexVault {
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
    private readonly artifacts?: ManualIndexArtifacts
  ) {}

  update(): Promise<ManualIndexResult> {
    return this.start(false);
  }
  rebuild(): Promise<ManualIndexResult> {
    return this.start(true);
  }
  cancel(): void {
    this.active?.controller.abort();
  }

  private start(rebuild: boolean): Promise<ManualIndexResult> {
    if (this.active) return Promise.reject(new Error("An indexing run is already active"));
    const controller = new AbortController();
    const promise = this.run(rebuild, controller.signal).finally(() => {
      if (this.active?.controller === controller) this.active = undefined;
    });
    this.active = { controller, promise };
    return promise;
  }

  private async run(rebuild: boolean, signal: AbortSignal): Promise<ManualIndexResult> {
    const store = this.store.withSignal(signal);
    await this.artifacts?.importAvailable(signal);
    if (rebuild) await store.reset(signal);
    const paths = await this.vault.listMarkdownPaths(signal);
    const records = this.records.forRun(await this.records.getTime(signal), signal);
    let numAdded = 0;
    let numUpdated = 0;
    let numSkipped = 0;

    for (let offset = 0; offset < paths.length; offset += INDEX_BATCH_SIZE) {
      const docs: Document[] = [];
      for (const path of paths.slice(offset, offset + INDEX_BATCH_SIZE)) {
        checkAbort(signal);
        const note = await this.vault.readMarkdown(path, signal);
        checkAbort(signal);
        if (note.path !== path) throw new Error("Vault returned a note for a different path");
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
    let sharing: ManualIndexResult["sharing"] = "complete";
    try {
      await this.artifacts?.publishAvailable(signal);
    } catch {
      sharing = signal.aborted ? "cancelled" : "incomplete";
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

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new StructuredError("cancelled", "Indexing cancelled.", false);
}
