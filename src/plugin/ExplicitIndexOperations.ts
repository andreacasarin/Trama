import type { IndexManager, IndexSyncResult } from "@/index/IndexManager";
import type { SchedulerSource, SchedulerTransition } from "@/plugin/scheduler";
import type { TramaSettings } from "@/settings/Settings";
import type { IndexStatusController } from "@/ui/index/IndexStatus";

interface ExplicitIndexHost {
  getApp(): any;
  getSettings(): TramaSettings;
  getIndex(): IndexManager | undefined;
  getIndexStatus(): IndexStatusController | undefined;
  getIndexLoad(): Promise<boolean> | undefined;
  isIndexReady(): boolean;
  setIndexReady(ready: boolean): void;
  getVaultEventRevision(): number;
  getSchedulerSource(): SchedulerSource;
  setSchedulerSource(source: SchedulerSource): void;
  getVisibleMarkdownCount(): number;
  isQueued(): boolean;
  clearQueued(): void;
  getLexicalPromise(): Promise<void> | undefined;
  getSemanticPromise(): Promise<void> | undefined;
  pausePublication(): void;
  stopLexical(markStale?: boolean): void;
  pauseSemantic(): void;
  stopSemantic(): void;
  resetManualSchedulerState(): void;
  markSemanticEligible(): void;
  scheduleSemantic(): void;
  scheduleLexical(): void;
  reconcile(signal: AbortSignal): Promise<void>;
  updateCapabilities(manager: IndexManager): void;
  refreshViews(changed: boolean): void;
  emit(transition: SchedulerTransition): void;
}

export class ExplicitIndexOperations {
  semanticAbort?: AbortController;
  combinedRebuildLexicalPhase = false;

  constructor(private readonly host: ExplicitIndexHost) {}

  async prepareSemantic(): Promise<void> {
    if (!this.host.getIndex()) throw new Error("Index is not initialized.");
    const status = this.host.getIndexStatus();
    if (status) return status.prepare();
    const controller = new AbortController();
    this.semanticAbort?.abort();
    this.semanticAbort = controller;
    try {
      await this.runSemanticPreparation(controller.signal);
    } finally {
      if (this.semanticAbort === controller) this.semanticAbort = undefined;
    }
  }

  async forceUpdate(signal: AbortSignal): Promise<void> {
    const app = this.host.getApp();
    if (!app?.workspace) throw new Error("Workspace is not initialized.");
    this.host.pausePublication();
    this.host.stopLexical(false);
    this.host.pauseSemantic();
    await Promise.all([
      this.host.getSemanticPromise()?.catch(() => undefined),
      this.host.getLexicalPromise()?.catch(() => undefined),
    ]);
    if (signal.aborted) throw new Error("Index update cancelled.");
    await this.saveOpenMarkdownBuffers(app.workspace);
    if (signal.aborted) throw new Error("Index update cancelled.");
    await this.host.getIndexLoad();
    const manager = this.host.getIndex();
    if (!manager) throw new Error("Index is not initialized.");
    await this.runIndex(signal, false);
    if (!manager.isComplete() || this.host.isQueued())
      throw new Error("Lexical index did not converge; semantic update was not started.");
    this.host.getIndexStatus()?.beginSemanticPreparation();
    await this.runSemanticPreparation(signal);
  }

  async runFullIndex(signal: AbortSignal): Promise<void> {
    return this.runIndex(signal, true);
  }

  async runBothIndexes(signal: AbortSignal): Promise<void> {
    this.combinedRebuildLexicalPhase = true;
    try {
      await this.runIndex(signal, true, false);
    } finally {
      this.combinedRebuildLexicalPhase = false;
    }
    if (!this.host.getIndex()?.isComplete())
      throw new Error("Lexical index did not converge; semantic index was not rebuilt.");
    this.host.getIndexStatus()?.beginSemanticRebuild();
    await this.runSemanticPreparation(signal, true);
  }

  async runIndex(signal: AbortSignal, force: boolean, settleStatus = true): Promise<void> {
    this.host.pausePublication();
    this.host.stopLexical(false);
    this.host.resetManualSchedulerState();
    const manager = this.host.getIndex();
    if (!manager) throw new Error("Index is not initialized.");
    this.host.stopSemantic();
    await this.host.getIndexLoad();
    if (this.host.getIndex() !== manager) throw new Error("Index was replaced during indexing.");
    this.host.markSemanticEligible();
    const eventRevision = this.host.getVaultEventRevision();
    const startedAt = Date.now();
    this.host.setSchedulerSource("explicit");
    this.host.emit({ channel: "lexical", stage: "running", source: "explicit" });
    let result: IndexSyncResult;
    try {
      result = force
        ? (await manager.build(signal), { changed: true, converged: manager.isComplete() })
        : await manager.synchronize(signal);
    } catch (error) {
      this.host.emit({
        channel: "lexical",
        stage: signal.aborted ? "cancelled" : "failed",
        source: "explicit",
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
    this.host.emit({
      channel: "lexical",
      stage: result.converged ? "completed" : "incomplete",
      source: "explicit",
      durationMs: Date.now() - startedAt,
    });
    this.host.setIndexReady(true);
    this.host.updateCapabilities(manager);
    this.host.refreshViews(result.changed);
    if (result.converged && eventRevision === this.host.getVaultEventRevision()) {
      const journalRevision = manager.journalSnapshot().revision;
      manager.clearJournalIfCurrent(journalRevision);
      this.host.clearQueued();
      this.host.markSemanticEligible();
      this.host.scheduleSemantic();
    }
    if (this.host.isQueued()) await this.host.reconcile(signal).catch(() => undefined);
    else if (settleStatus) {
      if (!manager.isComplete() || eventRevision !== this.host.getVaultEventRevision())
        this.host.getIndexStatus()?.markStale(manager.hasUsableIndex());
      else if (this.host.getVisibleMarkdownCount() === 0)
        this.host.getIndexStatus()?.setEmpty(true);
      else this.host.getIndexStatus()?.setReady();
    }
  }

  async runSemanticPreparation(signal: AbortSignal, rebuild = false): Promise<void> {
    const manager = this.host.getIndex();
    if (!manager) throw new Error("Index is not initialized.");
    const eventRevision = this.host.getVaultEventRevision();
    this.host.pausePublication();
    this.host.stopSemantic();
    const startedAt = Date.now();
    const previousSource = this.host.getSchedulerSource();
    this.host.setSchedulerSource("explicit");
    this.host.emit({ channel: "semantic", stage: "running", source: "explicit" });
    try {
      if (rebuild) await manager.rebuildSemantic(signal);
      else await manager.prepareSemantic(signal);
      this.host.setIndexReady(true);
      this.host.updateCapabilities(manager);
      this.host.emit({
        channel: "semantic",
        stage: "completed",
        source: "explicit",
        durationMs: Date.now() - startedAt,
      });
      if (this.host.isQueued() || eventRevision !== this.host.getVaultEventRevision())
        this.host
          .getIndexStatus()
          ?.markStale(
            manager.hasUsableIndex(),
            "Changes arrived during semantic indexing. The index is not current; update the lexical index, then update missing semantic vectors."
          );
    } catch (error) {
      this.host.emit({
        channel: "semantic",
        stage: signal.aborted ? "cancelled" : "failed",
        source: "explicit",
        durationMs: Date.now() - startedAt,
      });
      throw error;
    } finally {
      if (this.host.isQueued() && this.host.getSettings().filo.automaticLexicalDelayMs > 0)
        this.host.scheduleLexical();
      this.host.setSchedulerSource(previousSource);
    }
  }

  private async saveOpenMarkdownBuffers(workspace: any): Promise<void> {
    const leaves = workspace.getLeavesOfType?.("markdown") ?? [];
    const savedPaths = new Set<string>();
    for (const leaf of leaves) {
      const view = leaf?.view;
      const path = view?.file?.path;
      if (
        typeof path !== "string" ||
        !/\.md$/i.test(path) ||
        typeof view.save !== "function" ||
        savedPaths.has(path)
      )
        continue;
      savedPaths.add(path);
      await view.save();
    }
  }
}
