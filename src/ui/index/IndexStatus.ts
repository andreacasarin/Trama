export interface IndexStatus {
  readonly kind: "ready" | "index-required" | "building" | "error";
  readonly message?: string;
  readonly canIndex: boolean;
  readonly canReindex: boolean;
  readonly canCancel: boolean;
}

export class IndexStatusController {
  private status: IndexStatus = {
    kind: "index-required",
    canIndex: true,
    canReindex: true,
    canCancel: false,
  };
  private listeners = new Set<(status: IndexStatus) => void>();
  constructor() {}
  getStatus(): IndexStatus {
    return this.status;
  }
  setStatus(status: IndexStatus): void {
    this.status = Object.freeze(status);
    for (const listener of this.listeners) listener(this.status);
  }
  subscribe(listener: (status: IndexStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }
}
