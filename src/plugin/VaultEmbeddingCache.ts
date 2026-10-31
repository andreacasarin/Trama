import { checkAbort, isCancelled } from "@/domain/errors";
import type { DataAdapter } from "obsidian";
import {
  EMBEDDING_ARTIFACT_MAX_ENTRIES,
  EMBEDDING_ARTIFACT_MAX_FILE_BYTES,
  EMBEDDING_ARTIFACT_MAX_VECTOR_BYTES,
} from "@/index/note-sqlite/protocol";
import type { SqliteEmbeddingCache } from "@/index/SqliteEmbeddingCache";
import type { ConsoleDebug } from "@/plugin/ConsoleDebug";
import { DEFAULT_STORAGE_FOLDER, storagePaths } from "@/settings/StorageFolder";

type SharedShardCache = Pick<
  SqliteEmbeddingCache,
  | "profileFingerprint"
  | "unimportedSqliteShards"
  | "reconcileDocumentShards"
  | "importDocumentShard"
  | "exportNextDocumentShard"
  | "markDocumentShardPublished"
>;

const PROFILE_FOLDER = /^[0-9a-f]{64}$/;
const MANAGED_ARTIFACT =
  /^(?:[0-9a-f]{64}\.sqlite3|\.tmp-[0-9a-f]{64}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

export class VaultEmbeddingCache {
  private readonly folder: string;

  constructor(
    private readonly adapter: Pick<
      DataAdapter,
      "exists" | "list" | "mkdir" | "stat" | "readBinary" | "writeBinary" | "rename" | "remove"
    >,
    private readonly cache: SharedShardCache,
    private readonly dimensions: number,
    private readonly consoleDebug?: ConsoleDebug,
    storageFolder = DEFAULT_STORAGE_FOLDER
  ) {
    this.root = storagePaths(storageFolder).embeddings;
    this.folder = `${this.root}/${cache.profileFingerprint}`;
  }

  private readonly root: string;

  static async clearManagedFiles(
    adapter: Pick<DataAdapter, "exists" | "list" | "remove" | "writeBinary">,
    signal: AbortSignal,
    storageFolder = DEFAULT_STORAGE_FOLDER
  ): Promise<number> {
    const ROOT = storagePaths(storageFolder).embeddings;
    checkAbort(signal);
    const rootExists = await adapter.exists(ROOT);
    checkAbort(signal);
    if (!rootExists) return 0;
    const { folders } = await adapter.list(ROOT);
    checkAbort(signal);
    let removed = 0;
    for (const folder of folders) {
      checkAbort(signal);
      const profile = folder.slice(folder.lastIndexOf("/") + 1);
      if (!PROFILE_FOLDER.test(profile) || folder !== `${ROOT}/${profile}`) continue;
      const { files } = await adapter.list(folder);
      checkAbort(signal);
      for (const path of files) {
        checkAbort(signal);
        const name = path.slice(path.lastIndexOf("/") + 1);
        if (path !== `${folder}/${name}` || !MANAGED_ARTIFACT.test(name)) continue;
        // Persist intent before deletion so other devices do not restore a deliberate Clear.
        if (name.endsWith(".sqlite3")) {
          await adapter.writeBinary(`${folder}/${name.slice(0, 64)}.cleared`, new ArrayBuffer(0));
          checkAbort(signal);
        }
        await adapter.remove(path);
        checkAbort(signal);
        removed++;
      }
    }
    return removed;
  }

  async importAvailable(signal: AbortSignal): Promise<void> {
    checkAbort(signal);
    const finish = this.consoleDebug?.start("Embedding cache import");
    const counts = { imported: 0, invalid: 0, checksumFailures: 0, failures: 0 };
    let firstError: unknown;
    try {
      await this.ensureFolder();
      const { files } = await this.adapter.list(this.folder);
      const names = files
        .filter(
          (path) =>
            path.startsWith(`${this.folder}/`) && !path.slice(this.folder.length + 1).includes("/")
        )
        .map((path) => path.slice(path.lastIndexOf("/") + 1));
      const cleared = new Set(
        names
          .filter((name) => /^[0-9a-f]{64}\.cleared$/.test(name))
          .map((name) => name.slice(0, 64))
      );
      const checksums = names
        .filter((name) => /^[0-9a-f]{64}\.sqlite3$/.test(name))
        .map((name) => name.slice(0, 64));
      counts.invalid = names.length - checksums.length - cleared.size;
      await this.cache.reconcileDocumentShards([...new Set([...checksums, ...cleared])], signal);
      for (let offset = 0; offset < checksums.length; offset += EMBEDDING_ARTIFACT_MAX_ENTRIES) {
        const page = checksums.slice(offset, offset + EMBEDDING_ARTIFACT_MAX_ENTRIES);
        const pending = new Set(await this.cache.unimportedSqliteShards(page, signal));
        for (const checksum of page) {
          checkAbort(signal);
          if (!pending.has(checksum) || cleared.has(checksum)) continue;
          try {
            const bytes = await this.readBoundedArtifact(
              `${this.folder}/${checksum}.sqlite3`,
              signal
            );
            if (!bytes) {
              counts.invalid++;
              continue;
            }
            if ((await sha256Bytes(bytes)) !== checksum) {
              counts.checksumFailures++;
              continue;
            }
            await this.cache.importDocumentShard(checksum, bytes, signal);
            counts.imported++;
          } catch (error) {
            if (isCancelled(error)) throw error;
            checkAbort(signal);
            counts.failures++;
            firstError ??= error;
          }
        }
      }
      finish?.(
        counts.failures || counts.checksumFailures || counts.invalid
          ? "completed-with-skips"
          : "completed",
        counts,
        firstError,
        counts.failures || counts.checksumFailures || counts.invalid ? "warn" : "info"
      );
    } catch (error) {
      finish?.(signal.aborted || isCancelled(error) ? "cancelled" : "failed", counts);
      throw error;
    }
  }

  async publishAvailable(signal: AbortSignal): Promise<void> {
    checkAbort(signal);
    await this.ensureFolder();
    const perArtifact = Math.min(
      EMBEDDING_ARTIFACT_MAX_ENTRIES,
      Math.floor(EMBEDDING_ARTIFACT_MAX_VECTOR_BYTES / (this.dimensions * 4))
    );
    if (perArtifact < 1) throw new Error("Embedding vectors exceed the shared shard size limit.");
    while (true) {
      checkAbort(signal);
      const shard = await this.cache.exportNextDocumentShard(perArtifact, signal);
      if (!shard) return;
      if (
        shard.hashes.length < 1 ||
        shard.hashes.length > EMBEDDING_ARTIFACT_MAX_ENTRIES ||
        shard.bytes.byteLength >= EMBEDDING_ARTIFACT_MAX_FILE_BYTES
      )
        throw new Error("SQLite embedding shard exceeds its bounds.");
      const checksum = await sha256Bytes(shard.bytes);
      const finalPath = `${this.folder}/${checksum}.sqlite3`;
      if (await this.adapter.exists(finalPath)) {
        const existing = await this.readBoundedArtifact(finalPath, signal);
        if (!existing || (await sha256Bytes(existing)) !== checksum)
          throw new Error("Existing SQLite embedding shard failed its checksum.");
      } else {
        const temporaryPath = `${this.folder}/.tmp-${checksum}-${randomSuffix()}`;
        try {
          checkAbort(signal);
          await this.adapter.writeBinary(temporaryPath, exactArrayBuffer(shard.bytes));
          checkAbort(signal);
          await this.adapter.rename(temporaryPath, finalPath);
        } finally {
          if (await this.adapter.exists(temporaryPath))
            await this.adapter.remove(temporaryPath).catch(() => undefined);
        }
        checkAbort(signal);
        const published = await this.readBoundedArtifact(finalPath, signal);
        if (!published || (await sha256Bytes(published)) !== checksum)
          throw new Error("Published SQLite embedding shard failed its checksum.");
      }
      // A freshly generated publication may intentionally reuse a previously cleared checksum.
      const marker = `${this.folder}/${checksum}.cleared`;
      if (await this.adapter.exists(marker)) await this.adapter.remove(marker);
      checkAbort(signal);
      await this.cache.markDocumentShardPublished(checksum, shard.hashes, signal);
    }
  }

  private async ensureFolder(): Promise<void> {
    for (const path of [this.root, this.folder]) {
      if (!(await this.adapter.exists(path))) await this.adapter.mkdir(path);
    }
  }

  private async readBoundedArtifact(
    path: string,
    signal: AbortSignal
  ): Promise<Uint8Array | undefined> {
    checkAbort(signal);
    const stat = await this.adapter.stat(path);
    checkAbort(signal);
    if (!stat || stat.type !== "file" || stat.size >= EMBEDDING_ARTIFACT_MAX_FILE_BYTES) return;
    const bytes = new Uint8Array(await this.adapter.readBinary(path));
    checkAbort(signal);
    return bytes.byteLength < EMBEDDING_ARTIFACT_MAX_FILE_BYTES ? bytes : undefined;
  }
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const input = bytes.slice().buffer as ArrayBuffer;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function randomSuffix(): string {
  return crypto.randomUUID();
}
