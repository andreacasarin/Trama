import { describe, expect, it, vi } from "vitest";
import { IndexStatusController } from "@/ui/index/IndexStatus";
import type { TramaDiagnosticInput as TramaDiagnosticRecord } from "@/diagnostics/TramaDiagnostics";

describe("index maintenance actions", () => {
  it("exposes only Update, Rebuild, and Stop commands", async () => {
    const commands: { id: string; name: string }[] = [];
    const update = vi.fn(async () => undefined);
    const rebuild = vi.fn(async () => undefined);
    const status = new IndexStatusController(
      { addCommand: (command: { id: string; name: string }) => commands.push(command) } as any,
      {
        update,
        rebuild,
        stop: () => undefined,
      }
    );
    status.setReady();
    status.register();

    expect(commands.map(({ name }) => name)).toEqual([
      "Update index",
      "Rebuild index",
      "Stop index maintenance",
    ]);
    await status.run("reindex");
    expect(rebuild).toHaveBeenCalledOnce();
    expect(commands.map(({ id }) => id)).not.toContain("prepare-semantic-index");
  });

  it("retains lexical ETA when chunk and write progress alternate", () => {
    let now = 0;
    const status = new IndexStatusController(
      {} as any,
      {
        update: async () => undefined,
        rebuild: async () => undefined,
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
    const status = new IndexStatusController({} as any, {
      update: async () => undefined,
      rebuild: async () => undefined,
      stop: () => undefined,
    });
    status.setReady();
    status.setMaintenance({ lane: "idle", pending: true, suspended: false });
    expect(status.getStatus()).toMatchObject({ kind: "stale", canIndex: true });
  });

  it("prioritizes an idle maintenance error over pending changes", () => {
    const status = new IndexStatusController({} as any, {
      update: async () => undefined,
      rebuild: async () => undefined,
      stop: () => undefined,
    });
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
    const status = new IndexStatusController({} as any, {
      update: async () => undefined,
      rebuild: async () => undefined,
      stop: () => undefined,
    });
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
    const status = new IndexStatusController({} as any, {
      update: async () => undefined,
      rebuild: async () => undefined,
      stop: () => undefined,
    });
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
    const status = new IndexStatusController({} as any, {
      update: async () => undefined,
      rebuild: async () => undefined,
      stop: () => undefined,
    });
    status.setReady();
    status.setMaintenance({ lane: "idle", pending: true, suspended: true });
    expect(status.getStatus()).toMatchObject({
      kind: "cancelled",
      message: "Index maintenance stopped.",
    });
  });

  it("shows Check activity and projects an empty lexical index on completion", () => {
    const status = new IndexStatusController({} as any, {
      update: async () => undefined,
      rebuild: async () => undefined,
      stop: () => undefined,
    });
    status.setCapabilities({
      availability: "available",
      lexical: { state: "empty", activity: "idle", searchable: false },
      semantic: { state: "empty", activity: "idle", searchable: false },
      freshness: "locally-reconciled",
    });
    status.setMaintenance({ lane: "adoption", pending: false, suspended: false });
    expect(status.getStatus()).toMatchObject({
      kind: "preparing",
      message: "Checking synchronized index…",
    });
    status.setMaintenance({ lane: "idle", pending: false, suspended: false });
    expect(status.getStatus()).toMatchObject({ kind: "empty", canIndex: true });
  });

  it.each(["missing", "same-id"] as const)(
    "restores the capability status after an ignored synchronized index check (%s)",
    () => {
      const status = new IndexStatusController({} as any, {
        update: async () => undefined,
        rebuild: async () => undefined,
        stop: () => undefined,
      });
      status.setCapabilities({
        availability: "available",
        lexical: { state: "ready", activity: "idle", searchable: true },
        semantic: { state: "empty", activity: "idle", searchable: false },
        freshness: "locally-reconciled",
      });
      status.setMaintenance({ lane: "adoption", pending: false, suspended: false });
      expect(status.getStatus().message).toBe("Checking synchronized index…");
      status.setMaintenance({ lane: "idle", pending: false, suspended: false });
      expect(status.getStatus()).toMatchObject({ kind: "ready", message: undefined });
    }
  );
});
