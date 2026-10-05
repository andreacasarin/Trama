import { describe, expect, it } from "vitest";
import { SQLITE_BUILD_IDENTITY } from "@/build/identity";
import { IndexManager, type IndexVaultPort } from "@/index/IndexManager";
import { MutableSqliteDatabase } from "@/index/sqlite/database";
import {
  createTestSqliteClient,
  loadTestSqlite,
  snapshotFor,
  snapshotWithUserVersion,
} from "./sqlite-test-client";

const embedding = {
  dimensions: 2,
  embed: async (texts: readonly string[]) => texts.map(() => [1, 0]),
};

function index(identity: object, path: string, text: string) {
  const vault: IndexVaultPort = {
    listMarkdownPaths: async () => [path],
    readMarkdown: async () => ({ path, content: text }),
  };
  return new IndexManager(vault, embedding, "http://embedding", "model", {
    publicationDirectory: "Trama/index",
    sqliteClient: createTestSqliteClient(identity),
  });
}

async function openCandidate(
  bytes: Uint8Array,
  state: {
    corpusFingerprint: string;
    embeddingFingerprint: string;
  }
) {
  const sqlite = await loadTestSqlite();
  const raw = new sqlite.oo1.DB(":memory:", "c");
  const pointer = sqlite.wasm.allocFromTypedArray(bytes);
  const flags =
    sqlite.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite.capi.SQLITE_DESERIALIZE_RESIZEABLE;
  const result = sqlite.capi.sqlite3_deserialize(
    raw.pointer,
    "main",
    pointer,
    bytes.byteLength,
    bytes.byteLength,
    flags
  );
  if (result !== 0) throw new Error("Failed to open legacy candidate");
  const database = new MutableSqliteDatabase(raw);
  database.validateSnapshot(
    state.corpusFingerprint,
    2,
    state.embeddingFingerprint,
    SQLITE_BUILD_IDENTITY
  );
  return { raw, database };
}

describe("legacy SQLite cache extraction foundations", () => {
  it.each([10, 9])(
    "migrates a schema-%i candidate in isolation and keeps semantic coverage",
    async (version) => {
      const identity = {};
      const source = index(identity, "remote.md", "remote semantic phrase");
      await source.build(new AbortController().signal);
      await source.prepareSemantic(new AbortController().signal);
      const sourceState = await source.getState();
      expect(sourceState?.semanticReady).toBe(true);
      const bytes = new Uint8Array(await snapshotFor(identity));
      const legacy = await snapshotWithUserVersion(bytes, version, {
        ...(version === 9 ? { legacySchema9: true } : { legacySchema10: true }),
      });

      const candidate = await openCandidate(legacy, sourceState!);
      expect(candidate.database.getState()).toMatchObject({
        schemaVersion: 14,
        noteCount: 1,
        compatibleVectorCount: sourceState!.compatibleVectorCount,
        semanticReady: true,
      });
      expect(
        Number(candidate.raw.selectValue("SELECT count(*) FROM embedding_cache"))
      ).toBeGreaterThan(0);
      expect(
        Number(candidate.raw.selectValue("SELECT count(*) FROM cache_artifact_receipts"))
      ).toBe(0);
      candidate.database.close();
      expect(bytes).toEqual(new Uint8Array(await snapshotFor(identity)));
    }
  );

  it("rejects an incompatible schema-10 candidate without changing its bytes or any local head", async () => {
    const sourceIdentity = {};
    const source = index(sourceIdentity, "remote.md", "remote phrase");
    await source.build(new AbortController().signal);
    await source.prepareSemantic(new AbortController().signal);
    const sourceState = await source.getState();
    const sourceBytes = new Uint8Array(await snapshotFor(sourceIdentity));
    const legacy = await snapshotWithUserVersion(sourceBytes, 10, { legacySchema10: true });

    const localIdentity = {};
    const local = index(localIdentity, "local.md", "local only phrase");
    await local.build(new AbortController().signal);
    const localBefore = await local.getState();
    const sqlite = await loadTestSqlite();
    const raw = new sqlite.oo1.DB(":memory:", "c");
    const badBytes = new Uint8Array(legacy);
    const pointer = sqlite.wasm.allocFromTypedArray(badBytes);
    const flags =
      sqlite.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite.capi.SQLITE_DESERIALIZE_RESIZEABLE;
    sqlite.capi.sqlite3_deserialize(
      raw.pointer,
      "main",
      pointer,
      badBytes.byteLength,
      badBytes.byteLength,
      flags
    );
    raw.exec("UPDATE index_state SET build_identity='foreign-build'");
    const tampered = new Uint8Array(sqlite.capi.sqlite3_js_db_export(raw.pointer));
    raw.close();

    await expect(openCandidate(tampered, sourceState!)).rejects.toThrow(
      "Legacy SQLite state is incompatible"
    );
    expect(await local.getState()).toEqual(localBefore);
    await expect(local.search("local only", new AbortController().signal, 5)).resolves.toHaveLength(
      1
    );
  });
});
