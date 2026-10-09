import { Document } from "@langchain/core/documents";
import { EmbeddingProviderError } from "@/model/LocalModels";
import { noteContentHash, SqliteNoteVectorStore } from "./SqliteNoteVectorStore";

export interface ManualIndexNote {
  readonly path: string;
  readonly content: string;
}

export interface ManualIndexVault {
  listMarkdownPaths(signal: AbortSignal): Promise<readonly string[]>;
  readMarkdown(path: string, signal: AbortSignal): Promise<ManualIndexNote>;
  isMarkdownAvailable(path: string, signal: AbortSignal): Promise<boolean>;
}

export interface ManualIndexResult {
  readonly visited: number;
  readonly deleted: number;
  readonly lexicalOnly: boolean;
}

export class ManualIndex {
  private active?: {
    readonly controller: AbortController;
    readonly promise: Promise<ManualIndexResult>;
  };

  constructor(
    private readonly vault: ManualIndexVault,
    private readonly store: SqliteNoteVectorStore
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
    if (rebuild) await this.store.reset(signal);
    const listed = await this.vault.listMarkdownPaths(signal);
    const livePaths = new Set(listed);
    let lexicalOnly = false;
    for (const path of listed) {
      checkAbort(signal);
      if (!(await this.vault.isMarkdownAvailable(path, signal))) {
        livePaths.delete(path);
        continue;
      }
      if (lexicalOnly) {
        await this.indexLatestLexically(path, livePaths, signal);
      } else {
        try {
          await this.indexLatest(path, livePaths, signal);
        } catch (error) {
          if (!(error instanceof EmbeddingProviderError) || signal.aborted) throw error;
          lexicalOnly = true;
          await this.indexLatestLexically(path, livePaths, signal);
        }
      }
    }

    let deleted = 0;
    for await (const page of this.store.indexedPathPages(signal)) {
      const stale = page.filter((path) => !livePaths.has(path));
      if (stale.length) {
        await this.store.deleteNotes(stale, signal);
        deleted += stale.length;
      }
    }
    return { visited: listed.length, deleted, lexicalOnly };
  }

  private async indexLatest(
    path: string,
    livePaths: Set<string>,
    signal: AbortSignal
  ): Promise<void> {
    for (;;) {
      checkAbort(signal);
      if (!(await this.vault.isMarkdownAvailable(path, signal))) {
        livePaths.delete(path);
        return;
      }
      const note = await this.vault.readMarkdown(path, signal);
      if (note.path !== path) throw new Error("Vault returned a note for a different path");
      await this.store.addDocuments([toDocument(note)], { signal });
      checkAbort(signal);
      if (!(await this.vault.isMarkdownAvailable(path, signal))) {
        livePaths.delete(path);
        return;
      }
      const latest = await this.vault.readMarkdown(path, signal);
      if ((await noteContentHash(latest.content)) === (await noteContentHash(note.content))) return;
    }
  }

  private async indexLatestLexically(
    path: string,
    livePaths: Set<string>,
    signal: AbortSignal
  ): Promise<void> {
    for (;;) {
      checkAbort(signal);
      if (!(await this.vault.isMarkdownAvailable(path, signal))) {
        livePaths.delete(path);
        return;
      }
      const note = await this.vault.readMarkdown(path, signal);
      if (note.path !== path) throw new Error("Vault returned a note for a different path");
      await this.store.replaceLexical(toDocument(note), signal);
      checkAbort(signal);
      if (!(await this.vault.isMarkdownAvailable(path, signal))) {
        livePaths.delete(path);
        return;
      }
      const latest = await this.vault.readMarkdown(path, signal);
      if ((await noteContentHash(latest.content)) === (await noteContentHash(note.content))) return;
    }
  }
}

function toDocument(note: ManualIndexNote): Document {
  return new Document({ id: note.path, pageContent: note.content, metadata: { path: note.path } });
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Indexing cancelled", "AbortError");
}
