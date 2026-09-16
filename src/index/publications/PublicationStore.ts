import { StructuredError } from "@/domain/contracts";

/** The small part of an Obsidian DataAdapter needed for one synchronized file. */
export interface PublicationDataAdapter {
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, value: ArrayBuffer): Promise<void>;
  mkdir?(path: string): Promise<void>;
  exists?(path: string): Promise<boolean>;
  rename?(oldPath: string, newPath: string): Promise<void>;
  remove?(path: string): Promise<void>;
}

/** Short boundary alias for callers that do not need the Obsidian-specific name. */
export type DataAdapter = PublicationDataAdapter;

export interface PublicationStoreOptions {
  /** Defaults to `Trama/index`, the persisted POC publication location. */
  readonly directory?: unknown;
  /** Used by tests and keeps temporary names independent from publication ordering. */
  readonly temporaryToken?: () => string;
}

export interface StagedPublication {
  readonly temporaryPath: string;
  readonly bytes: ArrayBuffer;
  readonly byteSize: number;
  readonly copyBytes: number;
}

const TRANSIENT_BACKUP_SUFFIX = ".trama-backup";

const DEFAULT_PUBLICATION_DIRECTORY = "Trama/index";
const PUBLICATION_FILE = "index.sqlite3";

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

function copyBytes(bytes: ArrayBuffer): ArrayBuffer {
  return bytes.slice(0);
}

function safeToken(value: string): string {
  const token = value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  return token || "candidate";
}

/** Owns the captured target and staged replacement of `<directory>/index.sqlite3`. */
export class PublicationStore {
  readonly directory: string;
  readonly path: string;
  private readonly token: () => string;

  constructor(
    private readonly adapter: PublicationDataAdapter,
    options: PublicationStoreOptions = {}
  ) {
    // Capture the normalized setting once. A later settings recomposition gets
    // a new store; an in-flight publication never changes destination halfway through.
    this.directory = normalizePublicationDirectory(options.directory);
    this.path = `${this.directory}/${PUBLICATION_FILE}`;
    this.token = options.temporaryToken ?? (() => randomToken());
  }

  get targetPath(): string {
    return this.path;
  }

  temporaryPath(token = this.token()): string {
    return `${this.path}.trama-tmp-${safeToken(token)}`;
  }

  async ensureDirectory(): Promise<void> {
    if (this.adapter.mkdir) await this.adapter.mkdir(this.directory);
  }

  /** Recover an interrupted promote, leaving only the authoritative target. */
  async recoverTransient(): Promise<void> {
    const backup = this.backupPath;
    if (!(await this.existsPath(backup))) return;
    if (await this.existsPath(this.path)) {
      await this.removeQuietly(backup);
      return;
    }
    if (this.adapter.rename) await this.adapter.rename(backup, this.path);
  }

  get backupPath(): string {
    return `${this.path}${TRANSIENT_BACKUP_SUFFIX}`;
  }

  async read(): Promise<ArrayBuffer | undefined> {
    await this.recoverTransient();
    if (this.adapter.exists && !(await this.adapter.exists(this.path))) return undefined;
    try {
      return await this.adapter.readBinary(this.path);
    } catch (error) {
      if (this.adapter.exists) throw error;
      // Adapters without exists() commonly signal an absent file by rejecting.
      return undefined;
    }
  }

  /** Write a reserved sibling, then read it back before any replacement. */
  async stage(bytes: ArrayBuffer, token?: string): Promise<StagedPublication> {
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength === 0)
      throw new StructuredError("invalid_request", "Publication bytes are empty.", false);
    await this.ensureDirectory();
    await this.recoverTransient();
    const staged = copyBytes(bytes);
    const temporaryPath = this.temporaryPath(token);
    await this.adapter.writeBinary(temporaryPath, staged);
    const readback = await this.adapter.readBinary(temporaryPath);
    if (readback.byteLength !== staged.byteLength || !sameBytes(readback, staged)) {
      await this.removeQuietly(temporaryPath);
      throw new StructuredError("internal", "Publication readback validation failed.", true);
    }
    return {
      temporaryPath,
      bytes: readback,
      byteSize: readback.byteLength,
      // The staged copy and adapter readback are the operation-scoped copies.
      copyBytes: staged.byteLength + readback.byteLength,
    };
  }

  /** Install only the exact configured file; temporary files are never discoverable targets. */
  async replace(staged: StagedPublication, retainBackup = false): Promise<boolean> {
    if (staged.temporaryPath === this.path)
      throw new StructuredError(
        "invalid_request",
        "A temporary publication path is required.",
        false
      );
    if (this.adapter.rename) {
      await this.recoverTransient();
      if (!(await this.existsPath(this.path))) {
        await this.adapter.rename(staged.temporaryPath, this.path);
        return false;
      }

      // Do not depend on DataAdapter.rename overwriting an existing file.
      // The fixed backup is transient and is recovered on the next read/check.
      const backup = this.backupPath;
      await this.removeQuietly(backup);
      await this.adapter.rename(this.path, backup);
      try {
        await this.adapter.rename(staged.temporaryPath, this.path);
      } catch (error) {
        try {
          if (await this.existsPath(this.path)) await this.adapter.remove?.(this.path);
          await this.adapter.rename(backup, this.path);
        } catch {
          // Keep the backup for recoverTransient() on the next startup/check.
        }
        throw error;
      }
      if (!retainBackup) await this.removeQuietly(backup);
      return true;
    }
    // Replacement must be one adapter-level rename. A write fallback can
    // truncate the old target before the new bytes are durably installed.
    throw new StructuredError(
      "internal",
      "The publication adapter does not support atomic rename.",
      true
    );
  }

  async finishReplacement(): Promise<void> {
    await this.removeQuietly(this.backupPath);
  }

  async rollbackReplacement(hadPrevious: boolean): Promise<void> {
    if (!this.adapter.remove || !this.adapter.rename)
      throw new StructuredError("internal", "Publication cannot be rolled back.", true);
    if (hadPrevious && !(await this.existsPath(this.backupPath)))
      throw new StructuredError("internal", "Previous publication backup is missing.", true);
    if (await this.existsPath(this.path)) await this.adapter.remove(this.path);
    if (hadPrevious) await this.adapter.rename(this.backupPath, this.path);
  }

  async install(bytes: ArrayBuffer, token?: string): Promise<StagedPublication> {
    const staged = await this.stage(bytes, token);
    try {
      await this.replace(staged);
      return staged;
    } catch (error) {
      await this.removeQuietly(staged.temporaryPath);
      throw error;
    }
  }

  async removeTemporary(path: string): Promise<void> {
    if (!path.startsWith(`${this.path}.trama-tmp-`)) return;
    await this.removeQuietly(path);
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
    try {
      await this.adapter.readBinary(path);
      return true;
    } catch {
      return false;
    }
  }
}

function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
  return true;
}

function randomToken(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

export { DEFAULT_PUBLICATION_DIRECTORY, PUBLICATION_FILE };
