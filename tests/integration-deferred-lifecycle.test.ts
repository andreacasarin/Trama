import { deferred } from "./test-helpers";
import { projectedApp, projectedPlugin, disposeProjectedPlugins } from "./plugin-fixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";
import { DEFAULT_SETTINGS } from "@/settings/Settings";

describe("TramaPlugin deferred lifecycle integration", () => {
  beforeEach(() => {
    Platform.isDesktopApp = true;
    vi.restoreAllMocks();
  });
  afterEach(async () => {
    await disposeProjectedPlugins();
    vi.restoreAllMocks();
  });
  it("transfers pending edits and edits during replacement to the new composition exactly once", async () => {
    const app = projectedApp();
    const oldLoad = deferred<boolean>();
    const newLoad = deferred<boolean>();
    vi.spyOn((await import("@/index/IndexManager")).IndexManager.prototype, "load")
      .mockReturnValueOnce(oldLoad.promise)
      .mockReturnValueOnce(newLoad.promise);
    const plugin = projectedPlugin(app);
    await plugin.onload();
    const IndexManager = (await import("@/index/IndexManager")).IndexManager;
    const MaintenanceScheduler = (await import("@/index/MaintenanceScheduler"))
      .MaintenanceScheduler;
    vi.spyOn(MaintenanceScheduler.prototype, "checkPublication").mockResolvedValue({
      adopted: false,
      ignored: "missing",
    });
    const requestFullRecovery = vi.spyOn(IndexManager.prototype, "requestFullRecovery");
    const maintenanceInvalidate = vi.spyOn(MaintenanceScheduler.prototype, "invalidate");
    const oldIndex = (plugin as any).index;
    const oldMaintenance = (plugin as any).maintenance;
    const oldQueue = vi.spyOn(oldIndex, "requestFullRecovery");
    const oldInvalidate = vi.spyOn(oldMaintenance, "invalidate");
    const disposeMaintenance = vi.spyOn(oldMaintenance, "dispose");
    vi.spyOn(oldIndex, "dispose").mockResolvedValue(undefined);
    oldMaintenance.invalidate();

    const save = plugin.saveSettings({
      ...DEFAULT_SETTINGS,
      embedding: { ...DEFAULT_SETTINGS.embedding, modelId: "embed-next" },
    });
    await vi.waitFor(() => expect(disposeMaintenance).toHaveBeenCalledOnce());
    const emit = (event: string, ...args: any[]) => {
      for (const ref of app.listeners.filter((item) => item.active && item.event === event))
        ref.callback(...args);
    };
    emit("modify", { path: "Note.md" });
    expect(oldQueue).not.toHaveBeenCalled();
    expect(oldInvalidate).toHaveBeenCalledOnce();

    oldLoad.resolve(true);
    await save;
    const newIndex = (plugin as any).index;
    const newMaintenance = (plugin as any).maintenance;
    expect(newIndex).not.toBe(oldIndex);
    expect(
      requestFullRecovery.mock.contexts.filter((context) => context === newIndex)
    ).toHaveLength(1);
    expect(
      maintenanceInvalidate.mock.contexts.filter((context) => context === newMaintenance)
    ).toHaveLength(1);
    expect(newMaintenance.snapshot.pending).toBe(true);
    expect(plugin.getIndexStatus()?.kind).toBe("stale");
    newLoad.resolve(true);
    await (plugin as any).indexLoad;
    await vi.waitFor(() => expect(plugin.getIndexStatus()?.kind).toBe("stale"));
  });

  it("keeps a startup edit stale after the delayed index load completes", async () => {
    const app = projectedApp();
    const plugin = projectedPlugin(app);
    const load = deferred<boolean>();
    vi.spyOn((await import("@/index/IndexManager")).IndexManager.prototype, "load").mockReturnValue(
      load.promise
    );
    const MaintenanceScheduler = (await import("@/index/MaintenanceScheduler"))
      .MaintenanceScheduler;
    vi.spyOn(MaintenanceScheduler.prototype, "checkPublication").mockResolvedValue({
      adopted: false,
      ignored: "missing",
    });
    await plugin.onload();
    (plugin as any).maintenance.invalidate();
    load.resolve(true);
    await vi.waitFor(() => expect(plugin.getIndexStatus()?.kind).toBe("stale"));
  });
});
