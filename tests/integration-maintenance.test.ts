import { deferred } from "./test-helpers";
import { projectedApp, projectedPlugin, disposeProjectedPlugins } from "./plugin-fixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";
import { DEFAULT_SETTINGS } from "@/settings/Settings";

describe("TramaPlugin publication integration", () => {
  beforeEach(() => {
    Platform.isDesktopApp = true;
    vi.restoreAllMocks();
  });
  afterEach(async () => {
    await disposeProjectedPlugins();
    vi.restoreAllMocks();
  });
  it("publishes the lexical index with an empty embedding model and clears an old warning", async () => {
    const app = projectedApp();
    const MaintenanceScheduler = (await import("@/index/MaintenanceScheduler"))
      .MaintenanceScheduler;
    vi.spyOn(MaintenanceScheduler.prototype, "checkPublication").mockResolvedValue({
      adopted: false,
      ignored: "missing",
    });
    const settings = {
      ...DEFAULT_SETTINGS,
      embedding: { ...DEFAULT_SETTINGS.embedding, modelId: "  " },
    };
    const plugin = projectedPlugin(app, settings) as any;
    await plugin.onload();
    await plugin.indexLoad;
    const index = plugin.index;
    const semantic = vi.spyOn(index, "prepareSemantic");
    const publication = plugin.publicationManager;
    const publish = vi.spyOn(publication, "publish");
    const warning = {
      phase: "stage" as const,
      message: "offline",
      error: new Error("offline"),
      retryable: true,
    };
    publish.mockImplementationOnce(async () => {
      plugin.handlePublicationWarning(warning, "publication");
      return { published: false, warning };
    });
    await expect(plugin.maintenance.update()).rejects.toEqual(warning);
    expect(semantic).not.toHaveBeenCalled();
    expect(plugin.getIndexStatus().publicationWarning).toContain("offline");
    publish.mockResolvedValueOnce({ published: true });
    await plugin.maintenance.update();
    expect(plugin.getIndexStatus().publicationWarning).toBeUndefined();
  });

  it("publishes Update and Rebuild for an empty corpus with embeddings configured", async () => {
    const app = projectedApp();
    const MaintenanceScheduler = (await import("@/index/MaintenanceScheduler"))
      .MaintenanceScheduler;
    vi.spyOn(MaintenanceScheduler.prototype, "checkPublication").mockResolvedValue({
      adopted: false,
      ignored: "missing",
    });
    app.vault.getMarkdownFiles = () => [];
    const settings = {
      ...DEFAULT_SETTINGS,
      embedding: { ...DEFAULT_SETTINGS.embedding, modelId: "embed-v1" },
    };
    const plugin = projectedPlugin(app, settings) as any;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await plugin.onload();
    await plugin.indexLoad;
    const publish = vi.spyOn(plugin.publicationManager, "publish");

    await plugin.maintenance.update();
    expect(plugin.getIndexStatus()).toMatchObject({
      capabilities: {
        lexical: { state: "empty", searchable: false },
        semantic: { state: "empty", searchable: false },
      },
    });
    expect(plugin.getIndexStatus().publicationWarning).toBeUndefined();
    expect(publish).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();

    await plugin.maintenance.rebuild();
    expect(plugin.getIndexStatus()).toMatchObject({
      capabilities: {
        lexical: { state: "empty", searchable: false },
        semantic: { state: "empty", searchable: false },
      },
    });
    expect(plugin.getIndexStatus().publicationWarning).toBeUndefined();
    expect(publish).toHaveBeenCalledTimes(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps a queued background Check from reclassifying a deferred publication warning", async () => {
    const app = projectedApp();
    const settings = {
      ...DEFAULT_SETTINGS,
      embedding: { ...DEFAULT_SETTINGS.embedding, modelId: "  " },
    };
    const plugin = projectedPlugin(app, settings) as any;
    await plugin.onload();
    await plugin.indexLoad;
    await vi.waitFor(() => expect(plugin.maintenance.snapshot.lane).toBe("idle"));
    const publication = plugin.publicationManager;
    const pending = deferred<any>();
    const warning = {
      phase: "stage",
      message: "offline",
      error: new Error("offline"),
      retryable: true,
    };
    vi.spyOn(publication, "publish").mockImplementationOnce(async () => {
      await pending.promise;
      plugin.handlePublicationWarning(warning, "publication");
      return { published: false, warning };
    });
    const adoption = vi
      .spyOn(publication, "adoptCurrent")
      .mockResolvedValue({ adopted: false, ignored: "missing" });
    adoption.mockClear();
    const update = plugin.maintenance.update();
    await vi.waitFor(() => expect(plugin.maintenance.snapshot.phase).toBe("publication"));
    const check = plugin.checkPublication(false);
    pending.resolve(undefined);
    await Promise.all([expect(update).rejects.toEqual(warning), check]);
    expect(adoption).toHaveBeenCalled();
    expect(plugin.getIndexStatus().publicationWarning).toBe(
      "Search data saved locally, but sharing embeddings failed: offline"
    );
  });

  it("keeps publication and Check warning lifetimes independent", async () => {
    const plugin = projectedPlugin(projectedApp()) as any;
    await plugin.onload();
    await plugin.indexLoad;
    plugin.handlePublicationWarning(
      { phase: "stage", message: "publish offline", retryable: true },
      "publication"
    );
    plugin.handlePublicationWarning(
      { phase: "inspect", message: "invalid file", retryable: false },
      "check"
    );
    expect(plugin.getIndexStatus().publicationWarning).toBe(
      "Shared embeddings check failed: invalid file"
    );
    plugin.clearPublicationWarning("check");
    expect(plugin.getIndexStatus().publicationWarning).toBe(
      "Search data saved locally, but sharing embeddings failed: publish offline"
    );
    plugin.clearPublicationWarning("publication");
    expect(plugin.getIndexStatus().publicationWarning).toBeUndefined();
  });
});
