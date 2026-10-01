import { Platform } from "obsidian";
import { bytesToHex } from "@/index/Identity";
import type { SnapshotDataAdapter } from "@/index/IndexManager";
import type { SqliteWorkerClient, SqliteWorkerLike } from "@/index/sqlite/client";
import { SQLITE_PROTOCOL_VERSION } from "@/index/sqlite/protocol";

interface PluginManifest {
  readonly id?: string;
  readonly dir?: string;
  readonly version?: string;
}

export class SqliteRuntime {
  private readonly workerCacheNonce =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  private identity?: string;
  private identityAdapter?: SnapshotDataAdapter;

  constructor(private readonly getManifest: () => PluginManifest | undefined) {}

  async resolveIdentity(adapter: SnapshotDataAdapter): Promise<string> {
    const path = ".trama/sqlite/v1/identity.json";
    if (this.identity && this.identityAdapter === adapter) return this.identity;
    if (typeof adapter.read !== "function" || typeof adapter.write !== "function")
      throw new Error("SQLite identity storage is unavailable.");
    let identity: string | undefined;
    try {
      const raw = await adapter.read.call(adapter, path);
      const parsed = JSON.parse(raw) as { readonly version?: unknown; readonly identity?: unknown };
      if (
        parsed.version === 1 &&
        typeof parsed.identity === "string" &&
        /^[0-9a-f]{64}$/i.test(parsed.identity)
      )
        identity = parsed.identity.toLowerCase();
    } catch {
      // A missing or malformed identity is replaced with a new opaque token.
    }
    if (!identity) {
      const bytes = new Uint8Array(32);
      globalThis.crypto.getRandomValues(bytes);
      identity = bytesToHex(bytes);
      if (typeof adapter.mkdir !== "function")
        throw new Error("SQLite identity storage is unavailable.");
      await adapter.mkdir.call(adapter, ".trama");
      await adapter.mkdir.call(adapter, ".trama/sqlite");
      await adapter.mkdir.call(adapter, ".trama/sqlite/v1");
      await adapter.write.call(adapter, path, JSON.stringify({ version: 1, identity }));
    }
    this.identity = identity;
    this.identityAdapter = adapter;
    return identity;
  }

  workerUrl(app: any): string {
    const url = this.assetUrl(app, "sqlite-worker.mjs");
    const version = this.getManifest()?.version || SQLITE_PROTOCOL_VERSION;
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}v=${encodeURIComponent(String(version))}&nonce=${encodeURIComponent(this.workerCacheNonce)}`;
  }

  createWorker(app: any): SqliteWorkerLike {
    if (typeof Worker !== "function") throw new Error("SQLite Worker APIs are unavailable.");
    const workerUrl = this.workerUrl(app);
    if (!Platform.isDesktopApp)
      return new Worker(workerUrl, { type: "module" }) as unknown as SqliteWorkerLike;
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
    const bootstrap = `globalThis.__TRAMA_SQLITE_ASSETS__=${JSON.stringify(assets)};const __tramaWorkerUrl=${JSON.stringify(workerUrl)};const __tramaPending=[];self.onmessage=(event)=>__tramaPending.push(event);let __tramaStartupError;try{await import(__tramaWorkerUrl)}catch{__tramaStartupError={code:"storage_unavailable",message:"SQLite Worker could not be started. Ensure the bundled SQLite assets are installed.",retryable:true}}URL.revokeObjectURL(globalThis.location.href);if(__tramaStartupError)self.onmessage=({data})=>self.postMessage({v:${SQLITE_PROTOCOL_VERSION},id:Number.isSafeInteger(data?.id)?data.id:0,ok:false,error:__tramaStartupError});for(const event of __tramaPending)self.onmessage(event);`;
    const bootstrapUrl = URL.createObjectURL(new Blob([bootstrap], { type: "text/javascript" }));
    try {
      return new Worker(bootstrapUrl, { type: "module" }) as unknown as SqliteWorkerLike;
    } catch (error) {
      URL.revokeObjectURL(bootstrapUrl);
      throw error;
    }
  }

  /** Optional in-process backend supplied by non-Worker hosts. */
  createClient(_storage: object): SqliteWorkerClient | undefined {
    return undefined;
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
    const pluginId = manifest?.id || "trama";
    const pluginDir = manifest?.dir || `${configDir}/plugins/${pluginId}`;
    return adapter.getResourcePath.call(adapter, `${pluginDir}/${fileName}`);
  }
}
