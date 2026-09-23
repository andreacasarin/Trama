export type IndexOperationChannel = "lexical" | "semantic";

/** Shared ownership fence for one manual or automatic index operation. */
export class IndexOperationLease {
  readonly signal: AbortSignal;
  readonly done: Promise<void>;
  private resolveDone!: () => void;
  private released = false;
  private releaseHandler?: (lease: IndexOperationLease) => void;

  constructor(
    readonly channel: IndexOperationChannel,
    readonly controller = new AbortController(),
    releaseHandler?: (lease: IndexOperationLease) => void
  ) {
    this.signal = controller.signal;
    this.releaseHandler = releaseHandler;
    this.done = new Promise<void>((resolve) => (this.resolveDone = resolve));
  }

  abort(): void {
    if (!this.signal.aborted) this.controller.abort();
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.resolveDone();
    const handler = this.releaseHandler;
    this.releaseHandler = undefined;
    handler?.(this);
  }
}
