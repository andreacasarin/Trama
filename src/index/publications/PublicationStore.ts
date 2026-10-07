import { StructuredError } from "@/domain/contracts";
import { sha256Hex } from "@/index/Identity";
import { SQLITE_CACHE_SHARD_MAX_BYTES } from "@/index/sqlite/protocol";

/** The small part of an Obsidian DataAdapter needed for one synchronized file. */
export interface PublicationDataAdapter {
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, value: ArrayBuffer): Promise<void>;
  mkdir?(path: string): Promise<void>;
  exists?(path: string): Promise<boolean>;
  stat(path: string): Promise<{ readonly size: number } | null>;
  rename?(oldPath: string, newPath: string): Promise<void>;
  remove?(path: string): Promise<void>;
  list?(
    path: string
  ):
    | Promise<{ readonly files: readonly string[]; readonly folders: readonly string[] }>
    | { readonly files: readonly string[]; readonly folders: readonly string[] };
}

export interface PublicationStoreOptions {
  /** Defaults to `Trama/index`, the persisted POC publication location. */
  readonly directory?: unknown;
  /** Used by tests and keeps temporary names independent from publication ordering. */
  readonly temporaryToken?: () => string;
}

export interface CacheShardFile {
  readonly path: string;
  readonly digest: string;
}

const DEFAULT_PUBLICATION_DIRECTORY = "Trama/index";

/**
 * Normalize a case-sensitive vault-relative directory.
 *
 * Empty path segments and `./` are redundant; root, absolute, drive-letter,
 * NUL-containing, `.` and `..` paths are not valid publication directories.
 */
export function normalizePublicationDirectory(
  value: unknown,
  fallback = DEFAULT_PUBLICATION_DIRECTORY
): string {
  const normalized = normalizeDirectory(value);
  if (normalized) return normalized;
  const safeFallback = normalizeDirectory(fallback);
  if (!safeFallback) throw new Error("Publication directory fallback is invalid.");
  return safeFallback;
}

function normalizeDirectory(value: unknown): string | undefined {
  if (typeof value !== "string" || value.includes("\0")) return undefined;
  let raw = value.trim().replace(/\\/g, "/");
  if (!raw || raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) return undefined;
  while (raw.startsWith("./")) raw = raw.slice(2);
  const parts = raw
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) return undefined;
  return parts.join("/");
}

function safeToken(value: string): string {
  const token = value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  return token || "candidate";
}

/** Owns immutable SHA-256-named embedding cache shards. */
export class PublicationStore {
  readonly directory: string;
  readonly cacheDirectory: string;
  private readonly token: () => string;

  constructor(
    private readonly adapter: PublicationDataAdapter,
    options: PublicationStoreOptions = {}
  ) {
    // Capture the normalized setting once. A later settings recomposition gets
    // a new store; an in-flight publication never changes destination halfway through.
    this.directory = normalizePublicationDirectory(options.directory);
    this.cacheDirectory = `${this.directory}/cache-v1`;
    this.token = options.temporaryToken ?? (() => randomToken());
  }

  async ensureDirectory(): Promise<void> {
    if (this.adapter.mkdir) await this.adapter.mkdir(this.directory);
  }

  async listCacheShards(): Promise<readonly CacheShardFile[]> {
    if (!this.adapter.list) return [];
    if (this.adapter.exists && !(await this.adapter.exists(this.cacheDirectory))) return [];
    const listed = await this.adapter.list(this.cacheDirectory);
    return listed.files.flatMap((listedPath) => {
      const path = listedPath.startsWith(`${this.cacheDirectory}/`)
        ? listedPath
        : `${this.cacheDirectory}/${listedPath}`;
      const name = path.slice(path.lastIndexOf("/") + 1);
      const match = name.match(/^cache-([0-9a-f]{64})\.sqlite3$/);
      return match ? [{ path, digest: match[1] }] : [];
    });
  }

  supportsCacheShardListing(): boolean {
    return this.adapter.list !== undefined;
  }

  async cacheShardSize(path: string): Promise<number | undefined> {
    return (await this.adapter.stat(path))?.size;
  }

  async readCacheShard(path: string): Promise<ArrayBuffer> {
    if (!path.startsWith(`${this.cacheDirectory}/cache-`))
      throw new StructuredError("invalid_request", "Cache shard path is invalid.", false);
    return this.readBoundedShard(path);
  }

  private async readBoundedShard(path: string): Promise<ArrayBuffer> {
    const size = await this.cacheShardSize(path);
    if (
      size === undefined ||
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      size > SQLITE_CACHE_SHARD_MAX_BYTES
    )
      throw new StructuredError("invalid_request", "Cache shard size is invalid.", false);
    const bytes = await this.adapter.readBinary(path);
    if (bytes.byteLength === 0 || bytes.byteLength > SQLITE_CACHE_SHARD_MAX_BYTES)
      throw new StructuredError("invalid_request", "Cache shard size is invalid.", false);
    return bytes;
  }

  async removeCacheShard(digest: string): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(digest) || !this.adapter.remove)
      throw new StructuredError("invalid_request", "Cache shard removal is unavailable.", false);
    await this.adapter.remove(`${this.cacheDirectory}/cache-${digest}.sqlite3`);
  }

  async installCacheShard(bytes: ArrayBuffer, digest: string): Promise<boolean> {
    if (!/^[0-9a-f]{64}$/.test(digest) || (await sha256Hex(bytes)) !== digest)
      throw new StructuredError("invalid_request", "Cache shard digest is invalid.", false);
    await this.ensureDirectory();
    if (this.adapter.mkdir) await this.adapter.mkdir(this.cacheDirectory);
    const path = `${this.cacheDirectory}/cache-${digest}.sqlite3`;
    if (await this.existsPath(path)) {
      if ((await sha256Hex(await this.readBoundedShard(path))) !== digest)
        throw new StructuredError(
          "internal",
          "Existing immutable cache shard failed its name hash.",
          true
        );
      return false;
    }
    if (!this.adapter.rename)
      throw new StructuredError(
        "internal",
        "Cache shard publication requires atomic rename.",
        true
      );
    const temporaryPath = `${path}.trama-tmp-${safeToken(this.token())}`;
    await this.adapter.writeBinary(temporaryPath, bytes);
    try {
      const readback = await this.readBoundedShard(temporaryPath);
      if ((await sha256Hex(readback)) !== digest)
        throw new StructuredError("internal", "Cache shard readback hash mismatch.", true);
      if (await this.existsPath(path)) {
        await this.removeQuietly(temporaryPath);
        if ((await sha256Hex(await this.readBoundedShard(path))) !== digest)
          throw new StructuredError(
            "internal",
            "Existing immutable cache shard failed its name hash.",
            true
          );
        return false;
      }
      await this.adapter.rename(temporaryPath, path);
      return true;
    } catch (error) {
      await this.removeQuietly(temporaryPath);
      throw error;
    }
  }

  async clearCacheShards(): Promise<void> {
    if (!this.adapter.remove) return;
    for (const shard of await this.listCacheShards()) await this.adapter.remove(shard.path);
  }

  private async removeQuietly(path: string): Promise<void> {
    try {
      await this.adapter.remove?.(path);
    } catch {
      // A stray reserved temp file is harmless and is ignored on discovery.
    }
  }

  private async existsPath(path: string): Promise<boolean> {
    if (this.adapter.exists) return this.adapter.exists(path);
    return (await this.adapter.stat(path)) !== null;
  }
}

function randomToken(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

export { DEFAULT_PUBLICATION_DIRECTORY };
