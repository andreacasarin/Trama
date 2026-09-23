import { afterEach, describe, expect, it, vi } from "vitest";
import { TramaPlugin } from "@/plugin/TramaPlugin";
import { DEFAULT_SETTINGS } from "@/settings/Settings";

function publicationHarness(delay = 5_000) {
  const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
  const settings = {
    ...DEFAULT_SETTINGS,
    filo: { ...DEFAULT_SETTINGS.filo, automaticPublicationDelayMs: delay },
  };
  plugin.settingsStore.load(settings);
  const index = {
    isComplete: () => true,
    isBuilding: () => false,
    isInMaintenance: () => false,
    capabilities: () => ({ semantic: { activity: "idle" } }),
  };
  const publication = {
    isBusy: false,
    publish: vi.fn(async () => ({ published: true, publicationId: "local" })),
  };
  plugin.index = index;
  plugin.publicationManager = publication;
  plugin.indexStatus = {
    setPublicationWarning: vi.fn(),
    setSchedulerMessage: vi.fn(),
    setCapabilities: vi.fn(),
  };
  plugin.indexReady = true;
  plugin.queuedWork = false;
  plugin.vaultEventRevision = 0;
  const operation = (changeCounter: number, type: "update" | "prepare" = "update") => ({
    operation: type,
    changed: true,
    converged: true,
    state: { incomplete: false, changeCounter },
  });
  return { plugin, index, publication, operation };
}

describe("SQLite publication plugin maintenance", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("delegates publication retry and synchronized-file adoption", async () => {
    const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
    plugin.publicationManager = {
      publish: vi.fn().mockResolvedValue({ published: true, publicationId: "local-1" }),
      adoptCurrent: vi.fn().mockResolvedValue({
        adopted: true,
        publicationId: "remote-1",
        state: { publicationId: "remote-1" },
      }),
    };
    plugin.index = { capabilities: () => ({}) };
    plugin.indexStatus = undefined;

    await expect(plugin.retryPublication()).resolves.toBeUndefined();
    await expect(plugin.checkPublication()).resolves.toBeUndefined();
    expect(plugin.publicationManager.publish).toHaveBeenCalledTimes(1);
    expect(plugin.publicationManager.adoptCurrent).toHaveBeenCalledTimes(1);
  });

  it("does not adopt or publish when the synchronized file is absent", async () => {
    const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
    plugin.publicationManager = {
      publish: vi.fn(),
      adoptCurrent: vi.fn().mockResolvedValue({ adopted: false, ignored: "missing" }),
    };
    plugin.index = { capabilities: () => ({}) };
    plugin.indexStatus = undefined;

    await plugin.checkPublication();
    expect(plugin.publicationManager.adoptCurrent).toHaveBeenCalledTimes(1);
    expect(plugin.publicationManager.publish).not.toHaveBeenCalled();
  });

  it("coalesces converged lexical operations and semantic completion restarts the quiet timer", async () => {
    vi.useFakeTimers();
    const { plugin, publication, operation } = publicationHarness(5_000);
    plugin.recordAutomaticPublicationIntent(plugin.index, publication, operation(1));
    await vi.advanceTimersByTimeAsync(4_000);
    plugin.recordAutomaticPublicationIntent(plugin.index, publication, operation(2, "prepare"));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(publication.publish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(publication.publish).toHaveBeenCalledTimes(1);
    expect(plugin.pendingAutomaticPublication).toBeUndefined();
    vi.useRealTimers();
  });

  it("publishes with partial semantic coverage when lexical state converged", async () => {
    vi.useFakeTimers();
    const { plugin, publication } = publicationHarness(5_000);
    plugin.recordAutomaticPublicationIntent(plugin.index, publication, {
      operation: "prepare",
      changed: true,
      converged: true,
      state: { incomplete: false, semanticReady: false, changeCounter: 8 },
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(publication.publish).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("does not create automatic intent for disabled publication or nonconverged lexical state", async () => {
    vi.useFakeTimers();
    const { plugin, index, publication, operation } = publicationHarness(0);
    plugin.recordAutomaticPublicationIntent(index, publication, operation(1));
    plugin.getSettings = () => ({
      ...DEFAULT_SETTINGS,
      filo: { ...DEFAULT_SETTINGS.filo, automaticPublicationDelayMs: 5_000 },
    });
    plugin.recordAutomaticPublicationIntent(index, publication, {
      ...operation(2),
      converged: false,
      state: { incomplete: true, changeCounter: 2 },
    });
    expect(plugin.pendingAutomaticPublication).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("reconfigures an existing publication quiet timer and clears intent when switched off", async () => {
    vi.useFakeTimers();
    const { plugin, publication, operation } = publicationHarness(5_000);
    plugin.recordAutomaticPublicationIntent(plugin.index, publication, operation(1));
    await vi.advanceTimersByTimeAsync(2_000);
    await plugin.performSave({
      ...plugin.getSettings(),
      filo: { ...plugin.getSettings().filo, automaticPublicationDelayMs: 10_000 },
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(publication.publish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(publication.publish).toHaveBeenCalledTimes(1);

    plugin.recordAutomaticPublicationIntent(plugin.index, publication, operation(2));
    await plugin.performSave({
      ...plugin.getSettings(),
      filo: { ...plugin.getSettings().filo, automaticPublicationDelayMs: 0 },
    });
    expect(plugin.pendingAutomaticPublication).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("postpones while indexing is active without zero-delay polling", async () => {
    vi.useFakeTimers();
    const { plugin, index, publication, operation } = publicationHarness(5_000);
    let building = true;
    index.isBuilding = () => building;
    plugin.recordAutomaticPublicationIntent(index, publication, operation(1));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(publication.publish).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    building = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(publication.publish).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("postpones while publication or adoption is active", async () => {
    vi.useFakeTimers();
    const { plugin, publication, operation } = publicationHarness(5_000);
    publication.isBusy = true;
    plugin.recordAutomaticPublicationIntent(plugin.index, publication, operation(1));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(publication.publish).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    publication.isBusy = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(publication.publish).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("drops stale automatic intent when a newer operation revision arrives during publication", async () => {
    vi.useFakeTimers();
    let finish!: (value: { published: boolean }) => void;
    const { plugin, publication, operation } = publicationHarness(5_000);
    publication.publish.mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve)) as any
    );
    plugin.recordAutomaticPublicationIntent(plugin.index, publication, operation(1));
    await vi.advanceTimersByTimeAsync(5_000);
    plugin.recordAutomaticPublicationIntent(plugin.index, publication, operation(2));
    finish({ published: true });
    await Promise.resolve();
    expect(plugin.pendingAutomaticPublication).toMatchObject({ changeCounter: 2 });
    vi.useRealTimers();
  });

  it("retries retryable publication failures at 5, 15, and 60 seconds, then pauses", async () => {
    vi.useFakeTimers();
    const { plugin, publication, operation } = publicationHarness(5_000);
    publication.publish.mockResolvedValue({
      published: false,
      warning: { retryable: true, message: "offline" },
    } as any);
    plugin.recordAutomaticPublicationIntent(plugin.index, publication, operation(1));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(publication.publish).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(publication.publish).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(publication.publish).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(publication.publish).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(publication.publish).toHaveBeenCalledTimes(4);
    expect(plugin.automaticPublicationRetryPaused).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("does not automatically retry a nonretryable publication failure", async () => {
    vi.useFakeTimers();
    const { plugin, publication, operation } = publicationHarness(5_000);
    publication.publish.mockResolvedValue({
      published: false,
      warning: { retryable: false, message: "incompatible" },
    } as any);
    plugin.recordAutomaticPublicationIntent(plugin.index, publication, operation(1));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(publication.publish).toHaveBeenCalledTimes(1);
    expect(plugin.automaticPublicationRetryPaused).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("keeps explicit publication immediate when automatic publication is off", async () => {
    const { plugin, publication } = publicationHarness(0);
    await plugin.retryPublication();
    expect(publication.publish).toHaveBeenCalledTimes(1);
  });

  it("adoption does not create automatic publication intent", async () => {
    const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
    plugin.publicationManager = {
      publish: vi.fn(),
      adoptCurrent: vi.fn().mockResolvedValue({ adopted: true, publicationId: "remote" }),
    };
    plugin.index = { capabilities: () => ({}) };
    plugin.indexStatus = {
      setPublicationWarning: vi.fn(),
      setSchedulerMessage: vi.fn(),
      setCapabilities: vi.fn(),
    };
    await plugin.checkPublication();
    expect(plugin.pendingAutomaticPublication).toBeUndefined();
    expect(plugin.publicationManager.publish).not.toHaveBeenCalled();
  });

  it("cancels pending publication after adoption but schedules a later local operation", async () => {
    vi.useFakeTimers();
    const { plugin, index, publication, operation } = publicationHarness(5_000);
    (publication as any).adoptCurrent = vi.fn(async () => ({
      adopted: true,
      publicationId: "remote",
    }));
    plugin.recordAutomaticPublicationIntent(index, publication, operation(1));
    expect(plugin.automaticPublicationTimer).toBeDefined();

    await plugin.checkPublication();

    expect(plugin.pendingAutomaticPublication).toBeUndefined();
    expect(plugin.automaticPublicationTimer).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(publication.publish).not.toHaveBeenCalled();

    plugin.recordAutomaticPublicationIntent(index, publication, operation(2));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(publication.publish).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
