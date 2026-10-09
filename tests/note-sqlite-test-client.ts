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
