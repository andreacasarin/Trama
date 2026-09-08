import { StructuredError } from "@/domain/contracts";

export interface IndexStorage {
  readonly root: string;
  read(path: string): Promise<string | null>;
  write(path: string, value: string): Promise<void>;
  remove(path: string): Promise<void>;
  readBinary?(path: string): Promise<ArrayBuffer>;
  writeBinary?(path: string, value: ArrayBuffer | Uint8Array): Promise<void>;
  list?(path: string): Promise<{ files: string[]; folders: string[] }>;
  stat?(path: string): Promise<{ type: "file" | "folder"; size: number; mtime: number } | null>;
  /** Atomically publishes the pointer, retaining the prior pointer if publication fails. */
  activate(pointer: string, value: string, signal?: AbortSignal): Promise<void>;
  prepare?(): Promise<void>;
}

/** Restricts derived index files to the vault's index directory. */
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
  readBinary(path: string): Promise<ArrayBuffer> {
    if (!this.adapter.readBinary) return Promise.reject(new Error("Binary storage is unavailable"));
    return this.adapter.readBinary(this.safe(path));
  }
  writeBinary(path: string, value: ArrayBuffer | Uint8Array): Promise<void> {
    if (!this.adapter.writeBinary)
      return Promise.reject(new Error("Binary storage is unavailable"));
    return this.adapter.writeBinary(this.safe(path), value);
  }
  list(path = ""): Promise<{ files: string[]; folders: string[] }> {
    if (!this.adapter.list)
      return Promise.reject(new Error("Binary storage listing is unavailable"));
    return this.adapter.list(path ? this.safe(path) : this.root);
  }
  stat(path: string): Promise<{ type: "file" | "folder"; size: number; mtime: number } | null> {
    if (!this.adapter.stat) return Promise.reject(new Error("Binary storage stat is unavailable"));
    return this.adapter.stat(this.safe(path));
  }
  activate(pointer: string, value: string, signal?: AbortSignal): Promise<void> {
    return this.adapter.activate(this.safe("active.json"), value, signal);
  }
  prepare(): Promise<void> {
    return this.adapter.prepare?.() ?? Promise.resolve();
  }
}

/** Projects Obsidian's write-capable adapter into the strictly contained index store. */
type ObsidianIndexAdapter = {
  read(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  write(path: string, data: string): Promise<void>;
  readBinary?(path: string): Promise<ArrayBuffer>;
  writeBinary?(path: string, data: ArrayBuffer): Promise<void>;
  list?(path: string): Promise<{ files: string[]; folders: string[] }>;
  stat?(path: string): Promise<{ type: "file" | "folder"; size: number; mtime: number } | null>;
  remove(path: string): Promise<void>;
  mkdir?(path: string): Promise<void>;
  rename?(from: string, to: string): Promise<void>;
};

export class ObsidianIndexStorage extends StrictIndexStorage {
  constructor(adapter: ObsidianIndexAdapter, root = ".trama/index") {
    const ensure = async (path: string) => {
      if (!adapter.mkdir) return;
      const parts = path.split("/");
      let current = "";
      for (const part of parts) {
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
      readBinary: adapter.readBinary ? (path) => adapter.readBinary!(path) : undefined,
      writeBinary: adapter.writeBinary
        ? async (path, value) => {
            await ensure(path.slice(0, path.lastIndexOf("/")));
            const data =
              value instanceof ArrayBuffer
                ? value
                : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
            await adapter.writeBinary!(path, data as ArrayBuffer);
          }
        : undefined,
      list: adapter.list
        ? async (path) => {
            const listed = await adapter.list!(path);
            const prefix = `${path}/`;
            const relative = (entry: string) =>
              entry.startsWith(prefix) ? entry.slice(prefix.length) : entry;
            return {
              files: listed.files.map(relative),
              folders: listed.folders.map(relative),
            };
          }
        : undefined,
      stat: adapter.stat ? (path) => adapter.stat!(path) : undefined,
      remove: (path) => adapter.remove(path),
      activate: async (path, value, signal) => {
        if (signal?.aborted) throw new Error("Index activation cancelled");
        if (!adapter.rename)
          throw new StructuredError(
            "internal",
            "Atomic index activation is unavailable on this vault adapter.",
            true
          );
        const parent = path.slice(0, path.lastIndexOf("/"));
        if (adapter.mkdir) {
          if (!(await adapter.exists(parent))) await adapter.mkdir(parent);
          if (!(await adapter.exists(`${parent}/generations`)))
            await adapter.mkdir(`${parent}/generations`);
        }
        const temp = `${path}.tmp`;
        const backup = `${path}.bak`;
        await adapter.write(temp, value);
        if (signal?.aborted) {
          await adapter.remove(temp).catch(() => undefined);
          throw new Error("Index activation cancelled");
        }
        const hadOld = await adapter.exists(path);
        let oldMovedToBackup = false;
        try {
          if (hadOld) {
            try {
              await adapter.rename(path, backup);
              oldMovedToBackup = true;
            } catch (error) {
              // The old pointer is still authoritative when this move fails.
              await adapter.remove(temp).catch(() => undefined);
              throw error;
            }
          }
          if (signal?.aborted) throw new Error("Index activation cancelled");
          await adapter.rename(temp, path);
          await adapter.remove(backup).catch(() => undefined);
        } catch (error) {
          if (oldMovedToBackup) {
            await adapter.remove(path).catch(() => undefined);
            try {
              await adapter.rename(backup, path);
            } catch {
              throw new StructuredError(
                "internal",
                "Index activation failed; the previous pointer remains in backup storage.",
                true
              );
            }
          }
          await adapter.remove(temp).catch(() => undefined);
          throw error;
        }
      },
      prepare: async () => {
        await ensure(root);
        await ensure(`${root}/manifests`);
        await ensure(`${root}/segments`);
        // Legacy generation artifacts remain readable and reclaimable.
        await ensure(`${root}/generations`);
      },
    });
  }
}

/** In-memory storage useful for tests and non-Obsidian composition. */
export class MemoryIndexStorage implements IndexStorage {
  readonly files = new Map<string, string>();
  readonly binaryFiles = new Map<string, Uint8Array>();
  constructor(readonly root = ".trama/index") {}
  async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }
  async write(path: string, value: string): Promise<void> {
    this.files.set(path, value);
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
    this.binaryFiles.delete(path);
  }
  async readBinary(path: string): Promise<ArrayBuffer> {
    const value = this.binaryFiles.get(path);
    if (!value) throw new Error(`Missing binary artifact: ${path}`);
    return value.slice().buffer;
  }
  async writeBinary(path: string, value: ArrayBuffer | Uint8Array): Promise<void> {
    this.binaryFiles.set(
      path,
      new Uint8Array(
        value instanceof ArrayBuffer
          ? value
          : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
      )
    );
  }
  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = path ? `${path}/` : "";
    const all = [...this.files.keys(), ...this.binaryFiles.keys()].filter((p) =>
      p.startsWith(prefix)
    );
    const files = new Set<string>();
    const folders = new Set<string>();
    for (const entry of all) {
      const relative = entry.slice(prefix.length);
      const slash = relative.indexOf("/");
      if (slash === -1) files.add(relative);
      else folders.add(relative.slice(0, slash));
    }
    return { files: [...files], folders: [...folders] };
  }
  async stat(
    path: string
  ): Promise<{ type: "file" | "folder"; size: number; mtime: number } | null> {
    const text = this.files.get(path);
    const binary = this.binaryFiles.get(path);
    if (text !== undefined)
      return { type: "file", size: new TextEncoder().encode(text).byteLength, mtime: 0 };
    if (binary) return { type: "file", size: binary.byteLength, mtime: 0 };
    return null;
  }
  async activate(pointer: string, value: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error("Index activation cancelled");
    const previous = this.files.get(pointer);
    this.files.set(`${pointer}.tmp`, value);
    if (signal?.aborted) {
      this.files.delete(`${pointer}.tmp`);
      throw new Error("Index activation cancelled");
    }
    this.files.set(pointer, value);
    this.files.delete(`${pointer}.tmp`);
    if (previous === undefined) this.files.delete(`${pointer}.bak`);
  }
}
