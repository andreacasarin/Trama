import workerSource from "../../.cache/sqlite.worker.js?raw";
import type { NoteStoreWorkerLike } from "@/index/note-sqlite/client";

export class NoteSqliteRuntime {
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

  createWorker(): NoteStoreWorkerLike {
    const url = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
    try {
      const worker = new Worker(url, { type: "module" });
      const terminate = worker.terminate.bind(worker);
      worker.terminate = () => {
        URL.revokeObjectURL(url);
        terminate();
      };
      return worker as unknown as NoteStoreWorkerLike;
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
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
