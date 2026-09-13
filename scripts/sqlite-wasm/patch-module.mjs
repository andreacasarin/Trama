import { readFileSync, writeFileSync } from "node:fs";

const path = process.argv[2];
if (!path) throw new Error("Usage: node patch-module.mjs PATH");

function replace(source, before, after, label) {
  if (!source.includes(before)) throw new Error(`Unexpected SQLite output: ${label}`);
  return source.replace(before, after);
}

let output = readFileSync(path, "utf8");
const runtimeBefore = `    readyPromiseResolve?.(Module);
    Module['onRuntimeInitialized']?.();

    postRun();`;
if (output.includes(runtimeBefore))
  output = output.replace(
    runtimeBefore,
    `    Module['onRuntimeInitialized']?.();

    postRun();
    readyPromiseResolve?.(Module);`
  );
output = replace(
  output,
  "return originalInit(...args).then((EmscriptenModule)=>",
  "return originalInit(...args).then(async (EmscriptenModule)=>",
  "async initialization callback"
);
output = replace(
  output,
  `      const s = EmscriptenModule.sqlite3;
      s.scriptInfo = initModuleState;`,
  `      let s = EmscriptenModule.sqlite3;
      if (!s && globalThis.sqlite3ApiBootstrap) {
        s = EmscriptenModule.sqlite3 = globalThis.sqlite3ApiBootstrap();
      }
      for (let i = 0; !s && i < 100; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        s = EmscriptenModule.sqlite3;
      }
      if (!s) throw new Error("SQLite API was not attached to the Emscripten module");
      s.scriptInfo = initModuleState;`,
  "browser API attachment"
);
output = replace(
  output,
  "      memory: Module.wasmMemory /* gets set if built with -sIMPORTED_MEMORY */\n    },",
  "      memory: Module.wasmMemory /* gets set if built with -sIMPORTED_MEMORY */,\n      bigIntEnabled: true\n    },",
  "BigInt configuration"
);
output = replace(
  output,
  `      const f = s.asyncPostInit;
      delete s.asyncPostInit;
      return f();`,
  `      delete s.asyncPostInit;
      return s;`,
  "proxy initialization"
);
const legacyOpfs = `installOpfsVfs.defaultProxyUri =
  "sqlite3-opfs-async-proxy.js";
globalThis.sqlite3ApiBootstrap.initializersAsync.push(async (sqlite3)=>{
  try{
    let proxyJs = installOpfsVfs.defaultProxyUri;
    if(sqlite3.scriptInfo.sqlite3Dir){
      installOpfsVfs.defaultProxyUri =
        sqlite3.scriptInfo.sqlite3Dir + proxyJs;
      //sqlite3.config.warn("installOpfsVfs.defaultProxyUri =",installOpfsVfs.defaultProxyUri);
    }
    return installOpfsVfs().catch((e)=>{
      sqlite3.config.warn("Ignoring inability to install OPFS sqlite3_vfs:",e.message);
    });
  }catch(e){
    sqlite3.config.error("installOpfsVfs() exception:",e);
    return Promise.reject(e);
  }
});
}/*sqlite3ApiBootstrap.initializers.push()*/);`;
output = replace(
  output,
  legacyOpfs,
  "// Legacy asynchronous OPFS VFS disabled: production persistence uses the SAH pool.\n}/*sqlite3ApiBootstrap.initializers.push()*/);",
  "legacy OPFS initializer"
);
const wasmMarker = "var wasmExports = await createWasm();";
output = replace(
  output,
  wasmMarker,
  `if (!wasmBinary && typeof fetch === "function") {
  const localWasmResponse = await fetch(new URL("sqlite3.wasm", import.meta.url), { credentials: "same-origin" });
  if (!localWasmResponse.ok) throw new Error(\`SQLite WASM request failed: \${localWasmResponse.status}\`);
  wasmBinary = await localWasmResponse.arrayBuffer();
}
Module['emscripten-bug-17951'] = undefined;
${wasmMarker}`,
  "local WASM bootstrap"
);
const footer = "})/*postRun.push(...)*/;";
output = replace(
  output,
  footer,
  `${footer}\nif (runtimeInitialized) postRun();`,
  "eager browser initialization"
);

writeFileSync(path, output);
