import {
  compareCodeUnits,
  deriveNoteContentId,
  indexIdentity,
  normalizeVaultPath as normalizePath,
} from "@/index/Identity";
import { CHUNK_SIZE } from "@/index/chunking";
import {
  type SqliteLexicalBatchNoteInput,
  type SqliteLexicalBatchResult,
  type SqliteLexicalRunResult,
  type SqliteNoteSummary,
  type SqliteState,
} from "@/index/sqlite/protocol";
import { diagnosticsEnabled, projectDiagnosticError } from "@/diagnostics/TramaDiagnostics";
import type { IndexSyncResult, IndexVaultDocument } from "./contracts";
import { IndexJournal } from "./journal";
import { check, IndexRuntime } from "./runtime";

export interface LexicalSnapshot {
  readonly paths: readonly string[];
  readonly summaries: readonly SqliteNoteSummary[];
  readonly documents: ReadonlyMap<string, IndexVaultDocument>;
  readonly revision: number;
}

export class LexicalSnapshotService {
  constructor(
    private readonly runtime: IndexRuntime,
    private readonly journal: IndexJournal
  ) {}
  async runFullLexical(
    signal: AbortSignal,
    operation: "rebuild" | "update" = "update"
  ): Promise<IndexSyncResult> {
    let snapshot = await this.readLexicalSnapshot(signal, operation);
    let changed = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      check(signal);
      if (this.journal.fullRecoveryRequested && snapshot.revision !== this.journal.revision) {
        snapshot = await this.readLexicalSnapshot(signal, operation);
      }
      let runId: string | undefined;
      try {
        if (
          operation !== "rebuild" &&
          !this.journal.fullRecoveryRequested &&
          !this.runtime.state?.incomplete &&
          (await this.lexicalSnapshotMatchesState(snapshot, signal))
        ) {
          this.journal.reconciledRevision = snapshot.revision;
          this.journal.changes.length = 0;
          this.journal.fullRecoveryRequested = false;
          this.runtime.freshness = "locally-reconciled";
          return { changed, converged: true };
        }
        const before = this.runtime.state?.changeCounter ?? 0;
        const started = (await this.runtime
          .ensureClient()
          .call(
            "beginLexicalRun",
            { summaries: snapshot.summaries, expectedChangeCounter: before },
            signal
          )) as { runId: string; state: SqliteState };
        runId = started.runId;
        this.runtime.setState(started.state);
        const applied = await this.applyLexicalSnapshot(runId, snapshot, signal, operation);
        changed ||= applied;
        if (snapshot.revision !== this.journal.revision) {
          await this.cleanupLexicalRun(runId, "full");
          runId = undefined;
          if (this.journal.fullRecoveryRequested)
            snapshot = await this.readLexicalSnapshot(signal, operation);
          else snapshot = await this.refreshSnapshotForJournal(snapshot, signal);
          continue;
        }
        let finished: SqliteLexicalRunResult;
        do {
          finished = (await this.runtime
            .ensureClient()
            .call("finishLexicalRun", { runId }, signal)) as SqliteLexicalRunResult;
          this.runtime.setState(finished.state);
          changed ||= finished.receipt.changed;
        } while (!finished.complete);
        runId = undefined;
        if (snapshot.revision !== this.journal.revision) {
          if (this.journal.fullRecoveryRequested)
            snapshot = await this.readLexicalSnapshot(signal, operation);
          else snapshot = await this.refreshSnapshotForJournal(snapshot, signal);
          continue;
        }
        this.journal.reconciledRevision = snapshot.revision;
        this.journal.changes.length = 0;
        this.journal.fullRecoveryRequested = false;
        this.runtime.freshness = "locally-reconciled";
        return { changed, converged: this.runtime.state?.incomplete === false };
      } catch (error) {
        if (runId) {
          await this.cleanupLexicalRun(runId, "full");
          runId = undefined;
        }
        if (signal.aborted) throw error;
        if (attempt >= 7) {
          await this.markIncomplete(new AbortController().signal).catch(() => undefined);
          return { changed, converged: false };
        }
        throw error;
      }
    }
    await this.markIncomplete(new AbortController().signal).catch(() => undefined);
    return { changed, converged: false };
  }

  private async lexicalSnapshotMatchesState(
    snapshot: LexicalSnapshot,
    signal: AbortSignal
  ): Promise<boolean> {
    const current = (await this.runtime
      .ensureClient()
      .call("listLexicalSummaries", {}, signal)) as readonly {
      readonly path: string;
      readonly revisionDigest?: string;
    }[];
    if (current.length !== snapshot.summaries.length) return false;
    const expected = [...snapshot.summaries].sort((a, b) => compareCodeUnits(a.path, b.path));
    for (const [index, summary] of current.entries()) {
      if (
        summary.path !== expected[index].path ||
        summary.revisionDigest !== expected[index].contentId
      )
        return false;
    }
    return true;
  }

  private async readLexicalSnapshot(
    signal: AbortSignal,
    operation: "full" | "incremental" | "rebuild" | "update" = "full"
  ): Promise<LexicalSnapshot> {
    const timer = this.runtime.performanceTimer();
    const paths = [...(await this.runtime.vault.listMarkdownPaths(signal))]
      .map(normalizePath)
      .filter((path) => this.runtime.isIndexEligible(path))
      .sort(compareCodeUnits);
    const fingerprint = await this.runtime.corpusFingerprintId();
    const documents = new Map<string, IndexVaultDocument>();
    const summaries: SqliteNoteSummary[] = [];
    this.runtime.reportProgress({
      operation: operation === "full" || operation === "rebuild" ? "full" : "incremental",
      phase: "discover",
      completed: paths.length,
      total: paths.length,
      unit: "paths",
      determinate: true,
    });
    this.runtime.reportProgress({
      operation: operation === "full" || operation === "rebuild" ? "full" : "incremental",
      phase: "read",
      completed: 0,
      total: paths.length,
      unit: "notes",
      determinate: true,
    });
    for (const [index, path] of paths.entries()) {
      check(signal);
      const doc = await this.runtime.readMarkdownIfAvailable(path, signal, "full");
      if (doc) {
        documents.set(path, doc);
        summaries.push({
          path,
          contentId: await deriveNoteContentId(fingerprint, doc.content),
        });
      }
      this.runtime.reportProgress(
        {
          operation: operation === "full" || operation === "rebuild" ? "full" : "incremental",
          phase: "read",
          completed: index + 1,
          total: paths.length,
          unit: "notes",
          determinate: true,
        },
        false
      );
    }
    this.runtime.emitPhase("lexical", "snapshotRead", timer, summaries.length);
    return { paths, summaries, documents, revision: this.journal.revision };
  }

  private async refreshSnapshotForJournal(
    snapshot: LexicalSnapshot,
    signal: AbortSignal
  ): Promise<LexicalSnapshot> {
    const fingerprint = await this.runtime.corpusFingerprintId();
    const documents = new Map(snapshot.documents);
    const summaries = new Map(snapshot.summaries.map((summary) => [summary.path, summary]));
    for (const change of this.journal.changes) {
      check(signal);
      if (change.type === "delete") {
        const path = normalizePath(change.path);
        documents.delete(path);
        summaries.delete(path);
        continue;
      }
      if (change.type === "rename") {
        const from = normalizePath(change.from);
        const to = normalizePath(change.to);
        const old = summaries.get(from);
        const doc = documents.get(from);
        summaries.delete(from);
        documents.delete(from);
        if (old && this.runtime.isIndexEligible(to)) {
          summaries.set(to, { ...old, path: to });
          if (doc) documents.set(to, { ...doc, path: to });
          continue;
        }
        if (!this.runtime.isIndexEligible(to)) continue;
        const current = await this.runtime.readMarkdownIfAvailable(to, signal, "incremental");
        if (!current) continue;
        documents.set(to, current);
        summaries.set(to, {
          path: to,
          contentId: await deriveNoteContentId(fingerprint, current.content),
        });
        continue;
      }
      const path = normalizePath(change.path);
      if (!this.runtime.isIndexEligible(path)) {
        documents.delete(path);
        summaries.delete(path);
        continue;
      }
      const doc = await this.runtime.readMarkdownIfAvailable(path, signal, "incremental");
      if (!doc) {
        documents.delete(path);
        summaries.delete(path);
      } else {
        documents.set(path, doc);
        summaries.set(path, {
          path,
          contentId: await deriveNoteContentId(fingerprint, doc.content),
        });
      }
    }
    return {
      paths: [...summaries.keys()].sort(compareCodeUnits),
      summaries: [...summaries.values()].sort((a, b) => compareCodeUnits(a.path, b.path)),
      documents,
      revision: this.journal.revision,
    };
  }

  async applyLexicalSnapshot(
    runId: string,
    snapshot: LexicalSnapshot,
    signal: AbortSignal,
    operation: "full" | "incremental" | "rebuild" | "update"
  ): Promise<boolean> {
    const notes = [...snapshot.documents.values()].sort((a, b) => compareCodeUnits(a.path, b.path));
    const batches: IndexVaultDocument[][] = [];
    let batch: IndexVaultDocument[] = [];
    let bytes = 0;
    for (const note of notes) {
      const noteBytes = new TextEncoder().encode(note.content).byteLength;
      if (batch.length && (batch.length >= 16 || bytes + noteBytes > 8 * 1024 * 1024)) {
        batches.push(batch);
        batch = [];
        bytes = 0;
      }
      batch.push(note);
      bytes += noteBytes;
    }
    if (batch.length) batches.push(batch);
    const fingerprint = await this.runtime.corpusFingerprintId();
    let changed = false;
    this.runtime.reportProgress({
      operation: operation === "full" || operation === "rebuild" ? "full" : "incremental",
      phase: "encode-write",
      completed: 0,
      total: notes.length,
      unit: "notes",
      determinate: true,
    });
    let completed = 0;
    for (const group of batches) {
      check(signal);
      const batchTimer = this.runtime.performanceTimer();
      const batchClient = this.runtime.ensureClient();
      const batchOperationId = batchTimer ? batchClient.diagnosticOperationId() : undefined;
      const result = (await batchClient.call(
        "applyLexicalBatch",
        {
          runId,
          notes: await Promise.all(
            group.map(async (note): Promise<SqliteLexicalBatchNoteInput> => ({
              path: normalizePath(note.path),
              markdown: note.content,
              expectedRevisionDigest: await deriveNoteContentId(fingerprint, note.content),
              size: this.runtime.options.size ?? CHUNK_SIZE,
            }))
          ),
        },
        signal,
        { diagnosticOperationId: batchOperationId }
      )) as SqliteLexicalBatchResult;
      this.runtime.emitPhase(
        "lexical",
        "batch",
        batchTimer,
        group.length,
        undefined,
        batchOperationId
      );
      changed ||= result.changed;
      completed += group.length;
      this.runtime.reportProgress(
        {
          operation: operation === "full" || operation === "rebuild" ? "full" : "incremental",
          phase: "encode-write",
          completed,
          total: notes.length,
          unit: "notes",
          determinate: true,
          generationId: indexIdentity(result.receipt.generation.changeCounter),
        },
        false
      );
      if (result.occurrences > 0)
        this.runtime.reportProgress(
          {
            operation: operation === "full" || operation === "rebuild" ? "full" : "incremental",
            phase: "chunk",
            completed: result.occurrences,
            total: result.occurrences,
            unit: "texts",
            determinate: true,
          },
          false
        );
    }
    return changed;
  }

  private async abortLexicalRun(runId: string, signal: AbortSignal): Promise<void> {
    const result = (await this.runtime
      .ensureClient()
      .call("abortLexicalRun", { runId }, signal)) as SqliteLexicalRunResult;
    this.runtime.setState(result.state);
  }

  async cleanupLexicalRun(runId: string, operation: "full" | "incremental"): Promise<void> {
    try {
      await this.abortLexicalRun(runId, new AbortController().signal);
    } catch (error) {
      if (diagnosticsEnabled(this.runtime.diagnostics, "detailed"))
        this.runtime.emit({
          area: "index",
          event: "index_operation",
          operation,
          stage: "cleanup-failed",
          phase: "cleanup",
          error: projectDiagnosticError(error),
        });
    }
  }

  async markIncomplete(signal: AbortSignal): Promise<SqliteState> {
    const state = (await this.runtime
      .ensureClient()
      .call("markIncomplete", {}, signal)) as SqliteState;
    this.runtime.setState(state);
    return state;
  }
}
