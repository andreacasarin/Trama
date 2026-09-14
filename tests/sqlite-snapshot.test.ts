import { describe, expect, it } from "vitest";
import { IndexManager, type IndexVaultPort, type SnapshotDataAdapter } from "@/index/IndexManager";
import { createTestSqliteClient } from "./sqlite-test-client";
import { SQLITE_SNAPSHOT_MAX_BYTES, SQLITE_SNAPSHOT_NAMESPACE } from "@/index/sqlite/protocol";

const contentId = "a".repeat(64);
const vault: IndexVaultPort = {
  listMarkdownPaths: async () => ["one.md"],
  readMarkdown: async () => ({ path: "one.md", content: "alpha" }),
};
const embedding = {
  dimensions: 2,
  embed: async (texts: readonly string[]) => texts.map(() => [1, 0]),
};

function adapter(): SnapshotDataAdapter & {
  files: Map<string, Uint8Array>;
  metadata: Map<string, string>;
} {
  const files = new Map<string, Uint8Array>();
  const metadata = new Map<string, string>();
  return {
    files,
    metadata,
    exists: async function (path) {
      return this.files.has(path) || this.metadata.has(path);
    },
    mkdir: async function () {
      void this;
    },
    readBinary: async function (path) {
      return this.files.get(path)!.slice().buffer;
    },
    writeBinary: async function (path, value) {
      this.files.set(path, new Uint8Array(value.slice(0)));
    },
    write: async function (path, value) {
      this.metadata.set(path, value);
    },
  };
}

describe("explicit SQLite snapshots", () => {
  it("exports immutable content-addressed bytes and imports as incomplete", async () => {
    const storage = adapter();
    const identity = {};
    const manager = new IndexManager(vault, embedding, identity, "http://embedding", "model", {
      snapshotAdapter: storage,
      sqliteIdentity: "test",
      sqliteClient: createTestSqliteClient(identity),
    });
    await manager.load();
    await manager.build(new AbortController().signal);
    const before = await manager.search("alpha", new AbortController().signal, 5);
    const exported = await manager.exportSnapshot();

    expect(exported.path).toBe(`${SQLITE_SNAPSHOT_NAMESPACE}/${exported.sha256}.sqlite3`);
    expect(storage.files.has(exported.path)).toBe(true);
    expect(
      JSON.parse(storage.metadata.get(`${SQLITE_SNAPSHOT_NAMESPACE}/${exported.sha256}.json`)!)
        .incomplete
    ).toBe(false);

    const imported = await manager.importSnapshot({
      bytes: exported.bytes,
      sha256: exported.sha256,
    });
    expect(imported.incomplete).toBe(true);
    expect(imported.changeCounter).toBeGreaterThan(0);
    await expect(
      manager.importSnapshot({ bytes: exported.bytes, sha256: "0".repeat(64) })
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      manager.importSnapshot({ bytes: exported.bytes.slice(0, 4), sha256: exported.sha256 })
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      manager.importSnapshot({
        bytes: new ArrayBuffer(SQLITE_SNAPSHOT_MAX_BYTES + 1),
        sha256: "0".repeat(64),
      })
    ).rejects.toMatchObject({ code: "limit_exceeded" });
    expect(await manager.search("alpha", new AbortController().signal, 5)).toEqual(before);
  });

  it("keeps the live state when temporary validation rejects a tampered snapshot", async () => {
    const client = createTestSqliteClient({});
    const fingerprint = "b".repeat(64);
    await client.call("boot", { fingerprint, dimensions: 2, identity: "c".repeat(64) });
    const note = {
      path: "one.md",
      contentId,
      chunks: [
        {
          id: `${contentId}:0`,
          ordinal: 0,
          startLine: 1,
          endLine: 1,
          text: "alpha",
          vector: new Float32Array([1, 0]),
        },
      ],
    };
    await client.call("upsertNote", { note });
    const before = await client.call("listNotes", {});
    const bytes = await client.call("export", {});
    const tampered = bytes.slice(0);
    new Uint8Array(tampered)[68] ^= 1;
    await expect(client.call("import", { bytes: tampered })).rejects.toMatchObject({
      error: { code: expect.stringMatching(/integrity|incompatible/) },
    });
    expect(await client.call("listNotes", {})).toEqual(before);
  });
});
