import { describe, expect, it } from "vitest";
import { literalTerms, safeFtsQuery } from "@/index/sqlite/database";
import { schemaSql } from "@/index/sqlite/schema";
import { MutableSqliteDatabase } from "@/index/sqlite/database";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("SQLite schema/query foundation", () => {
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
    // @ts-expect-error generated production asset has no application type declarations.
    const init = (await import("../sqlite3.mjs")).default;
    const wasmPath = fileURLToPath(new URL("../sqlite3.wasm", import.meta.url));
    const sqlite = await init({ wasmBinary: readFileSync(wasmPath) });
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
            vector: new Float32Array([1, 0]),
          },
        ],
      }).changed
    ).toBe(true);
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
});
