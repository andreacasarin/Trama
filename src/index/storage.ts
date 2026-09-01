import { StructuredError } from "@/domain/contracts";

export interface IndexStorage {
  readonly root: string;
  read(path: string): Promise<string | null>;
  write(path: string, value: string): Promise<void>;
  remove(path: string): Promise<void>;
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
  activate(pointer: string, value: string, signal?: AbortSignal): Promise<void> {
    return this.adapter.activate(this.safe("active.json"), value, signal);
  }
  prepare(): Promise<void> {
    return this.adapter.prepare?.() ?? Promise.resolve();
  }
}

/** Projects Obsidian's write-capable adapter into the strictly contained index store. */
export class ObsidianIndexStorage extends StrictIndexStorage {
  constructor(
    adapter: {
      read(path: string): Promise<string>;
      exists(path: string): Promise<boolean>;
      write(path: string, data: string): Promise<void>;
      remove(path: string): Promise<void>;
    },
    root = ".local-vault-assistant/index"
  ) {
    super(root, {
      root,
      read: async (path) => ((await adapter.exists(path)) ? adapter.read(path) : null),
      write: (path, value) => adapter.write(path, value),
      remove: (path) => adapter.remove(path),
      activate: async (path, value, signal) => {
        if (signal?.aborted) throw new Error("Index activation cancelled");
        const parent = path.slice(0, path.lastIndexOf("/"));
        const mkdir = (adapter as { mkdir?: (path: string) => Promise<void> }).mkdir;
        const rename = (adapter as { rename?: (from: string, to: string) => Promise<void> }).rename;
        if (mkdir) {
          if (!(await adapter.exists(parent))) await mkdir(parent);
          if (!(await adapter.exists(`${parent}/generations`)))
            await mkdir(`${parent}/generations`);
        }
        const temp = `${path}.tmp`;
        const backup = `${path}.bak`;
        await adapter.write(temp, value);
        if (signal?.aborted) {
          await adapter.remove(temp).catch(() => undefined);
          throw new Error("Index activation cancelled");
        }
        if (!rename) {
          await adapter.write(path, value);
          await adapter.remove(temp).catch(() => undefined);
          return;
        }
        const hadOld = await adapter.exists(path);
        let oldMovedToBackup = false;
        try {
          if (hadOld) {
            try {
              await rename(path, backup);
              oldMovedToBackup = true;
            } catch (error) {
              // The old pointer is still authoritative when this move fails.
              await adapter.remove(temp).catch(() => undefined);
              throw error;
            }
          }
          if (signal?.aborted) throw new Error("Index activation cancelled");
          await rename(temp, path);
          await adapter.remove(backup).catch(() => undefined);
        } catch (error) {
          if (oldMovedToBackup) {
            await adapter.remove(path).catch(() => undefined);
            try {
              await rename(backup, path);
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
        const mkdir = (adapter as { mkdir?: (path: string) => Promise<void> }).mkdir;
        if (mkdir) {
          if (!(await adapter.exists(root))) await mkdir(root);
          if (!(await adapter.exists(`${root}/generations`))) await mkdir(`${root}/generations`);
        }
      },
    });
  }
}

/** In-memory storage useful for tests and non-Obsidian composition. */
export class MemoryIndexStorage implements IndexStorage {
  readonly files = new Map<string, string>();
  constructor(readonly root = ".local-vault-assistant/index") {}
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
