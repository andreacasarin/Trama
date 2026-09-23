import { afterEach, describe, expect, it, vi } from "vitest";
import { TramaPlugin } from "@/plugin/TramaPlugin";
import { DEFAULT_SETTINGS } from "@/settings/Settings";
import { IndexStatusController } from "@/ui/index/IndexStatus";
import { IndexOperationLease } from "@/ui/index/IndexOperationLease";
import { sqliteError } from "@/index/sqlite/protocol";
import { schedulerStatusMessage } from "@/plugin/SchedulerStatus";

describe("automatic scheduler status and diagnostics", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps scheduler details separate from primary index readiness", () => {
    const status = new IndexStatusController({} as any, {
      index: async () => undefined,
      reindex: async () => undefined,
      cancel: () => undefined,
    });
    status.setReady();
    status.setSchedulerMessage(
      "Automatic updates — lexical paused; semantic Off; publication scheduled (30 sec)."
    );

    expect(status.getStatus()).toMatchObject({
      kind: "ready",
      hasLastGood: true,
      schedulerMessage:
        "Automatic updates — lexical paused; semantic Off; publication scheduled (30 sec).",
    });
  });

  it("reports automatic channel states from current settings and timers", () => {
    expect(
      schedulerStatusMessage({
        settings: {
          ...DEFAULT_SETTINGS.filo,
          automaticLexicalDelayMs: 0,
          automaticSemanticDelayMs: 0,
          automaticPublicationDelayMs: 30_000,
        },
        lexical: {
          queued: true,
          running: false,
          retryPaused: false,
          retryScheduled: false,
          retryAttempt: 0,
          delayed: false,
        },
        semantic: {
          running: false,
          retryScheduled: false,
          retryAttempt: 0,
          delayed: false,
          indexComplete: true,
          eligible: false,
          searchable: false,
        },
        publication: {
          running: false,
          retryScheduled: false,
          retryAttempt: 0,
          retryPaused: false,
          delayed: true,
          pending: true,
        },
      })
    ).toBe("Automatic updates — lexical paused; semantic Off; publication scheduled (30 sec).");
  });

  it("distinguishes scheduled, running, and retrying channel details", () => {
    expect(
      schedulerStatusMessage({
        settings: {
          ...DEFAULT_SETTINGS.filo,
          automaticLexicalDelayMs: 750,
          automaticSemanticDelayMs: 1_000,
          automaticPublicationDelayMs: 5_000,
        },
        lexical: {
          queued: true,
          running: false,
          retryPaused: false,
          retryScheduled: false,
          retryAttempt: 0,
          delayed: true,
        },
        semantic: {
          running: true,
          retryScheduled: false,
          retryAttempt: 0,
          delayed: false,
          indexComplete: true,
          eligible: true,
          searchable: false,
        },
        publication: {
          running: false,
          retryScheduled: true,
          retryAttempt: 2,
          retryPaused: false,
          delayed: false,
          pending: true,
        },
      })
    ).toBe(
      "Automatic updates — lexical scheduled (0.75 sec); semantic running; publication retrying (attempt 2)."
    );
  });

  it("logs queued scheduler transitions as counts without note paths", () => {
    vi.useFakeTimers();
    const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
    plugin.settingsStore.load({
      ...DEFAULT_SETTINGS,
      detailedDebug: true,
      filo: { ...DEFAULT_SETTINGS.filo, automaticLexicalDelayMs: 750 },
    });
    plugin.index = {
      hasCompatibleSemanticVectors: () => false,
      hasPendingSemanticWork: () => false,
      recordPathMutation: vi.fn(),
      pendingChangeCount: () => 1,
      isBuilding: () => false,
      isComplete: () => true,
      capabilities: () => ({ semantic: { activity: "idle", searchable: false } }),
    };
    plugin.indexReady = true;
    plugin.indexStatus = {
      setSchedulerMessage: vi.fn(),
      setUpdating: vi.fn(),
      getStatus: () => ({}),
    };
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);

    plugin.queueVaultMutation({ type: "upsert", path: "Private/secret-note.md" });

    const records = log.mock.calls.map(([, record]) => record as Record<string, unknown>);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "lexical",
          source: "event",
          stage: "queued",
          delayMs: 750,
          counts: { events: 1, queued: 1 },
        }),
        expect.objectContaining({
          channel: "lexical",
          source: "event",
          stage: "delayed",
          delayMs: 750,
          counts: { queued: 1 },
        }),
      ])
    );
    expect(JSON.stringify(records)).not.toContain("Private/secret-note.md");
    plugin.lexicalScheduler.stop(false);
    log.mockRestore();
  });

  it("projects automatic semantic failures into bounded diagnostic metadata", async () => {
    const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
    plugin.settingsStore.load({
      ...DEFAULT_SETTINGS,
      detailedDebug: true,
      filo: { ...DEFAULT_SETTINGS.filo, automaticSemanticDelayMs: 1_000 },
    });
    plugin.indexReady = true;
    plugin.indexStatus = {
      acquireExternalLease: () => new IndexOperationLease("semantic"),
      hasActiveOperation: () => false,
      setCapabilities: vi.fn(),
      setSchedulerMessage: vi.fn(),
      getStatus: () => ({}),
    };
    plugin.index = {
      hasPendingSemanticWork: () => true,
      isComplete: () => true,
      isBuilding: () => false,
      capabilities: () => ({ semantic: { searchable: false, activity: "idle" } }),
      prepareSemanticCacheBatch: vi.fn(async () => {
        throw sqliteError("storage_unavailable", "raw note content /private/vault/Secret.md", true);
      }),
    };
    plugin.semanticScheduler.markEligibleIfPending(plugin.index);
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await plugin.semanticScheduler.runBatch("event");

    const records = log.mock.calls.map(([, record]) => record as Record<string, any>);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "semantic",
          stage: "failed",
          error: expect.objectContaining({
            code: "storage_unavailable",
            retryable: true,
          }),
        }),
      ])
    );
    const failure = records.find(
      (record) => record.channel === "semantic" && record.stage === "failed"
    );
    expect(failure).toBeDefined();
    if (!failure) return;
    expect(failure.error.message).not.toContain("Secret.md");
    expect(failure.error.message).toContain("<path>");
    expect(failure.error.message.length).toBeLessThanOrEqual(240);
    log.mockRestore();
  });

  it("pauses nonretryable automatic semantic failures with a general status error", async () => {
    const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
    plugin.settingsStore.load({
      ...DEFAULT_SETTINGS,
      filo: { ...DEFAULT_SETTINGS.filo, automaticSemanticDelayMs: 1_000 },
    });
    const markError = vi.fn();
    plugin.indexStatus = {
      markError,
      setSchedulerMessage: vi.fn(),
      getStatus: () => ({}),
      hasActiveOperation: () => false,
      setCapabilities: vi.fn(),
      acquireExternalLease: () => new IndexOperationLease("semantic"),
    };
    plugin.indexReady = true;
    plugin.index = {
      hasPendingSemanticWork: () => true,
      isComplete: () => true,
      isBuilding: () => false,
      capabilities: () => ({ semantic: { searchable: false, activity: "idle" } }),
      prepareSemanticCacheBatch: vi.fn(async () => {
        throw sqliteError("limit_exceeded", "Semantic input is 9 bytes; maximum is 8 bytes.");
      }),
    };
    plugin.semanticScheduler.markEligibleIfPending(plugin.index);

    await plugin.semanticScheduler.runBatch("event");

    expect(markError).toHaveBeenCalledTimes(1);
    expect(plugin.semanticScheduler.snapshot().retryScheduled).toBe(false);
    expect(plugin.semanticScheduler.snapshot().retryPaused).toBe(true);
    expect(plugin.semanticScheduler.snapshot().eligible).toBe(false);
  });

  it("retries protocol failures on the lexical and semantic schedules", () => {
    vi.useFakeTimers();
    const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
    plugin.settingsStore.load({
      ...DEFAULT_SETTINGS,
      detailedDebug: true,
      filo: {
        ...DEFAULT_SETTINGS.filo,
        automaticLexicalDelayMs: 750,
        automaticSemanticDelayMs: 1_000,
      },
    });
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const failure = sqliteError("storage_unavailable", "worker unavailable", true);

    for (let attempt = 0; attempt < 4; attempt++) {
      plugin.lexicalScheduler.scheduleRetry(failure);
      plugin.semanticScheduler.scheduleRetry(failure);
    }

    const records = log.mock.calls.map(([, record]) => record as Record<string, any>);
    expect(
      records
        .filter((record) => record.stage === "retrying" && record.channel === "lexical")
        .map((record) => record.delayMs)
    ).toEqual([5_000, 15_000, 60_000]);
    expect(
      records
        .filter((record) => record.stage === "retrying" && record.channel === "semantic")
        .map((record) => record.delayMs)
    ).toEqual([5_000, 15_000, 60_000]);
    plugin.lexicalScheduler.stop(false);
    plugin.semanticScheduler.stop();
    log.mockRestore();

    const legacyPlugin = new TramaPlugin(undefined as never, undefined as never) as any;
    legacyPlugin.settingsStore.load({
      ...DEFAULT_SETTINGS,
      detailedDebug: true,
      filo: {
        ...DEFAULT_SETTINGS.filo,
        automaticLexicalDelayMs: 750,
        automaticSemanticDelayMs: 1_000,
      },
    });
    const legacyLog = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const legacyFailure = { retryable: true, message: "legacy retry" };
    legacyPlugin.lexicalScheduler.scheduleRetry(legacyFailure);
    legacyPlugin.semanticScheduler.scheduleRetry(legacyFailure);
    const legacyRecords = legacyLog.mock.calls.map(([, record]) => record as Record<string, any>);
    expect(legacyRecords.filter((record) => record.stage === "retrying")).toHaveLength(2);
    legacyPlugin.lexicalScheduler.stop(false);
    legacyPlugin.semanticScheduler.stop();
    legacyLog.mockRestore();
  });
});
