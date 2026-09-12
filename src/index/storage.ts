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
  /**
   * Replaces `to` with an already-written temporary file at one
   * non-cancellable same-directory boundary. Atomicity remains a platform
   * assumption; this method is not a power-loss guarantee.
   */
  replace?(from: string, to: string): Promise<void>;
  /** Runtime verification that replacement overwrites an existing sibling. */
  verifyReplaceCapability?(): Promise<IndexStorageReplaceCapability>;
  prepare?(): Promise<void>;
}

export interface IndexStorageReplaceCapability {
  readonly operation: "same-directory-overwrite";
  readonly atomicity: "single-rename-platform-assumption";
}

const REPLACE_CAPABILITY: IndexStorageReplaceCapability = Object.freeze({
  operation: "same-directory-overwrite",
  atomicity: "single-rename-platform-assumption",
});

let replaceProbeSequence = 0;

/** Restricts derived index files to one repository-owned directory. */
export class StrictIndexStorage implements IndexStorage {
  private replaceCapabilityPromise?: Promise<IndexStorageReplaceCapability>;

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
      return Promise.reject(new Error("Index storage listing is unavailable"));
    return this.adapter.list(path ? this.safe(path) : this.root);
  }
  stat(path: string): Promise<{ type: "file" | "folder"; size: number; mtime: number } | null> {
    if (!this.adapter.stat) return Promise.reject(new Error("Index storage stat is unavailable"));
    return this.adapter.stat(this.safe(path));
  }
  replace(from: string, to: string): Promise<void> {
    if (!this.adapter.replace)
      return Promise.reject(
        new StructuredError("internal", "Same-directory index replacement is unavailable.", true)
      );
    return this.adapter.replace(this.safe(from), this.safe(to));
  }
  verifyReplaceCapability(): Promise<IndexStorageReplaceCapability> {
    if (!this.replaceCapabilityPromise)
      this.replaceCapabilityPromise = probeReplaceCapability(this, `${this.root}-replace-probe`);
    return this.replaceCapabilityPromise;
  }
  prepare(): Promise<void> {
    return this.adapter.prepare?.() ?? Promise.resolve();
  }
}

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

/** Projects Obsidian's adapter into `.trama/index.json` only. */
export class ObsidianIndexStorage extends StrictIndexStorage {
  constructor(adapter: ObsidianIndexAdapter, root = ".trama") {
    const ensure = async (path: string) => {
      if (!adapter.mkdir || !path) return;
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
      remove: (path) => adapter.remove(path),
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
      replace: async (from, to) => {
        if (!adapter.rename)
          throw new StructuredError(
            "internal",
            "Same-directory index replacement is unavailable on this vault adapter.",
            true
          );
        await ensure(to.slice(0, to.lastIndexOf("/")));
        // One same-directory rename is the replacement boundary. Obsidian's
        // public DataAdapter contract does not promise power-loss atomicity.
        await adapter.rename(from, to);
      },
      prepare: async () => ensure(root),
    });
  }
}

/** Repository-contained storage used by tests and synthetic benchmarks. */
export class MemoryIndexStorage implements IndexStorage {
  readonly files = new Map<string, string>();
  readonly binaryFiles = new Map<string, Uint8Array>();
  private replaceCapabilityPromise?: Promise<IndexStorageReplaceCapability>;
  constructor(readonly root = ".trama") {}

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
    const all = [...this.files.keys(), ...this.binaryFiles.keys()].filter((entry) =>
      entry.startsWith(prefix)
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
  async replace(from: string, to: string): Promise<void> {
    const value = this.files.get(from);
    if (value === undefined) throw new Error("Missing temporary index snapshot");
    this.files.set(to, value);
    this.files.delete(from);
  }

  verifyReplaceCapability(): Promise<IndexStorageReplaceCapability> {
    if (!this.replaceCapabilityPromise)
      this.replaceCapabilityPromise = probeReplaceCapability(this, `${this.root}-replace-probe`);
    return this.replaceCapabilityPromise;
  }
}

async function probeReplaceCapability(
  storage: IndexStorage,
  prefix: string
): Promise<IndexStorageReplaceCapability> {
  if (!storage.replace)
    throw new StructuredError(
      "internal",
      "Same-directory index replacement is unavailable on this storage.",
      true
    );
  const sequence = replaceProbeSequence++;
  const source = `${prefix}-${sequence}-source`;
  const target = `${prefix}-${sequence}-target`;
  if ((await probePathOccupied(storage, source)) || (await probePathOccupied(storage, target)))
    throw new StructuredError("internal", "Index replacement probe path is occupied.", true);

  let sourceOwned = false;
  let targetOwned = false;
  let failed = false;
  let primaryError: unknown;
  try {
    sourceOwned = true;
    await storage.write(source, "trama-replace-probe-source");
    targetOwned = true;
    await storage.write(target, "trama-replace-probe-target");
    await storage.replace(source, target);
    if ((await storage.read(source)) !== null)
      throw new Error("Index replacement probe left its source sibling");
    sourceOwned = false;
    if ((await storage.read(target)) !== "trama-replace-probe-source")
      throw new Error("Index replacement does not overwrite an existing sibling");
  } catch (error) {
    failed = true;
    primaryError = error;
  }

  let cleanupFailed = false;
  if (sourceOwned) cleanupFailed = (await cleanupProbePath(storage, source)) || cleanupFailed;
  if (targetOwned) cleanupFailed = (await cleanupProbePath(storage, target)) || cleanupFailed;
  if (cleanupFailed) {
    if (failed) markCleanupFailure(primaryError);
    else {
      failed = true;
      primaryError = new StructuredError(
        "internal",
        "Index replacement capability probe cleanup failed.",
        true
      );
      markCleanupFailure(primaryError);
    }
  }
  if (failed) throw primaryError;
  return REPLACE_CAPABILITY;
}

async function cleanupProbePath(storage: IndexStorage, path: string): Promise<boolean> {
  try {
    await storage.remove(path);
    return (await probePathOccupied(storage, path)) === true;
  } catch {
    return true;
  }
}

function markCleanupFailure(error: unknown): void {
  if (!error || typeof error !== "object") return;
  try {
    Object.defineProperty(error, "cleanupFailed", {
      value: true,
      configurable: true,
      enumerable: false,
    });
  } catch {
    // Preserve the primary error even when it cannot carry metadata.
  }
}

async function probePathOccupied(storage: IndexStorage, path: string): Promise<boolean> {
  if (storage.stat) {
    try {
      return (await storage.stat(path)) !== null;
    } catch (error) {
      if (!(error instanceof Error && error.message === "Index storage stat is unavailable"))
        throw error;
    }
  }
  return (await storage.read(path)) !== null;
}
