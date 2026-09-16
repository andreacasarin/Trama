import { describe, expect, it, vi } from "vitest";
import { IndexStatusController } from "@/ui/index/IndexStatus";
import type { TramaDiagnosticRecord } from "@/diagnostics/TramaDiagnostics";

describe("lexical and semantic index actions", () => {
  it("exposes explicit palette commands for both rebuild channels", async () => {
    const commands: { id: string; name: string }[] = [];
    const rebuildSemantic = vi.fn(async () => undefined);
    const rebuildBoth = vi.fn(async () => undefined);
    const status = new IndexStatusController(
      { addCommand: (command: { id: string; name: string }) => commands.push(command) } as any,
      {
        index: async () => undefined,
        reindex: async () => undefined,
        prepare: async () => undefined,
        rebuildSemantic,
        rebuildBoth,
        cancel: () => undefined,
      }
    );
    status.setReady();
    status.register();

    expect(commands.map(({ name }) => name)).toEqual([
      "Update lexical index",
      "Rebuild lexical index",
      "Update semantic index",
      "Rebuild semantic index",
      "Rebuild lexical and semantic indexes",
      "Cancel lexical or semantic indexing",
    ]);
    await status.run("rebuild-semantic");
    await status.run("rebuild-both");
    expect(rebuildSemantic).toHaveBeenCalledOnce();
    expect(rebuildBoth).toHaveBeenCalledOnce();
  });

  it("retains lexical ETA when chunk and write progress alternate", () => {
    let now = 0;
    const status = new IndexStatusController(
      {} as any,
      {
        index: async () => undefined,
        reindex: async () => undefined,
        cancel: () => undefined,
      },
      undefined,
      {
        now: () => now,
        setTimeout: (callback) => setTimeout(callback, 0),
        clearTimeout: (timer) => clearTimeout(timer),
      }
    );
    status.setReady();
    status.setUpdating();
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

  it("reports a completed semantic run as completed even when newer notes are stale", async () => {
    let finish!: () => void;
    const events: TramaDiagnosticRecord[] = [];
    const status = new IndexStatusController(
      {} as any,
      {
        index: async () => undefined,
        reindex: async () => undefined,
        prepare: () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
        cancel: () => undefined,
      },
      { emit: (event) => events.push(event) }
    );
    status.setReady();
    const run = status.prepare();
    status.markStale(true, "Notes changed during semantic preparation.");
    finish();
    await run;
    expect(status.getStatus()).toMatchObject({
      kind: "stale",
      message: "Notes changed during semantic preparation.",
      canIndex: true,
    });
    expect(events).toContainEqual(expect.objectContaining({ stage: "user-completed" }));
  });
});
