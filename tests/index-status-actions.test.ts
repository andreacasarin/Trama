import { createTestIndexStatus } from "./index-status-fixture";
import { describe, expect, it, vi } from "vitest";
import { IndexStatusController } from "@/ui/index/IndexStatus";
import type { TramaDiagnosticInput as TramaDiagnosticRecord } from "@/diagnostics/TramaDiagnostics";

const notices = vi.hoisted(() => [] as string[]);
vi.mock("obsidian", async (importOriginal) => ({
  ...(await importOriginal<typeof import("obsidian")>()),
  Notice: class {
    constructor(message: string) {
      notices.push(message);
    }
  },
}));

describe("index maintenance actions", () => {
  it("reports palette and Filo action failures without an unhandled rejection", async () => {
    notices.length = 0;
    const status = createTestIndexStatus({
      update: async () => {
        throw new Error("provider offline");
      },
      rebuild: async () => {
        throw new Error("storage unavailable");
      },
    });
    status.setReady();
    await expect(status.run("index")).resolves.toBeUndefined();
    await expect(status.run("reindex")).resolves.toBeUndefined();
    expect(notices).toEqual([
      "Trama index update failed: provider offline",
      "Trama index rebuild failed: storage unavailable",
    ]);
  });

  it.each(["lexical", "semantic", "publication"])(
    "allows manual commands to supersede active %s work",
    async (phase) => {
      const update = vi.fn(async () => undefined);
      const rebuild = vi.fn(async () => undefined);
      const status = createTestIndexStatus({
        update,
        rebuild,
      });
      status.setMaintenance({ lane: "automatic", phase, pending: true, suspended: false });
      await status.run("index");
      await status.run("reindex");
      expect(update).toHaveBeenCalledOnce();
      expect(rebuild).toHaveBeenCalledOnce();
    }
  );

  it("keeps semantic failure attribution through publication and accepts newer batch progress", () => {
    const status = createTestIndexStatus();
    status.setMaintenance({ lane: "update", phase: "semantic", pending: true, suspended: false });
    const progress = {
      operation: "incremental" as const,
      phase: "build-vector" as const,
      completed: 1,
      total: 3,
      unit: "chunks" as const,
      determinate: true,
      changeCounter: 1,
    };
    status.reportProgress(progress);
    status.reportProgress({ ...progress, changeCounter: 2, completed: 2 });
    expect(status.getStatus().progress?.completed).toBe(2);
    status.reportProgress({ ...progress, changeCounter: 1, completed: 3 });
    expect(status.getStatus().progress?.completed).toBe(2);
    status.setMaintenance({
      lane: "update",
      phase: "publication",
      pending: true,
      suspended: false,
    });
    status.setMaintenance({
      lane: "idle",
      pending: true,
      suspended: false,
      error: new Error("provider offline"),
    });
    expect(status.getStatus()).toMatchObject({ kind: "error", channel: "semantic" });
  });

  it("routes Clear local search data and shared embeddings through the shared action", () => {
    const commands: { id: string; callback?: () => void }[] = [];
    const clearShared = vi.fn(async () => undefined);
    const status = new IndexStatusController(
      {
        addCommand: (command: { id: string; callback?: () => void }) => commands.push(command),
      } as any,
      {
        update: async () => undefined,
        rebuild: async () => undefined,
        reset: async () => undefined,
        clearShared,
        stop: () => undefined,
      }
    );
    status.register();
    commands.find(({ id }) => id === "clear-indexes-and-shared-cache")?.callback?.();
    expect(clearShared).toHaveBeenCalledOnce();
  });

  it("exposes Update, Rebuild, Reset, and Stop commands", async () => {
    const commands: { id: string; name: string; callback?: () => void }[] = [];
    const update = vi.fn(async () => undefined);
    const rebuild = vi.fn(async () => undefined);
    const reset = vi.fn(async () => undefined);
    const share = vi.fn(async () => undefined);
    const importShared = vi.fn(async () => undefined);
    const status = new IndexStatusController(
      {
        addCommand: (command: { id: string; name: string; callback?: () => void }) =>
          commands.push(command),
      } as any,
      {
        update,
        rebuild,
        reset,
        share,
        importShared,
        stop: () => undefined,
      }
    );
    status.setReady();
    status.register();

    expect(commands.map(({ name }) => name)).toEqual([
      "Update search indexes",
      "Clear local search data and shared embeddings",
      "Rebuild embeddings",
      "Reset local search data",
      "Share embeddings",
      "Import shared embeddings",
      "Stop index maintenance",
    ]);
    commands.find(({ id }) => id === "publish-embeddings")?.callback?.();
    commands.find(({ id }) => id === "import-shared-embeddings")?.callback?.();
    expect(share).toHaveBeenCalledOnce();
    expect(importShared).toHaveBeenCalledOnce();
    await status.run("reindex");
    expect(rebuild).toHaveBeenCalledOnce();
    commands.find(({ id }) => id === "reset-all-indexes")?.callback?.();
    expect(reset).toHaveBeenCalledOnce();
    expect(commands.map(({ id }) => id)).not.toContain("prepare-semantic-index");
  });

  it("handles reset rejection and shows the failure detail", async () => {
    notices.length = 0;
    const commands: { id: string; callback?: () => void }[] = [];
    const status = new IndexStatusController(
      {
        addCommand: (command: { id: string; callback?: () => void }) => commands.push(command),
      } as any,
      {
        update: async () => undefined,
        rebuild: async () => undefined,
        reset: () => Promise.reject(new Error("Index maintenance is active; retry reset.")),
        stop: () => undefined,
      }
    );
    status.register();

    commands.find(({ id }) => id === "reset-all-indexes")?.callback?.();
    await vi.waitFor(() =>
      expect(notices).toEqual([
        "Trama index reset failed: Index maintenance is active; retry reset.",
      ])
    );
  });

  it("retains lexical ETA when chunk and write progress alternate", () => {
    let now = 0;
    const status = new IndexStatusController(
      {} as any,
      {
        update: async () => undefined,
        rebuild: async () => undefined,
        reset: async () => undefined,
        stop: () => undefined,
      },
      undefined,
      {
        now: () => now,
        setTimeout: (callback) => setTimeout(callback, 0),
        clearTimeout: (timer) => clearTimeout(timer),
      }
    );
    status.setReady();
    status.setMaintenance({ lane: "update", phase: "lexical", pending: false, suspended: false });
    status.reportProgress({
      operation: "full",
      phase: "chunk",
      completed: 0,
      total: 100,
      unit: "texts",
      determinate: true,
    });
    now = 1000;
    status.reportProgress({
      operation: "full",
      phase: "encode-write",
      completed: 0,
      total: 10,
      unit: "notes",
      determinate: true,
    });
    now = 2000;
    status.reportProgress({
      operation: "full",
      phase: "chunk",
      completed: 50,
      total: 100,
      unit: "texts",
      determinate: true,
    });
    expect(status.getStatus().message).toBe(
      "Chunking lexical index — 50 of 100 texts · about 2 sec remaining"
    );
    now = 3000;
    status.reportProgress({
      operation: "full",
      phase: "encode-write",
      completed: 5,
      total: 10,
      unit: "notes",
      determinate: true,
    });
    expect(status.getStatus().message).toBe(
      "Writing lexical index — 5 of 10 notes · about 2 sec remaining"
    );
  });

  it("keeps stale status during a manual update", async () => {
    const events: TramaDiagnosticRecord[] = [];
    const update = vi.fn(async () => undefined);
    const status = new IndexStatusController(
      {} as any,
      {
        update,
        rebuild: async () => undefined,
        reset: async () => undefined,
        stop: () => undefined,
      },
      { enabled: () => true, emit: (event) => events.push(event) }
    );
    status.setReady();
    const run = status.run("index");
    status.markStale(true, "Notes changed during manual update.");
    await run;
    expect(status.getStatus()).toMatchObject({
      kind: "stale",
      message: "Notes changed during manual update.",
      canIndex: true,
    });
    expect(events).toContainEqual(
      expect.objectContaining({ event: "index_status", status: "stale" })
    );
  });

  it("projects idle pending work as stale even when automatic maintenance is enabled", () => {
    const status = createTestIndexStatus();
    status.setReady();
    status.setMaintenance({ lane: "idle", pending: true, suspended: false });
    expect(status.getStatus()).toMatchObject({ kind: "stale", canIndex: true });
  });

  it("prioritizes an idle maintenance error over pending changes", () => {
    const status = createTestIndexStatus();
    status.setReady();
    status.setMaintenance({ lane: "update", pending: true, suspended: false });
    status.setMaintenance({
      lane: "idle",
      pending: true,
      suspended: true,
      error: new Error("disk failure"),
    });
    expect(status.getStatus()).toMatchObject({
      kind: "error",
      message: "disk failure",
      canIndex: true,
    });
    status.setMaintenance({
      lane: "idle",
      pending: true,
      suspended: false,
      error: new Error("disk failure"),
    });
    expect(status.getStatus()).toMatchObject({
      kind: "error",
      message: "disk failure",
      canIndex: true,
    });
  });

  it("projects the unified semantic phase and Stop capability", () => {
    const status = createTestIndexStatus();
    status.setReady();
    status.setMaintenance({
      lane: "automatic",
      phase: "semantic",
      pending: true,
      suspended: false,
    });
    expect(status.getStatus()).toMatchObject({
      kind: "preparing",
      channel: "semantic",
      canCancel: true,
    });
    status.setMaintenance({ lane: "idle", pending: true, suspended: true });
    expect(status.getStatus()).toMatchObject({ kind: "cancelled", canCancel: false });
  });

  it("shows Stop suspension before pending stale state", () => {
    const status = createTestIndexStatus();
    status.setReady();
    status.setMaintenance({ lane: "update", pending: true, suspended: false });
    status.setMaintenance({ lane: "idle", pending: true, suspended: true });
    expect(status.getStatus()).toMatchObject({
      kind: "cancelled",
      message: "Index maintenance stopped.",
      canIndex: true,
    });
  });

  it("shows Stop when edits are only waiting for the automatic quiet period", () => {
    const status = createTestIndexStatus();
    status.setReady();
    status.setMaintenance({ lane: "idle", pending: true, suspended: true });
    expect(status.getStatus()).toMatchObject({
      kind: "cancelled",
      message: "Index maintenance stopped.",
    });
  });

  it("keeps manual actions available during a cache check and acknowledges a queued click", async () => {
    const update = vi.fn(async () => undefined);
    const status = createTestIndexStatus({
      update,
    });
    status.setMaintenance({ lane: "adoption", pending: false, suspended: false });
    await status.run("index");
    expect(update).toHaveBeenCalledOnce();
    status.setMaintenance({ lane: "adoption", phase: "queued", pending: true, suspended: false });
    expect(status.getStatus().message).toBe(
      "Search update queued; finishing the current shared embeddings import…"
    );
  });

  it("shows Check activity and projects an empty lexical index on completion", () => {
    const status = createTestIndexStatus();
    status.setCapabilities({
      availability: "available",
      lexical: { state: "empty", activity: "idle", searchable: false },
      semantic: { state: "empty", activity: "idle", searchable: false },
      freshness: "locally-reconciled",
    });
    status.setMaintenance({ lane: "adoption", pending: false, suspended: false });
    expect(status.getStatus()).toMatchObject({
      kind: "stale",
      message: "Importing shared embeddings…",
      canIndex: true,
      canReindex: true,
    });
    status.setMaintenance({ lane: "idle", pending: false, suspended: false });
    expect(status.getStatus()).toMatchObject({ kind: "empty", canIndex: true });
  });

  it.each(["missing", "same-id"] as const)(
    "restores the capability status after an ignored synchronized index check (%s)",
    () => {
      const status = createTestIndexStatus();
      status.setCapabilities({
        availability: "available",
        lexical: { state: "ready", activity: "idle", searchable: true },
        semantic: { state: "empty", activity: "idle", searchable: false },
        freshness: "locally-reconciled",
      });
      status.setMaintenance({ lane: "adoption", pending: false, suspended: false });
      expect(status.getStatus().message).toBe("Importing shared embeddings…");
      status.setMaintenance({ lane: "idle", pending: false, suspended: false });
      expect(status.getStatus()).toMatchObject({ kind: "ready", message: undefined });
    }
  );
});
