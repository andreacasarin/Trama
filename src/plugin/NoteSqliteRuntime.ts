import { Platform } from "obsidian";
import type { NoteStoreWorkerLike } from "@/index/note-sqlite/client";

interface PluginManifest {
  readonly id?: string;
  readonly dir?: string;
  readonly version?: string;
}

export class NoteSqliteRuntime {
  private readonly nonce =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  constructor(private readonly getManifest: () => PluginManifest | undefined) {}

  async resolveNamespace(app: any): Promise<string> {
    const adapter = app?.vault?.adapter;
    if (
      !adapter ||
      typeof adapter.exists !== "function" ||
      typeof adapter.read !== "function" ||
      typeof adapter.mkdir !== "function" ||
      typeof adapter.write !== "function"
    )
      throw new Error("Vault-local SQLite identity storage is unavailable.");
    const identityPath = ".trama/note-v1/identity.json";
    if (await adapter.exists(identityPath)) {
      return this.readNamespace(await adapter.read(identityPath));
    }
    const bytes = new Uint8Array(32);
    if (!globalThis.crypto?.getRandomValues)
      throw new Error("Secure vault-local SQLite identity generation is unavailable.");
    globalThis.crypto.getRandomValues(bytes);
    const namespace = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
    try {
      await adapter.mkdir(".trama");
    } catch (error) {
      if (!(await adapter.exists(".trama"))) throw error;
    }
    try {
      await adapter.mkdir(".trama/note-v1");
    } catch (error) {
      if (!(await adapter.exists(".trama/note-v1"))) throw error;
    }
    await adapter.write(identityPath, JSON.stringify({ version: 1, namespace }));
    const written = await adapter.read(identityPath);
    if (this.readNamespace(written) !== namespace)
      throw new Error("Vault-local SQLite identity could not be verified.");
    return namespace;
  }

  createWorker(app: any): NoteStoreWorkerLike {
    if (typeof Worker !== "function") throw new Error("SQLite Worker APIs are unavailable.");
    const workerUrl = this.assetUrl(app, "sqlite-worker.mjs");
    const version = this.getManifest()?.version ?? "1";
    const url = `${workerUrl}${workerUrl.includes("?") ? "&" : "?"}v=${encodeURIComponent(version)}&nonce=${encodeURIComponent(this.nonce)}`;
    if (!Platform.isDesktopApp)
      return new Worker(url, { type: "module" }) as unknown as NoteStoreWorkerLike;
    if (
      typeof Blob !== "function" ||
      typeof URL?.createObjectURL !== "function" ||
      typeof URL?.revokeObjectURL !== "function"
    )
      throw new Error("SQLite Worker APIs are unavailable.");
    const assets = {
      moduleUrl: this.assetUrl(app, "sqlite3.mjs"),
      wasmUrl: this.assetUrl(app, "sqlite3.wasm"),
    };
    const bootstrap = `globalThis.__TRAMA_SQLITE_ASSETS__=${JSON.stringify(assets)};const u=${JSON.stringify(url)};const q=[];self.onmessage=e=>q.push(e);let x;try{await import(u)}catch{x={code:"storage_unavailable",message:"SQLite Worker could not be started. Ensure the bundled SQLite assets are installed.",retryable:true}}URL.revokeObjectURL(globalThis.location.href);if(x)self.onmessage=({data})=>self.postMessage({v:1,id:Number.isSafeInteger(data?.id)?data.id:0,ok:false,error:x});for(const e of q)self.onmessage(e);`;
    const bootstrapUrl = URL.createObjectURL(new Blob([bootstrap], { type: "text/javascript" }));
    try {
      return new Worker(bootstrapUrl, { type: "module" }) as unknown as NoteStoreWorkerLike;
    } catch (error) {
      URL.revokeObjectURL(bootstrapUrl);
      throw error;
    }
  }

  private assetUrl(app: any, fileName: string): string {
    const adapter = app?.vault?.adapter;
    if (!adapter || typeof adapter.getResourcePath !== "function")
      throw new Error("SQLite Worker resource path is unavailable.");
    const configDir =
      typeof app?.vault?.configDir === "string" && app.vault.configDir
        ? app.vault.configDir
        : ".obsidian";
    const manifest = this.getManifest();
    return adapter.getResourcePath.call(
      adapter,
      `${manifest?.dir || `${configDir}/plugins/${manifest?.id || "trama"}`}/${fileName}`
    );
  }

  private readNamespace(contents: string): string {
    try {
      const value = JSON.parse(contents);
      if (
        value?.version === 1 &&
        typeof value.namespace === "string" &&
        /^[0-9a-f]{64}$/.test(value.namespace)
      )
        return value.namespace;
    } catch {
      // Invalid identity data must fail closed rather than open a shared store.
    }
    throw new Error("Vault-local SQLite identity is invalid.");
  }
}
