import { describe, expect, it } from "vitest";
import { SqliteScheduler } from "@/index/sqlite/scheduler";

describe("SQLite scheduler", () => {
  it("signals a running asynchronous job when its caller cancels", async () => {
    const scheduler = new SqliteScheduler();
    let started!: () => void;
    let resume!: () => void;
    const ready = new Promise<void>((resolve) => (started = resolve));
    const running = scheduler.enqueue(1, async (signal) => {
      started();
      await new Promise<void>((resolve) => (resume = resolve));
      if (signal.aborted) throw new Error("cancelled before mutation");
      return "mutated";
    });
    await ready;

    expect(scheduler.cancelQueued(1)).toBe(1);
    resume();
    await expect(running).rejects.toThrow("cancelled before mutation");
  });
});
