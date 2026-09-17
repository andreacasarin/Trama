import { describe, expect, it, vi } from "vitest";
import {
  PublicationManager,
  type PublicationIndexPort,
} from "@/index/publications/PublicationManager";
import { type PublicationDataAdapter } from "@/index/publications/PublicationStore";
import type {
  PublicationInspection,
  PublicationPrepared,
  SqliteState,
} from "@/index/sqlite/protocol";

const state = (publicationId?: string): SqliteState => ({
  schemaVersion: 5,
  protocolVersion: 4,
  buildIdentity: "build",
  dimensions: 2,
  corpusFingerprint: "corpus",
  embeddingFingerprint: "embedding",
  incomplete: false,
  snapshotLoaded: false,
  changeCounter: 3,
  noteCount: 1,
  chunkCount: 1,
  compatibleVectorCount: 1,
  vectorCount: 1,
  vectorCoverage: "complete",
  semanticReady: true,
  ...(publicationId ? { publicationId } : {}),
});

function setup() {
  const files = new Map<string, Uint8Array>();
  const adapter: PublicationDataAdapter = {
    readBinary: async (path) => {
      const bytes = files.get(path);
      if (!bytes) throw new Error("missing");
      return bytes.slice().buffer;
    },
    writeBinary: async (path, bytes) => {
      files.set(path, new Uint8Array(bytes.slice(0)));
    },
    mkdir: async () => undefined,
    rename: async (from, to) => {
      files.set(to, files.get(from)!);
      files.delete(from);
    },
    remove: async (path) => {
      files.delete(path);
    },
  };
  let live = state();
  let stagedId: string | undefined;
  const bytes = new Uint8Array([9, 8, 7]).buffer;
  const index: PublicationIndexPort = {
    async publishPublication<T>(
      publicationId: string,
      install: (prepared: PublicationPrepared) => Promise<T>,
      settle?: (committed: boolean) => Promise<void>
    ) {
      stagedId = publicationId;
      const prepared: PublicationPrepared = {
        publicationId,
        state: { ...live, publicationId },
        bytes,
        byteSize: bytes.byteLength,
        durationMs: 1,
        copyBytes: bytes.byteLength,
      };
      const installed = await install(prepared);
      live = state(publicationId);
      await settle?.(true);
      return { prepared, installed };
    },
    inspectPublication: vi.fn(async (): Promise<PublicationInspection> => ({
      valid: true,
      publicationId: stagedId ?? "remote",
      state: state(stagedId ?? "remote"),
      byteSize: bytes.byteLength,
    })),
    adoptPublication: vi.fn(async (_bytes, id) => {
      live = state(id);
      return live;
    }),
    getState: vi.fn(async () => live),
  };
  const publish = vi.spyOn(index, "publishPublication");
  return { adapter, index, publish, bytes, getLive: () => live };
}

describe("PublicationManager", () => {
  it("publishes converged operations and validates the installed copy", async () => {
    const fixture = setup();
    const metrics: unknown[] = [];
    const manager = new PublicationManager(fixture.index, fixture.adapter, {
      idFactory: () => "publication-1",
      onMetrics: (value) => metrics.push(value),
    });
    const result = await manager.publishAfterSuccessfulOperation({
      operation: "build",
      changed: true,
      converged: true,
      state: state(),
    });
    expect(result).toMatchObject({ published: true, publicationId: "publication-1" });
    expect(metrics).toHaveLength(1);
    expect(fixture.publish).toHaveBeenCalledTimes(1);
    expect(fixture.index.inspectPublication).toHaveBeenCalledTimes(1);
    expect(fixture.getLive().publicationId).toBe("publication-1");
  });

  it("can finish publication after inspection transfers the read-back buffer", async () => {
    const fixture = setup();
    const manager = new PublicationManager(fixture.index, fixture.adapter, {
      idFactory: () => "transferred",
    });
    vi.mocked(fixture.index.inspectPublication).mockImplementation(
      async (bytes, transferOwnership) => {
        expect(transferOwnership).toBe(true);
        structuredClone(bytes, { transfer: [bytes] });
        return {
          valid: true,
          publicationId: "transferred",
          state: state("transferred"),
          byteSize: 3,
        };
      }
    );

    await expect(manager.publish()).resolves.toMatchObject({ published: true });
    expect([...new Uint8Array((await manager.store.read())!)]).toEqual([9, 8, 7]);
  });

  it("coalesces exact-file events and adopts a differing ID without republishing", async () => {
    const fixture = setup();
    const manager = new PublicationManager(fixture.index, fixture.adapter, { debounceMs: 100 });
    await manager.store.replace(await manager.store.stage(fixture.bytes, "remote"));
    manager.notifyFileEvent("Trama/index/index.sqlite3");
    manager.notifyFileEvent("Trama/index/index.sqlite3");
    manager.notifyFileEvent("other.md");
    expect(await manager.flushPendingEvents()).toMatchObject({ adopted: true });
    expect(fixture.index.inspectPublication).toHaveBeenCalledTimes(1);
    expect(fixture.index.adoptPublication).toHaveBeenCalledTimes(1);
    expect(fixture.publish).not.toHaveBeenCalled();
  });

  it("retries a failed stage from the current local index", async () => {
    const fixture = setup();
    let fail = true;
    const originalWrite = fixture.adapter.writeBinary!;
    fixture.adapter.writeBinary = async (path, bytes) => {
      if (fail) {
        fail = false;
        throw new Error("offline");
      }
      return originalWrite(path, bytes);
    };
    const manager = new PublicationManager(fixture.index, fixture.adapter, {
      idFactory: () => "publication-2",
    });
    await expect(manager.publish()).resolves.toMatchObject({
      published: false,
      warning: { phase: "stage" },
    });
    expect(fixture.getLive().publicationId).toBeUndefined();
    await expect(manager.publish()).resolves.toMatchObject({
      published: true,
      publicationId: "publication-2",
    });
    expect(fixture.publish).toHaveBeenCalledTimes(2);
  });

  it("rejects an invalid staged SQLite copy before replacing the canonical file", async () => {
    const fixture = setup();
    const manager = new PublicationManager(fixture.index, fixture.adapter, {
      idFactory: () => "publication-3",
    });
    await manager.store.replace(await manager.store.stage(fixture.bytes, "old"));
    const oldBytes = await manager.store.read();
    vi.mocked(fixture.index.inspectPublication).mockRejectedValueOnce(new Error("invalid SQLite"));
    await expect(manager.publish()).resolves.toMatchObject({
      published: false,
      warning: { phase: "inspect" },
    });
    expect(await manager.store.read()).toEqual(oldBytes);
    expect(fixture.getLive().publicationId).toBeUndefined();
  });
});
