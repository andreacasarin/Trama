import { describe, expect, it, vi } from "vitest";
import {
  MaintenanceScheduler,
  type MaintenanceClock,
  type MaintenancePort,
} from "@/index/MaintenanceScheduler";
import type { SemanticPrepareResult } from "@/index/IndexManager";
import type { PublicationResult, AdoptionResult } from "@/index/publications/PublicationManager";

function fixture(semanticConfigured = true) {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: MaintenanceClock = {
    now: () => now,
    setTimeout: (callback, delay) => {
      const id = ++nextId;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  };
  async function advance(ms: number) {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at;
      timers.delete(due[0]);
      due[1].callback();
      for (let turn = 0; turn < 8; turn++) await Promise.resolve();
    }
    now = target;
  }
  const lexical = vi.fn(async (_signal: AbortSignal) => ({ changed: false, converged: true }));
  const semantic = vi.fn(
    async (_signal: AbortSignal, _shouldYield?: () => boolean): Promise<SemanticPrepareResult> => ({
      operation: "prepare",
      changed: false,
      converged: true,
      stored: 0,
      skipped: 0,
      state: {} as never,
    })
  );
  const semanticRebuild = vi.fn(async (_signal: AbortSignal): Promise<SemanticPrepareResult> => ({
    operation: "rebuild",
    changed: true,
    converged: true,
    stored: 4,
    skipped: 0,
    state: {} as never,
  }));
  const rebuild = vi.fn(async (_signal: AbortSignal) => ({
    operation: "rebuild" as const,
    changed: false,
    converged: true,
    state: {} as never,
  }));
  const publish = vi.fn(async () => ({ published: true }) as PublicationResult);
  const adopt = vi.fn(
    async () => ({ adopted: false, ignored: "missing" as const }) as AdoptionResult
  );
  const port: MaintenancePort = {
    semanticConfigured,
    synchronize: lexical,
    prepareSemantic: semantic,
    rebuildSemantic: semanticRebuild,
    rebuild,
    publish,
    adoptCurrent: adopt,
  };
  const controller = new MaintenanceScheduler(port, { clock });
  const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };
  return {
    controller,
    clock,
    timers,
    advance,
    lexical,
    semantic,
    semanticRebuild,
    rebuild,
    publish,
    adopt,
    settle,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("MaintenanceScheduler", () => {
  it("escalates quiet delays 3→9→20 seconds once per invalidated automatic attempt", async () => {
    const f = fixture();
    f.controller.setAutomaticEnabled(true);
    f.controller.invalidate();
    expect([...f.timers.values()][0].at).toBe(3_000);
    let finish!: (value: { changed: boolean; converged: boolean }) => void;
    f.lexical.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    await f.advance(3_000);
    expect(f.lexical).toHaveBeenCalledTimes(1);
    f.controller.invalidate();
    finish({ changed: true, converged: false });
    await f.settle();
    expect([...f.timers.values()][0].at).toBe(12_000);
    f.lexical.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    await f.advance(9_000);
    expect(f.lexical).toHaveBeenCalledTimes(2);
    f.controller.invalidate();
    finish({ changed: true, converged: false });
    await f.settle();
    expect([...f.timers.values()][0].at).toBe(32_000);
    await f.advance(20_000);
    expect(f.lexical).toHaveBeenCalledTimes(3);
    expect(f.controller.snapshot.pending).toBe(false);
    f.controller.invalidate();
    expect([...f.timers.values()][0].at).toBe(35_000);
  });

  it("starts by the 60 second deadline during continuous edits and resets escalation on convergence", async () => {
    const f = fixture();
    f.controller.setAutomaticEnabled(true);
    f.controller.invalidate();
    for (let i = 0; i < 29; i++) {
      await f.advance(2_000);
      f.controller.invalidate();
    }
    await f.advance(2_000);
    expect(f.lexical).toHaveBeenCalled();
    expect(f.controller.snapshot.pending).toBe(false);
    f.controller.invalidate();
    expect([...f.timers.values()][0].at).toBe(63_000);
  });

  it("skips automatic publication when reconciliation makes no changes", async () => {
    const f = fixture();
    f.controller.setAutomaticEnabled(true);
    f.controller.invalidate();

    await f.advance(3_000);

    expect(f.controller.snapshot.pending).toBe(false);
    expect(f.publish).not.toHaveBeenCalled();
  });

  it("publishes an unchanged index when the synchronized file is missing", async () => {
    const f = fixture();
    f.controller.setAutomaticEnabled(true);
    f.controller.invalidate(true);

    await f.advance(3_000);

    expect(f.controller.snapshot.pending).toBe(false);
    expect(f.publish).toHaveBeenCalledOnce();
  });

  it("bypasses delay for explicit update, serializes lanes, and publishes only converged work", async () => {
    const f = fixture();
    let release!: (value: { changed: boolean; converged: boolean }) => void;
    f.lexical.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const run = f.controller.update();
    await f.settle();
    expect(f.controller.snapshot.lane).toBe("update");
    expect(f.controller.checkPublication).toBeDefined();
    release({ changed: true, converged: false });
    await run;
    expect(f.lexical).toHaveBeenCalledTimes(2);
    expect(f.publish).toHaveBeenCalledOnce();
  });

  it("continues explicit lexical and configured semantic passes until both converge with automation off", async () => {
    const f = fixture();
    f.lexical
      .mockResolvedValueOnce({ changed: true, converged: false })
      .mockResolvedValueOnce({ changed: true, converged: true });
    f.semantic
      .mockResolvedValueOnce({
        operation: "prepare",
        changed: true,
        converged: false,
        stored: 0,
        skipped: 0,
        state: {} as never,
      })
      .mockResolvedValueOnce({
        operation: "prepare",
        changed: true,
        converged: true,
        stored: 0,
        skipped: 0,
        state: {} as never,
      });
    await f.controller.update();
    expect(f.lexical).toHaveBeenCalledTimes(2);
    expect(f.semantic).toHaveBeenCalledTimes(2);
    expect(f.publish).toHaveBeenCalledOnce();
    expect(f.controller.snapshot.pending).toBe(false);
  });

  it("publishes explicit work when the configured semantic phase has no work", async () => {
    const f = fixture();
    f.semantic.mockResolvedValueOnce({
      operation: "prepare",
      changed: false,
      converged: true,
      stored: 0,
      skipped: 0,
      state: { chunkCount: 0, semanticReady: false } as never,
    });

    await f.controller.update();

    expect(f.semantic).toHaveBeenCalledOnce();
    expect(f.publish).toHaveBeenCalledOnce();
    expect(f.controller.snapshot.pending).toBe(false);
  });

  it("Stop aborts a repeated explicit pass and prevents publication", async () => {
    const f = fixture();
    const secondPass = deferred<{ changed: boolean; converged: boolean }>();
    let signal!: AbortSignal;
    f.lexical.mockResolvedValueOnce({ changed: true, converged: false });
    f.lexical.mockImplementationOnce((received) => {
      signal = received;
      return secondPass.promise;
    });
    const update = f.controller.update();
    await vi.waitFor(() => expect(f.lexical).toHaveBeenCalledTimes(2));
    f.controller.stop();
    expect(signal.aborted).toBe(true);
    secondPass.resolve({ changed: true, converged: false });
    await update;
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.controller.snapshot.pending).toBe(true);
  });

  it("skips semantic work when no model is configured and publishes the lexical result", async () => {
    const f = fixture(false);
    await f.controller.update();
    expect(f.semantic).not.toHaveBeenCalled();
    expect(f.semanticRebuild).not.toHaveBeenCalled();
    expect(f.publish).toHaveBeenCalledOnce();
    expect(f.controller.snapshot.pending).toBe(false);
  });

  it("rebuilds configured semantic vectors once after lexical convergence", async () => {
    const f = fixture();
    f.rebuild.mockResolvedValueOnce({
      operation: "rebuild",
      changed: true,
      converged: false,
      state: {} as never,
    });
    await f.controller.rebuild();
    expect(f.rebuild).toHaveBeenCalledTimes(2);
    expect(f.semanticRebuild).toHaveBeenCalledOnce();
    expect(f.semantic).not.toHaveBeenCalled();
    expect(f.publish).toHaveBeenCalledOnce();
  });

  it("resumes incremental semantic preparation after an edit during semantic rebuild", async () => {
    const f = fixture();
    const rebuildSemantic = deferred<SemanticPrepareResult>();
    f.semanticRebuild.mockImplementationOnce(() => rebuildSemantic.promise);
    const rebuilding = f.controller.rebuild();
    await vi.waitFor(() => expect(f.semanticRebuild).toHaveBeenCalledOnce());
    f.controller.invalidate();
    rebuildSemantic.resolve({
      operation: "rebuild",
      changed: true,
      converged: true,
      stored: 4,
      skipped: 0,
      state: {} as never,
    });
    await rebuilding;
    expect(f.semanticRebuild).toHaveBeenCalledOnce();
    expect(f.semantic).toHaveBeenCalledOnce();
    expect(f.publish).toHaveBeenCalledOnce();
  });

  it("keeps adoption behind an active lane and suspends on publication failure", async () => {
    const f = fixture();
    let release!: (value: { changed: boolean; converged: boolean }) => void;
    f.lexical.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const update = f.controller.update();
    await f.settle();
    const adoption = f.controller.checkPublication();
    expect(f.adopt).not.toHaveBeenCalled();
    release({ changed: true, converged: true });
    await update;
    await adoption;
    f.publish.mockResolvedValueOnce({
      published: false,
      warning: { phase: "stage", message: "offline", error: new Error("offline"), retryable: true },
    });
    f.controller.invalidate();
    await expect(f.controller.update()).rejects.toMatchObject({ phase: "stage" });
    expect(f.controller.snapshot.suspended).toBe(true);
    expect(f.controller.snapshot.pending).toBe(true);
  });

  it("rechecks between phases and retains resumable semantic work after a nonconverged yield", async () => {
    const f = fixture();
    f.controller.setAutomaticEnabled(true);
    f.controller.invalidate();
    let finish!: (value: { changed: boolean; converged: boolean }) => void;
    f.lexical.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    await f.advance(3_000);
    f.controller.invalidate();
    finish({ changed: true, converged: true });
    await f.settle();
    expect(f.semantic).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
    f.lexical.mockResolvedValueOnce({ changed: false, converged: true });
    f.semantic.mockResolvedValueOnce({
      operation: "prepare",
      changed: true,
      converged: false,
      stored: 4,
      skipped: 0,
      state: {} as never,
    });
    await f.advance(9_000);
    expect(f.semantic).toHaveBeenCalledTimes(1);
    expect(f.publish).not.toHaveBeenCalled();
    f.semantic.mockResolvedValueOnce({
      operation: "prepare",
      changed: true,
      converged: true,
      stored: 2,
      skipped: 0,
      state: {} as never,
    });
    f.controller.invalidate();
    await f.advance(9_000);
    expect(f.publish).toHaveBeenCalledTimes(1);
  });

  it("Stop aborts supported work, preserves pending state, and explicit action re-arms", async () => {
    const f = fixture();
    let signal!: AbortSignal;
    let finish!: (value: { changed: boolean; converged: boolean }) => void;
    f.lexical.mockImplementationOnce((received) => {
      signal = received;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    f.controller.setAutomaticEnabled(true);
    f.controller.invalidate();
    await f.advance(3_000);
    expect(f.controller.snapshot.lane).toBe("automatic");
    f.controller.invalidate();
    f.controller.stop();
    expect(signal.aborted).toBe(true);
    expect(f.controller.snapshot.suspended).toBe(true);
    finish({ changed: true, converged: false });
    await f.settle();
    expect(f.controller.snapshot.pending).toBe(true);
    await f.controller.update();
    expect(f.controller.snapshot.suspended).toBe(false);
  });

  it("dispose waits for deferred semantic work and cancels queued explicit and adoption requests", async () => {
    const f = fixture();
    const semantic = deferred<Awaited<ReturnType<MaintenancePort["prepareSemantic"]>>>();
    let signal!: AbortSignal;
    f.semantic.mockImplementationOnce((received) => {
      signal = received;
      return semantic.promise;
    });
    const preparing = f.controller.update();
    await f.settle();
    const queuedUpdate = f.controller.update();
    const queuedCheck = f.controller.checkPublication();
    const disposing = f.controller.dispose();
    expect(signal.aborted).toBe(true);
    await queuedUpdate;
    let disposed = false;
    void disposing.then(() => {
      disposed = true;
    });
    await f.settle();
    expect(disposed).toBe(false);
    semantic.resolve({
      operation: "prepare",
      changed: false,
      converged: true,
      stored: 0,
      skipped: 0,
      state: {} as never,
    });
    await Promise.all([preparing, disposing]);
    await expect(queuedCheck).resolves.toEqual({ adopted: false, ignored: "missing" });
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.lexical).toHaveBeenCalledOnce();
    expect(f.adopt).not.toHaveBeenCalled();
    await f.controller.update();
    expect(f.lexical).toHaveBeenCalledOnce();
  });

  it("dispose waits for an active adoption fence", async () => {
    const f = fixture();
    const adoption = deferred<Awaited<ReturnType<MaintenancePort["adoptCurrent"]>>>();
    f.adopt.mockImplementationOnce(() => adoption.promise);
    const checking = f.controller.checkPublication();
    await f.settle();
    const disposing = f.controller.dispose();
    let disposed = false;
    void disposing.then(() => {
      disposed = true;
    });
    await f.settle();
    expect(disposed).toBe(false);
    adoption.resolve({ adopted: true });
    await Promise.all([checking, disposing]);
    expect(f.adopt).toHaveBeenCalledTimes(1);
    expect(f.lexical).not.toHaveBeenCalled();
  });

  it("dispose waits for a publication already inside the active lane", async () => {
    const f = fixture();
    const publication = deferred<Awaited<ReturnType<MaintenancePort["publish"]>>>();
    let publishStarted!: () => void;
    const started = new Promise<void>((resolve) => (publishStarted = resolve));
    f.publish.mockImplementationOnce(() => {
      publishStarted();
      return publication.promise;
    });
    const update = f.controller.update();
    await started;
    const disposing = f.controller.dispose();
    let disposed = false;
    void disposing.then(() => {
      disposed = true;
    });
    await f.settle();
    expect(disposed).toBe(false);
    publication.resolve({ published: true });
    await Promise.all([update, disposing]);
    expect(f.publish).toHaveBeenCalledOnce();
    await f.controller.update();
    expect(f.lexical).toHaveBeenCalledOnce();
  });

  it("dispose clears a pending automatic timer and rejects all later starts", async () => {
    const f = fixture();
    f.controller.setAutomaticEnabled(true);
    f.controller.invalidate();
    expect(f.timers.size).toBe(1);
    await f.controller.dispose();
    f.controller.invalidate();
    f.controller.setAutomaticEnabled(true);
    await f.controller.update();
    await f.controller.checkPublication();
    await f.advance(60_000);
    expect(f.timers.size).toBe(0);
    expect(f.lexical).not.toHaveBeenCalled();
    expect(f.adopt).not.toHaveBeenCalled();
  });

  it("suspends after failure without a retry timer; enabling automation re-arms", async () => {
    const f = fixture();
    f.controller.setAutomaticEnabled(true);
    f.lexical.mockRejectedValueOnce(new Error("offline"));
    f.controller.invalidate();
    await f.advance(3_000);
    expect(f.controller.snapshot.suspended).toBe(true);
    expect(f.timers.size).toBe(0);
    f.controller.setAutomaticEnabled(false);
    f.controller.setAutomaticEnabled(true);
    expect(f.timers.size).toBe(1);
  });

  it("fences a compatible or absent publication check without republishing", async () => {
    const f = fixture();
    await f.controller.checkPublication();
    expect(f.adopt).toHaveBeenCalledTimes(1);
    expect(f.lexical).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });

  it("retries publication without repeating index maintenance", async () => {
    const f = fixture();

    await f.controller.publishCurrent();

    expect(f.publish).toHaveBeenCalledOnce();
    expect(f.lexical).not.toHaveBeenCalled();
    expect(f.semantic).not.toHaveBeenCalled();
  });

  it("converges and replaces a non-newer incompatible synchronized index", async () => {
    const f = fixture();
    f.adopt.mockResolvedValueOnce({ adopted: false, replacementRequired: true });

    await expect(f.controller.checkPublication()).resolves.toEqual({ adopted: false });
    expect(f.lexical).toHaveBeenCalledOnce();
    expect(f.semantic).toHaveBeenCalledOnce();
    expect(f.publish).toHaveBeenCalledOnce();
  });

  it("does not replace an incompatible synchronized index when convergence fails", async () => {
    const f = fixture();
    f.adopt.mockResolvedValueOnce({ adopted: false, replacementRequired: true });
    f.lexical.mockRejectedValueOnce(new Error("offline"));

    await expect(f.controller.checkPublication()).rejects.toThrow("offline");
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.controller.snapshot.suspended).toBe(true);
  });

  it("reschedules internal automatic nonconvergence from pass completion", async () => {
    const f = fixture();
    f.controller.setAutomaticEnabled(true);
    f.controller.invalidate();
    f.semantic.mockResolvedValueOnce({
      operation: "prepare",
      changed: true,
      converged: false,
      stored: 0,
      skipped: 0,
      state: {} as never,
    });
    await f.advance(3_000);
    expect(f.controller.snapshot.pending).toBe(true);
    expect([...f.timers.values()][0].at).toBe(6_000);
    await f.advance(2_999);
    expect(f.lexical).toHaveBeenCalledOnce();
    await f.advance(1);
    expect(f.lexical).toHaveBeenCalledTimes(2);
  });

  it("yields automatic semantic work at a committed batch boundary for queued explicit work", async () => {
    const f = fixture();
    const semanticBatch = deferred<void>();
    const order: string[] = [];
    f.lexical.mockImplementation(async () => {
      order.push("lexical");
      return { changed: false, converged: true };
    });
    f.semantic.mockImplementationOnce(async (_signal, shouldYield) => {
      order.push("automatic-semantic-batch");
      await semanticBatch.promise;
      return {
        operation: "prepare",
        changed: true,
        converged: !shouldYield?.(),
        stored: 1,
        skipped: 0,
        state: {} as never,
      };
    });
    f.semantic.mockImplementationOnce(async () => {
      order.push("explicit-semantic");
      return {
        operation: "prepare",
        changed: true,
        converged: true,
        stored: 1,
        skipped: 0,
        state: {} as never,
      };
    });
    f.controller.setAutomaticEnabled(true);
    f.controller.invalidate();
    await f.advance(3_000);
    await vi.waitFor(() => expect(f.semantic).toHaveBeenCalledOnce());
    const update = f.controller.update();
    semanticBatch.resolve();
    await update;
    expect(order).toEqual(["lexical", "automatic-semantic-batch", "lexical", "explicit-semantic"]);
    expect(f.publish).toHaveBeenCalledOnce();
  });

  it("yields explicit semantic work at a committed batch boundary to the next explicit request", async () => {
    const f = fixture();
    const semanticBatch = deferred<void>();
    const order: string[] = [];
    f.lexical.mockImplementation(async () => {
      order.push("update-lexical");
      return { changed: false, converged: true };
    });
    f.rebuild.mockImplementation(async () => {
      order.push("rebuild-lexical");
      return {
        operation: "rebuild",
        changed: false,
        converged: true,
        state: {} as never,
      };
    });
    f.semantic.mockImplementationOnce(async (_signal, shouldYield) => {
      order.push("update-semantic-batch");
      await semanticBatch.promise;
      return {
        operation: "prepare",
        changed: true,
        converged: !shouldYield?.(),
        stored: 1,
        skipped: 0,
        state: {} as never,
      };
    });
    f.semantic.mockImplementationOnce(async () => {
      order.push("resumed-update-semantic");
      return {
        operation: "prepare",
        changed: true,
        converged: true,
        stored: 1,
        skipped: 0,
        state: {} as never,
      };
    });

    const update = f.controller.update();
    await vi.waitFor(() => expect(f.semantic).toHaveBeenCalledOnce());
    const rebuild = f.controller.rebuild();
    semanticBatch.resolve();
    await Promise.all([update, rebuild]);

    expect(order).toEqual([
      "update-lexical",
      "update-semantic-batch",
      "rebuild-lexical",
      "update-lexical",
      "resumed-update-semantic",
    ]);
    expect(f.publish).toHaveBeenCalledTimes(2);
  });

  it("retains an edit made while publication is settling and repeats the explicit pass", async () => {
    const f = fixture();
    const publication = deferred<PublicationResult>();
    f.publish.mockImplementationOnce(() => publication.promise);
    const update = f.controller.update();
    await f.settle();
    expect(f.controller.snapshot.phase).toBe("publication");
    f.controller.invalidate();
    publication.resolve({ published: true });
    await update;
    expect(f.lexical).toHaveBeenCalledTimes(2);
    expect(f.semantic).toHaveBeenCalledTimes(2);
    expect(f.publish).toHaveBeenCalledTimes(2);
    expect(f.controller.snapshot.pending).toBe(false);
  });

  it("runs an explicit request queued before an automatic failure without retrying automatically", async () => {
    const f = fixture();
    const started = deferred<void>();
    const failedAutomatic = deferred<{ changed: boolean; converged: boolean }>();
    f.lexical.mockImplementationOnce(() => {
      started.resolve();
      return failedAutomatic.promise;
    });
    f.controller.setAutomaticEnabled(true);
    f.controller.invalidate();
    await f.advance(3_000);
    await started.promise;
    const explicit = f.controller.update();
    failedAutomatic.reject(new Error("offline"));
    await explicit;
    expect(f.lexical).toHaveBeenCalledTimes(2);
    expect(f.controller.snapshot.suspended).toBe(false);
    expect(f.timers.size).toBe(0);
  });

  it("disabling automatic maintenance aborts active semantic work", async () => {
    const f = fixture();
    const semantic = deferred<Awaited<ReturnType<MaintenancePort["prepareSemantic"]>>>();
    let signal!: AbortSignal;
    f.semantic.mockImplementationOnce((received) => {
      signal = received;
      return semantic.promise;
    });
    f.controller.setAutomaticEnabled(true);
    f.controller.invalidate();
    await f.advance(3_000);
    await vi.waitFor(() => expect(f.controller.snapshot.phase).toBe("semantic"));
    f.controller.setAutomaticEnabled(false);
    expect(signal.aborted).toBe(true);
    semantic.resolve({
      operation: "prepare",
      changed: false,
      converged: true,
      stored: 0,
      skipped: 0,
      state: {} as never,
    });
    await f.settle();
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.controller.snapshot.pending).toBe(true);
  });

  it("Stop cancels a queued Check while an already started adoption settles", async () => {
    const f = fixture();
    const lexical = deferred<{ changed: boolean; converged: boolean }>();
    f.lexical.mockImplementationOnce(() => lexical.promise);
    const update = f.controller.update();
    await f.settle();
    const queuedCheck = f.controller.checkPublication();
    f.controller.stop();
    lexical.resolve({ changed: false, converged: true });
    await update;
    await expect(queuedCheck).resolves.toEqual({ adopted: false, ignored: "missing" });
    expect(f.adopt).not.toHaveBeenCalled();

    const adoption = deferred<AdoptionResult>();
    f.adopt.mockImplementationOnce(() => adoption.promise);
    const startedCheck = f.controller.checkPublication();
    await f.settle();
    f.controller.stop();
    adoption.resolve({ adopted: true });
    await expect(startedCheck).resolves.toEqual({ adopted: true });
    expect(f.adopt).toHaveBeenCalledOnce();
  });
});
