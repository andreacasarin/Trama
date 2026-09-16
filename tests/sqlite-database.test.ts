import { describe, expect, it } from "vitest";
import { literalTerms, safeFtsQuery } from "@/index/sqlite/database";
import { schemaSql } from "@/index/sqlite/schema";
import { MutableSqliteDatabase } from "@/index/sqlite/database";
import { hashMarkdown, upsertMarkdown } from "@/index/sqlite/markdown";
import { chunkMarkdown } from "@/index/chunking";
import { loadTestSqlite } from "./sqlite-test-client";

describe("SQLite schema/query foundation", () => {
  it("hashes and chunks Markdown before one guarded lexical upsert", async () => {
    const sqlite = await loadTestSqlite();
    const raw = new sqlite.oo1.DB(":memory:", "c");
    const index = new MutableSqliteDatabase(raw);
    const fingerprint = "c".repeat(64);
    const markdown = "alpha\r\nbeta\n" + "long ".repeat(100);
    index.boot(fingerprint, 2);
    const contentId = await hashMarkdown(markdown, fingerprint);

    const stale = await upsertMarkdown(index, "note.md", markdown, "0".repeat(64), 100, 10);
    expect(stale).toMatchObject({ status: "state_changed", changed: false, rescan: true });
    expect(index.getState().noteCount).toBe(0);

    const result = await upsertMarkdown(index, "note.md", markdown, contentId, 100, 10);
    expect(result.chunkCount).toBe(chunkMarkdown(markdown, 100, 10).length);
    expect(index.listNotes()).toMatchObject([{ path: "note.md", contentId }]);
    expect(index.retrieve("long", undefined, 5)).toHaveLength(5);
    index.close();
  });

  it("does not write a note after an indexing job is cancelled", async () => {
    const sqlite = await loadTestSqlite();
    const raw = new sqlite.oo1.DB(":memory:", "c");
    const index = new MutableSqliteDatabase(raw);
    const fingerprint = "c".repeat(64);
    index.boot(fingerprint, 2);
    const controller = new AbortController();
    controller.abort();

    await expect(
      upsertMarkdown(index, "note.md", "alpha", "0".repeat(64), 384, 64, controller.signal)
    ).rejects.toMatchObject({ error: { code: "cancelled" } });
    expect(index.getState().noteCount).toBe(0);
    index.close();
  });

  it("bounds literal FTS terms without evaluating query grammar", () => {
    expect(literalTerms('alpha OR beta "quoted" -tag')).toEqual([
      "alpha",
      "or",
      "beta",
      "quoted",
      "-tag",
    ]);
    expect(literalTerms("   ")).toEqual([]);
    expect(safeFtsQuery("alpha OR beta")).toBe('"alpha" AND "or" AND "beta"');
  });

  it("declares strict state, binary identities, and synchronous FTS triggers", () => {
    const sql = schemaSql(768);
    expect(sql).toContain("PRAGMA synchronous=FULL");
    expect(sql).toContain("STRICT");
    expect(sql).toContain("snapshot_loaded INTEGER NOT NULL DEFAULT 0");
    expect(sql).toContain("COLLATE BINARY");
    expect(sql).toContain("CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5");
    expect(sql).not.toContain("chunks_vec");
    expect(sql).toContain("CREATE TRIGGER IF NOT EXISTS chunks_ai");
    expect(sql).toContain("CREATE TRIGGER IF NOT EXISTS chunks_ad");
    expect(sql).toContain("CREATE TRIGGER IF NOT EXISTS chunks_au_fts");
    expect(sql).not.toContain("chunks_au_vec");
    expect(sql).not.toContain("CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE");
  });

  it("opens the audited local SQLite build and atomically maintains FTS and vectors", async () => {
    const sqlite = await loadTestSqlite();
    const db = new sqlite.oo1.DB(":memory:", "c");
    const index = new MutableSqliteDatabase(db);
    const hash = "b".repeat(64);
    expect(index.boot("c".repeat(64), 2).incomplete).toBe(true);
    expect(
      index.upsertNote({
        path: "a.md",
        contentId: hash,
        chunks: [
          {
            id: `${hash}:0`,
            ordinal: 0,
            startLine: 1,
            endLine: 1,
            text: "alpha",
          },
        ],
      }).changed
    ).toBe(true);
    const [missing] = index.listMissingVectors("", 1);
    index.storeVectors(
      [
        {
          chunkPk: missing.chunkPk,
          chunkId: missing.chunkId,
          contentId: missing.contentId,
          vector: new Float32Array([1, 0]),
        },
      ],
      "",
      index.getState().changeCounter
    );
    expect(index.retrieve("alpha", undefined, 5)[0].path).toBe("a.md");
    expect(index.retrieve(undefined, new Float32Array([1, 0]), 5)[0].score).toBe(1);
    const beforeRename = index.retrieve(undefined, new Float32Array([1, 0]), 1)[0];
    expect(index.renameNote("a.md", "renamed.md").changed).toBe(true);
    expect(index.listNotes()[0].path).toBe("renamed.md");
    expect(index.retrieve(undefined, new Float32Array([1, 0]), 1)[0]).toMatchObject({
      path: "renamed.md",
      score: beforeRename.score,
    });
    index.close();
  });

  it("reports the full note count in durable state", async () => {
    const sqlite = await loadTestSqlite();
    const db = new sqlite.oo1.DB(":memory:", "c");
    const index = new MutableSqliteDatabase(db);
    index.boot("c".repeat(64), 2);
    index.upsertNote({ path: "one.md", contentId: "1".repeat(64), chunks: [] });
    index.upsertNote({ path: "two.md", contentId: "2".repeat(64), chunks: [] });
    expect(index.getState()).toMatchObject({ noteCount: 2, chunkCount: 0 });
    index.close();
  });

  it("persists snapshot provenance and clears it at stable reconciliation", async () => {
    const sqlite = await loadTestSqlite();
    const db = new sqlite.oo1.DB(":memory:", "c");
    const index = new MutableSqliteDatabase(db);
    index.boot("c".repeat(64), 2);
    const mutation = index.upsertNote({
      path: "a.md",
      contentId: "1".repeat(64),
      chunks: [],
    });
    const summaries = [{ path: "a.md", contentId: "1".repeat(64), chunkCount: 0 }];
    const state = index.finishReconciliation(summaries, mutation.state.changeCounter);
    expect(state).toMatchObject({ incomplete: false, snapshotLoaded: false });
    expect(index.markSnapshotLoaded().snapshotLoaded).toBe(true);
    const noOp = index.finishReconciliation(summaries, index.getState().changeCounter);
    expect(noOp).toMatchObject({ incomplete: false, snapshotLoaded: false });
    index.close();
  });

  it("rejects candidate vectors whose chunk identity does not match", async () => {
    const sqlite = await loadTestSqlite();
    const db = new sqlite.oo1.DB(":memory:", "c");
    const index = new MutableSqliteDatabase(db);
    index.boot("c".repeat(64), 2);
    index.upsertNote({
      path: "a.md",
      contentId: "1".repeat(64),
      chunks: [{ id: "chunk-1", ordinal: 0, startLine: 1, endLine: 1, text: "alpha" }],
    });
    db.exec({
      sql: "INSERT INTO chunk_vectors(chunk_pk,content_id,chunk_id,embedding_fingerprint,vector) VALUES(?,?,?,?,?)",
      bind: [1, "wrong", "chunk-1", "", new Uint8Array(new Float32Array([1, 0]).buffer)],
    });
    expect(() => index.validateSnapshot("c".repeat(64), 2, "")).toThrow("chunk/content identity");
    index.close();
  });

  it("rejects candidate vectors that are non-finite or outside normalization tolerance", async () => {
    const sqlite = await loadTestSqlite();
    const db = new sqlite.oo1.DB(":memory:", "c");
    const index = new MutableSqliteDatabase(db);
    index.boot("c".repeat(64), 2);
    index.upsertNote({
      path: "a.md",
      contentId: "1".repeat(64),
      chunks: [{ id: "chunk-1", ordinal: 0, startLine: 1, endLine: 1, text: "alpha" }],
    });
    db.exec({
      sql: "INSERT INTO chunk_vectors(chunk_pk,content_id,chunk_id,embedding_fingerprint,vector) VALUES(?,?,?,?,?)",
      bind: [1, "1".repeat(64), "chunk-1", "", new Uint8Array(new Float32Array([2, 0]).buffer)],
    });
    expect(() => index.validateSnapshot("c".repeat(64), 2, "")).toThrow("not normalized");
    index.close();
  });
});
