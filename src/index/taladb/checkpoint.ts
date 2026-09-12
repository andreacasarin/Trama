import type { TalaCheckpoint } from "./protocol";
import { assertTalaPath, createTalaNamespace, type TalaNamespace } from "./namespace";

/** Minimal injected persistence port. Methods intentionally retain their receiver. */
export interface TalaDataAdapter {
  read(path: string): Promise<string | Uint8Array | ArrayBuffer | null>;
  write(path: string, value: string | Uint8Array | ArrayBuffer): Promise<void>;
  remove?(path: string): Promise<void>;
}

function bytes(value: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof value === "string") return new TextEncoder().encode(value);
  return value instanceof ArrayBuffer ? new Uint8Array(value) : value.slice();
}

function decode(value: string | Uint8Array | ArrayBuffer): string {
  return typeof value === "string" ? value : new TextDecoder().decode(bytes(value));
}

function validateCheckpoint(value: unknown): asserts value is TalaCheckpoint {
  if (!value || typeof value !== "object") throw new Error("Invalid Tala checkpoint");
  const checkpoint = value as Partial<TalaCheckpoint>;
  if (
    checkpoint.version !== 1 ||
    typeof checkpoint.namespace !== "string" ||
    !Array.isArray(checkpoint.notes) ||
    !checkpoint.state ||
    typeof checkpoint.state !== "object" ||
    !["ready", "dirty"].includes(checkpoint.state.status) ||
    typeof checkpoint.state.syncNeeded !== "boolean" ||
    !["idle", "rebuilding", "syncing"].includes(checkpoint.state.operation) ||
    !Number.isSafeInteger(checkpoint.state.revision) ||
    typeof checkpoint.state.fingerprint !== "string" ||
    !Number.isSafeInteger(checkpoint.state.dimensions) ||
    checkpoint.notes.some(
      (note) =>
        !note ||
        typeof note !== "object" ||
        typeof note.path !== "string" ||
        typeof note.content !== "string" ||
        !Array.isArray(note.chunks)
    )
  )
    throw new Error("Invalid Tala checkpoint");
}

/** Explicit checkpoint I/O. Sync operations never invoke this class implicitly. */
export class TalaCheckpointStore {
  readonly path: string;
  constructor(
    private readonly adapter: TalaDataAdapter,
    namespace: TalaNamespace | string = createTalaNamespace()
  ) {
    this.path = typeof namespace === "string" ? namespace : namespace.checkpoint;
    assertTalaPath(this.path);
  }

  async export(checkpoint: TalaCheckpoint): Promise<void> {
    validateCheckpoint(checkpoint);
    // Calling through the adapter object is deliberate: DataAdapter methods may use `this`.
    await this.adapter.write(this.path, JSON.stringify(checkpoint));
  }

  async import(): Promise<TalaCheckpoint | null> {
    const value = await this.adapter.read(this.path);
    if (value === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(decode(value));
    } catch {
      throw new Error("Invalid Tala checkpoint encoding");
    }
    validateCheckpoint(parsed);
    return parsed;
  }

  async remove(): Promise<void> {
    if (this.adapter.remove) await this.adapter.remove(this.path);
  }
}

export { bytes as checkpointBytes };
