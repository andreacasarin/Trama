import { Notice, Plugin } from "obsidian";
export type IndexStatusKind = "idle" | "stale" | "building" | "ready" | "error" | "cancelled";
export interface IndexStatus {
  readonly kind: IndexStatusKind;
  readonly progress?: number;
  readonly message?: string;
}
/** Provides minimal native commands for rebuilding and cancelling the semantic index. */
export class IndexStatusController {
  status: IndexStatus = { kind: "idle" };
  private controller = new AbortController();
  constructor(
    private readonly plugin: Plugin,
    private readonly rebuild: (signal: AbortSignal) => Promise<void>
  ) {}
  register(): void {
    this.plugin.addCommand({
      id: "rebuild-vault-index",
      name: "Rebuild vault index",
      callback: () => void this.start(),
    });
    this.plugin.addCommand({
      id: "cancel-vault-index-rebuild",
      name: "Cancel vault index rebuild",
      callback: () => this.cancel(),
    });
  }
  markStale(): void {
    if (this.status.kind !== "building")
      this.status = { kind: "stale", message: "Embedding settings changed; rebuild required." };
  }
  /** Records a background rebuild failure without discarding the pending work. */
  markError(error: unknown): void {
    this.status = {
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  cancel(): void {
    this.controller.abort();
  }
  getStatus(): IndexStatus {
    return this.status;
  }
  private async start(): Promise<void> {
    this.controller = new AbortController();
    this.status = { kind: "building", progress: 0 };
    try {
      await this.rebuild(this.controller.signal);
      this.status = { kind: "ready", progress: 1 };
    } catch (error) {
      this.status = {
        kind: this.controller.signal.aborted ? "cancelled" : "error",
        message: error instanceof Error ? error.message : String(error),
      };
      new Notice(this.status.message ?? "Index rebuild failed.");
    }
  }
}
