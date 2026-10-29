import type { NoteStoreWorkerLike } from "@/index/note-sqlite/client";
import type { NoteSqliteDatabase } from "@/index/note-sqlite/database";
import { attachNoteStoreWorker } from "@/index/note-sqlite/worker";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let runtimePromise: Promise<any> | undefined;

export function loadTestSqlite(): Promise<any> {
  runtimePromise ??= (async () => {
    (globalThis as any).sqlite3ApiConfig = {
      disable: { vfs: { kvvfs: true, opfs: true, "opfs-wl": true } },
    };
    // @ts-expect-error generated production asset has no application declarations.
    const init = (await import("../sqlite3.mjs")).default;
    const wasmBinary = readFileSync(fileURLToPath(new URL("../sqlite3.wasm", import.meta.url)));
    return init({
      instantiateWasm(
        imports: WebAssembly.Imports,
        onSuccess: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void
      ) {
        WebAssembly.instantiate(wasmBinary, imports).then(({ instance, module }) =>
          onSuccess(instance, module)
        );
        return {};
      },
    });
  })();
  return runtimePromise;
}

/** Exercise the production queue and cancellation protocol with native-shaped events. */
export class TestNoteWorker implements NoteStoreWorkerLike {
  private readonly events = new EventTarget();
  private readonly scope = {
    onmessage: null as ((event: MessageEvent<any>) => void) | null,
    postMessage: (data: unknown) =>
      queueMicrotask(() => this.events.dispatchEvent(new MessageEvent("message", { data }))),
    close: () => {
      this.scope.onmessage = null;
    },
  };
  constructor(database: Pick<NoteSqliteDatabase, "call">) {
    attachNoteStoreWorker(this.scope, async () => ({ database, close() {} }));
  }
  addEventListener(
    type: "message" | "error" | "messageerror",
    listener: (event: any) => void
  ): void {
    this.events.addEventListener(type, listener);
  }
  removeEventListener(
    type: "message" | "error" | "messageerror",
    listener: (event: any) => void
  ): void {
    this.events.removeEventListener(type, listener);
  }
  postMessage(data: unknown): void {
    queueMicrotask(() => this.scope.onmessage?.({ data } as MessageEvent));
  }
  terminate(): void {
    this.scope.close();
  }
}
