import { StructuredError } from "@/domain/contracts";
import { compareCodeUnits, normalizeVaultPath as normalizePath } from "@/index/Identity";
import {
  sqliteError,
  type SqliteLexicalRunResult,
  type SqliteState,
} from "@/index/sqlite/protocol";
import { projectDiagnosticError } from "@/diagnostics/TramaDiagnostics";
import type { IndexPathMutation, IndexSyncResult, IndexVaultDocument } from "./contracts";
import { IndexJournal } from "./journal";
import { LexicalSnapshotService, type LexicalSnapshot } from "./lexical-snapshot";
import { check, IndexRuntime } from "./runtime";

export class LexicalCoordinator {
  constructor(
    private readonly runtime: IndexRuntime,
    private readonly journal: IndexJournal,
    private readonly snapshots: LexicalSnapshotService
  ) {}
  async build(signal: AbortSignal): Promise<void> {
    await this.runtime.waitForMaintenance(signal);
    if (this.runtime.building)
      throw new StructuredError("busy", "Index rebuild is already running.", true);
    if (this.runtime.preparing)
      throw new StructuredError("busy", "Semantic index preparation is already running.", true);
    const run = this.buildInternal(signal);
    this.runtime.buildPromise = run;
    try {
      await run;
    } finally {
      if (this.runtime.buildPromise === run) this.runtime.buildPromise = undefined;
    }
  }
  async waitForBuild(): Promise<void> {
    await this.runtime.buildPromise;
  }
  private async buildInternal(signal: AbortSignal): Promise<void> {
    check(signal);
    this.runtime.building = true;
    const started = Date.now();
    try {
      if (!this.runtime.loaded && !(await this.runtime.load()))
        throw (
          this.runtime.loadError ??
          sqliteError("storage_unavailable", "SQLite index is unavailable.", true)
        );
      if (this.runtime.unavailable)
        throw (
          this.runtime.loadError ??
          sqliteError("storage_unavailable", "SQLite index is unavailable.", true)
        );
      const result = await this.snapshots.runFullLexical(signal, "rebuild");
      this.runtime.reportProgress({
        operation: "full",
        phase: "validate",
        completed: 1,
        total: 1,
        unit: "artifacts",
        determinate: true,
        generationId: this.runtime.generationId(),
      });
      const finalState = this.runtime.state;
      if (finalState && !finalState.incomplete)
        this.runtime.notifySuccessfulOperation({
          operation: "rebuild",
          changed: result.changed,
          converged: result.converged,
          state: finalState,
        });
      this.runtime.emit({
        area: "index",
        event: "index_operation",
        operation: "build",
        stage: "completed",
        durationMs: Date.now() - started,
        generation: this.runtime.generationId(),
        counts: {
          notes: finalState?.noteCount ?? 0,
          chunks: finalState?.chunkCount ?? 0,
          incomplete: finalState?.incomplete ? 1 : 0,
        },
      });
    } catch (error) {
      this.runtime.emit({
        area: "index",
        event: "index_operation",
        operation: "build",
        stage: signal.aborted ? "cancelled" : "failed",
        durationMs: Date.now() - started,
        error: projectDiagnosticError(error),
      });
      throw error;
    } finally {
      this.runtime.building = false;
    }
  }

  async synchronize(signal: AbortSignal): Promise<IndexSyncResult> {
    return this.runSynchronization(signal);
  }

  async reconcileChanges(
    changes: readonly IndexPathMutation[],
    signal: AbortSignal
  ): Promise<IndexSyncResult> {
    await this.runtime.waitForMaintenance(signal);
    if (this.runtime.building || this.runtime.preparing)
      throw new StructuredError("busy", "Index maintenance is already running.", true);
    check(signal);
    if (!this.runtime.loaded && !(await this.runtime.load()))
      throw (
        this.runtime.loadError ??
        sqliteError("storage_unavailable", "SQLite index is unavailable.", true)
      );
    if (this.runtime.unavailable)
      throw (
        this.runtime.loadError ??
        sqliteError("storage_unavailable", "SQLite index is unavailable.", true)
      );
    this.runtime.building = true;
    const revision = this.journal.revision;
    let runId: string | undefined;
    try {
      // The loaded state is the compact generation fence for a scoped run.
      // Do not refresh global status or round-trip the complete lexical
      // summary: only the journaled paths belong to this operation.
      const before = this.runtime.state;
      if (!before)
        throw new StructuredError("unavailable", "SQLite index state is unavailable.", true);
      const documents = new Map<string, IndexVaultDocument>();
      const renames: { from: string; to: string }[] = [];
      const deletes = new Set<string>();
      for (const change of changes) {
        check(signal);
        if (change.type === "delete") {
          deletes.add(normalizePath(change.path));
          continue;
        }
        if (change.type === "rename") {
          const from = normalizePath(change.from);
          const to = normalizePath(change.to);
          const fromEligible = this.runtime.isIndexEligible(from);
          const toEligible = this.runtime.isIndexEligible(to);
          if (fromEligible && toEligible) {
            renames.push({ from, to });
          } else if (fromEligible) {
            deletes.add(from);
          } else if (toEligible) {
            const doc = await this.runtime.readMarkdownIfAvailable(to, signal, "incremental");
            if (doc) documents.set(to, doc);
          }
          continue;
        }
        const path = normalizePath(change.path);
        if (!this.runtime.isIndexEligible(path)) {
          deletes.add(path);
          continue;
        }
        const doc = await this.runtime.readMarkdownIfAvailable(path, signal, "incremental");
        if (!doc) deletes.add(path);
        else documents.set(path, doc);
      }
      if (revision !== this.journal.revision) return { changed: false, converged: false };
      const snapshot: LexicalSnapshot = {
        paths: [...documents.keys()].sort(compareCodeUnits),
        summaries: [],
        documents,
        revision,
      };
      const run = (await this.runtime.ensureClient().call(
        "beginLexicalRun",
        {
          expectedChangeCounter: before.changeCounter,
          scope: {
            renames,
            deletes: [...deletes].sort(compareCodeUnits),
            mayClearIncomplete:
              !before.incomplete &&
              !before.snapshotLoaded &&
              !this.journal.fullRecoveryRequested &&
              revision === this.journal.revision,
          },
        },
        signal
      )) as { runId: string; state: SqliteState };
      runId = run.runId;
      this.runtime.setState(run.state);
      let changed = await this.snapshots.applyLexicalSnapshot(
        run.runId,
        snapshot,
        signal,
        "incremental"
      );
      if (revision !== this.journal.revision) {
        await this.snapshots.cleanupLexicalRun(run.runId, "incremental");
        runId = undefined;
        return { changed, converged: false };
      }
      let finished: SqliteLexicalRunResult;
      do {
        finished = (await this.runtime
          .ensureClient()
          .call("finishLexicalRun", { runId: run.runId }, signal)) as SqliteLexicalRunResult;
        this.runtime.setState(finished.state);
        changed ||= finished.receipt.changed;
      } while (!finished.complete);
      runId = undefined;
      if (revision !== this.journal.revision) {
        await this.snapshots.markIncomplete(new AbortController().signal);
        return { changed, converged: false };
      }
      this.journal.reconciledRevision = revision;
      this.runtime.freshness = this.runtime.state?.snapshotLoaded
        ? "snapshot-loaded"
        : "locally-reconciled";
      const result = { changed, converged: this.runtime.state?.incomplete === false };
      if (result.converged)
        this.runtime.notifySuccessfulOperation({
          operation: "update",
          ...result,
          state: this.runtime.state!,
        });
      return result;
    } catch (error) {
      if (runId) {
        await this.snapshots.cleanupLexicalRun(runId, "incremental");
        runId = undefined;
      }
      try {
        await this.snapshots.markIncomplete(new AbortController().signal);
      } catch {
        // The Worker may already be unavailable; retain the original operation error.
      }
      throw error;
    } finally {
      this.runtime.building = false;
    }
  }

  private async runSynchronization(
    signal: AbortSignal,
    phase?: "queued"
  ): Promise<IndexSyncResult> {
    await this.runtime.waitForMaintenance(signal);
    if (this.runtime.building)
      throw new StructuredError("busy", "Index update is already running.", true);
    if (this.runtime.preparing)
      throw new StructuredError("busy", "Semantic index preparation is already running.", true);
    check(signal);
    this.runtime.building = true;
    const started = Date.now();
    this.runtime.emit({
      area: "index",
      event: "index_operation",
      operation: "incremental",
      stage: "started",
      ...(phase ? { phase } : {}),
    });
    const complete = (changed: boolean): IndexSyncResult => {
      this.runtime.emit({
        area: "index",
        event: "index_operation",
        operation: "incremental",
        stage: "completed",
        ...(phase ? { phase } : {}),
        durationMs: Date.now() - started,
        generation: this.runtime.generationId(),
        counts: {
          changed: changed ? 1 : 0,
          notes: this.runtime.state?.noteCount ?? 0,
          chunks: this.runtime.state?.chunkCount ?? 0,
          incomplete: this.runtime.state?.incomplete ? 1 : 0,
        },
      });
      return { changed, converged: this.runtime.state?.incomplete === false };
    };
    try {
      if (!this.runtime.loaded && !(await this.runtime.load()))
        throw (
          this.runtime.loadError ??
          sqliteError("storage_unavailable", "SQLite index is unavailable.", true)
        );
      if (this.runtime.unavailable)
        throw (
          this.runtime.loadError ??
          sqliteError("storage_unavailable", "SQLite index is unavailable.", true)
        );
      const result = await this.snapshots.runFullLexical(signal, "update");
      if (result.converged)
        this.runtime.notifySuccessfulOperation({
          operation: "update",
          ...result,
          state: this.runtime.state!,
        });
      return complete(result.changed);
    } catch (error) {
      this.runtime.emit({
        area: "index",
        event: "index_operation",
        operation: "incremental",
        stage: signal.aborted ? "cancelled" : "failed",
        ...(phase ? { phase } : {}),
        durationMs: Date.now() - started,
        error: projectDiagnosticError(error),
      });
      throw error;
    } finally {
      this.runtime.building = false;
    }
  }

  async reconcileQueuedChanges(signal: AbortSignal): Promise<IndexSyncResult> {
    const journal = this.journal.snapshot();
    if (
      !journal.fullRecovery &&
      journal.changes.length &&
      this.runtime.state?.incomplete === false
    ) {
      const result = await this.reconcileChanges(journal.changes, signal);
      if (result.converged) this.journal.clearIfCurrent(journal.revision);
      return result;
    }
    if (!this.journal.hasPendingWork(this.runtime.state))
      return { changed: false, converged: this.runtime.state?.incomplete === false };
    if (this.runtime.building) {
      await this.runtime.buildPromise;
      if (this.runtime.building)
        throw new StructuredError("busy", "Index update is already running.", true);
    }
    const result = await this.runSynchronization(signal, "queued");
    if (result.converged) this.journal.clearIfCurrent(journal.revision);
    return result;
  }
}
