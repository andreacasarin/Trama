import { StructuredError } from "@/domain/contracts";

/** Durable marker storage for the namespaced Tala lifecycle. */
export interface IndexStorage {
  readonly root: string;
  read(path: string): Promise<string | null>;
  write(path: string, value: string): Promise<void>;
  remove(path: string): Promise<void>;
  activate(pointer: string, value: string, signal?: AbortSignal): Promise<void>;
  prepare?(): Promise<void>;
}

/** Restricts marker paths to the configured Tala root. */
export class StrictIndexStorage implements IndexStorage {
  constructor(
    readonly root: string,
    private readonly adapter: IndexStorage
  ) {
    if (!root || root.startsWith("/") || root.split("/").includes(".."))
      throw new Error("Invalid index root");
  }
  private safe(path: string): string {
    if (
      !path ||
      path.startsWith("/") ||
      path.split("/").some((part) => !part || part === "..") ||
      path.includes("\\")
    )
      throw new Error("Index path escapes index root");
    return `${this.root}/${path}`;
  }
  read(path: string): Promise<string | null> {
    return this.adapter.read(this.safe(path));
  }
  write(path: string, value: string): Promise<void> {
    return this.adapter.write(this.safe(path), value);
  }
  remove(path: string): Promise<void> {
    return this.adapter.remove(this.safe(path));
  }
  activate(_pointer: string, value: string, signal?: AbortSignal): Promise<void> {
    return this.adapter.activate(this.safe("active.json"), value, signal);
  }
  prepare(): Promise<void> {
    return this.adapter.prepare?.() ?? Promise.resolve();
  }
}

type ObsidianIndexAdapter = {
  read(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  write(path: string, data: string): Promise<void>;
  remove(path: string): Promise<void>;
  mkdir?(path: string): Promise<void>;
  rename?(from: string, to: string): Promise<void>;
};

/** Projects an Obsidian adapter into the Tala state namespace. */
export class ObsidianIndexStorage extends StrictIndexStorage {
  constructor(adapter: ObsidianIndexAdapter, root = ".trama/index") {
    const ensure = async (path: string) => {
      if (!adapter.mkdir || !path) return;
      let current = "";
      for (const part of path.split("/")) {
        current = current ? `${current}/${part}` : part;
        if (!(await adapter.exists(current))) await adapter.mkdir(current);
      }
    };
    super(root, {
      root,
      read: async (path) => ((await adapter.exists(path)) ? adapter.read(path) : null),
      write: async (path, value) => {
        await ensure(path.slice(0, path.lastIndexOf("/")));
        await adapter.write(path, value);
      },
      remove: (path) => adapter.remove(path),
      activate: async (path, value, signal) => {
        if (signal?.aborted) throw new Error("Index activation cancelled");
        if (!adapter.rename)
          throw new StructuredError(
            "internal",
            "Atomic index activation is unavailable on this vault adapter.",
            true
          );
        await ensure(path.slice(0, path.lastIndexOf("/")));
        const temp = `${path}.tmp`;
        const backup = `${path}.bak`;
        await adapter.write(temp, value);
        if (signal?.aborted) {
          await adapter.remove(temp).catch(() => undefined);
          throw new Error("Index activation cancelled");
        }
        const hadOld = await adapter.exists(path);
        let oldMoved = false;
        try {
          if (hadOld) {
            await adapter.rename(path, backup);
            oldMoved = true;
          }
          await adapter.rename(temp, path);
          await adapter.remove(backup).catch(() => undefined);
        } catch (error) {
          if (oldMoved) {
            await adapter.remove(path).catch(() => undefined);
            await adapter.rename(backup, path).catch(() => undefined);
          }
          await adapter.remove(temp).catch(() => undefined);
          throw error;
        }
      },
      prepare: async () => {
        await ensure(root);
        await ensure(`${root}/taladb-v1`);
      },
    });
  }
}

/** Explicitly injected in-memory marker store for Node/Vitest only. */
export class MemoryIndexStorage implements IndexStorage {
  readonly files = new Map<string, string>();
  constructor(readonly root = ".trama/index") {}
  async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }
  async write(path: string, value: string): Promise<void> {
    this.files.set(path, value);
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
  async activate(pointer: string, value: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error("Index activation cancelled");
    this.files.set(`${pointer}.tmp`, value);
    if (signal?.aborted) {
      this.files.delete(`${pointer}.tmp`);
      throw new Error("Index activation cancelled");
    }
    this.files.set(pointer, value);
    this.files.delete(`${pointer}.tmp`);
  }
}
