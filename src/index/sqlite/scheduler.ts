import { sqliteError } from "./protocol";

interface Job<T> {
  readonly id: number;
  readonly run: (signal: AbortSignal) => Promise<T>;
  readonly controller: AbortController;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

/** A small FIFO scheduler: database work never runs concurrently. */
export class SqliteScheduler {
  private readonly queue: Job<unknown>[] = [];
  private running = false;
  private closed = false;
  private active?: Job<unknown>;

  enqueue<T>(id: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed)
      return Promise.reject(sqliteError("storage_unavailable", "Database is closed"));
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        id,
        run,
        controller: new AbortController(),
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      void this.pump();
    });
  }

  cancelQueued(id?: number): number {
    let cancelled = 0;
    if (this.active && (id === undefined || this.active.id === id)) {
      this.active.controller.abort();
      cancelled++;
    }
    for (let index = this.queue.length - 1; index >= 0; index--) {
      if (id !== undefined && this.queue[index].id !== id) continue;
      const [job] = this.queue.splice(index, 1);
      job.reject(sqliteError("cancelled", "Request cancelled", true));
      cancelled++;
    }
    return cancelled;
  }

  shutdown(): void {
    this.closed = true;
    this.cancelQueued();
  }

  get pending(): number {
    return this.queue.length + (this.running ? 1 : 0);
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length && !this.closed) {
        const job = this.queue.shift()!;
        this.active = job;
        try {
          job.resolve(await job.run(job.controller.signal));
        } catch (error) {
          job.reject(error);
        } finally {
          this.active = undefined;
        }
      }
    } finally {
      this.running = false;
    }
  }
}
