import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MutableSqliteDatabase, type SqliteConnection } from "@/index/sqlite/database";

async function database(
  dimensions = 2,
  observeSql?: (sql: string) => void
): Promise<MutableSqliteDatabase> {
  // @ts-expect-error generated production asset has no application declarations.
  const init = (await import("../sqlite3.mjs")).default;
  const wasmPath = fileURLToPath(new URL("../sqlite3.wasm", import.meta.url));
  const sqlite = await init({ wasmBinary: readFileSync(wasmPath) });
  const raw = new sqlite.oo1.DB(":memory:", "c");
  const db: SqliteConnection = {
    exec: (options) => {
      observeSql?.(typeof options === "string" ? options : options.sql);
      raw.exec(options);
    },
    close: () => raw.close(),
  };
  const index = new MutableSqliteDatabase(db);
  index.boot("a".repeat(64), dimensions);
  return index;
}

describe("SQLite hydrated retrieval", () => {
  it("fuses channels by chunk identity and retains semantic/lexical evidence", async () => {
    const index = await database();
    const note = (path: string, id: string, text: string, vector: number[]) => ({
      path,
      contentId: id,
      chunks: [
        {
          id: `${id}:0`,
          ordinal: 0,
          startLine: 1,
          endLine: 1,
          text,
          vector: new Float32Array(vector),
        },
      ],
    });
    index.upsertNote(note("a.md", "a".repeat(64), "needle alpha", [1, 0]));
    index.upsertNote(note("b.md", "b".repeat(64), "needle beta", [0, 1]));
    const hits = index.retrieve("needle", new Float32Array([1, 0]), 10, undefined, {
      semanticCandidateLimit: 10,
      lexicalCandidateLimit: 10,
      lexicalProfile: "voce",
    });
    expect(hits.map((hit) => hit.path)).toEqual(["a.md", "b.md"]);
    expect(hits[0]).toMatchObject({ semanticScore: 1, lexicalScore: 1 });
    expect(hits[0].fusedScore).toBeGreaterThan(hits[1].fusedScore ?? -Infinity);
    index.close();
  });

  it("keeps hostile and Unicode keyword input literal and deterministic", async () => {
    const index = await database();
    const id = "c".repeat(64);
    index.upsertNote({
      path: "folder/Ä.md",
      contentId: id,
      chunks: [
        {
          id: `${id}:0`,
          ordinal: 0,
          startLine: 1,
          endLine: 1,
          text: "alpha beta",
          vector: new Float32Array([1, 0]),
        },
      ],
    });
    const first = index.retrieve('alpha OR beta "quoted" -tag', undefined, 10, undefined, {
      lexicalProfile: "lente",
    });
    const second = index.retrieve('alpha OR beta "quoted" -tag', undefined, 10, undefined, {
      lexicalProfile: "lente",
    });
    expect(first).toEqual(second);
    expect(first[0]?.path).toBe("folder/Ä.md");
    index.close();
  });

  it("limits note-shaped lexical candidates after choosing one chunk per note", async () => {
    const index = await database();
    const dominant = "d".repeat(64);
    index.upsertNote({
      path: "dominant.md",
      contentId: dominant,
      chunks: Array.from({ length: 80 }, (_, ordinal) => ({
        id: `${dominant}:${ordinal}`,
        ordinal,
        startLine: ordinal + 1,
        endLine: ordinal + 1,
        text: "needle",
        vector: new Float32Array([1, 0]),
      })),
    });
    for (let ordinal = 0; ordinal < 9; ordinal++) {
      const contentId = (ordinal + 1).toString(16).repeat(64);
      index.upsertNote({
        path: `other-${ordinal}.md`,
        contentId,
        chunks: [
          {
            id: `${contentId}:0`,
            ordinal: 0,
            startLine: 1,
            endLine: 1,
            text: "needle",
            vector: new Float32Array([1, 0]),
          },
        ],
      });
    }

    const hits = index.retrieve("needle", undefined, 10, undefined, {
      lexicalCandidateLimit: 10,
      lexicalProfile: "lente",
      resultShape: "notes",
    });
    expect(hits).toHaveLength(10);
    expect(new Set(hits.map((hit) => hit.path)).size).toBe(10);
    index.close();
  });

  it("bounds lexical extraction and hydrates only selected results", async () => {
    const statements: string[] = [];
    const index = await database(2, (sql) => statements.push(sql));
    for (let note = 0; note < 12; note++) {
      const contentId = note.toString(16).padStart(64, "0");
      index.upsertNote({
        path: `note-${note.toString().padStart(2, "0")}.md`,
        contentId,
        chunks: [
          {
            id: `${contentId}:0`,
            ordinal: 0,
            startLine: 1,
            endLine: 1,
            text: "needle",
            vector: new Float32Array([1, 0]),
          },
        ],
      });
    }

    const hits = index.retrieve("needle", undefined, 2, undefined, {
      lexicalCandidateLimit: 2,
      lexicalProfile: "voce",
    });
    const candidateSql = statements.find((sql) => sql.includes("bm25(chunks_fts"));
    expect(candidateSql).toContain("ROW_NUMBER() OVER");
    expect(candidateSql).toContain(
      "ORDER BY lexicalRank,path COLLATE BINARY,ordinal,id COLLATE BINARY"
    );
    expect(candidateSql).toContain("JOIN chunks c ON c.chunk_pk=e.chunkPk");
    expect(candidateSql).not.toContain("c.embedding");
    expect(hits.map((hit) => hit.path)).toEqual(["note-00.md", "note-01.md"]);
    index.close();
  });

  it("uses one deterministic scalar query for tied semantic candidates", async () => {
    const statements: string[] = [];
    const index = await database(2, (sql) => statements.push(sql));
    for (let note = 0; note < 20; note++) {
      const contentId = note.toString(16).padStart(64, "0");
      index.upsertNote({
        path: `tie-${note.toString().padStart(2, "0")}.md`,
        contentId,
        chunks: [
          {
            id: `${contentId}:0`,
            ordinal: 0,
            startLine: 1,
            endLine: 1,
            text: "tie",
            vector: new Float32Array([1, 0]),
          },
        ],
      });
    }
    statements.length = 0;

    const hits = index.retrieve(undefined, new Float32Array([1, 0]), 5, undefined, {
      semanticCandidateLimit: 5,
    });
    const semanticSql = statements.filter((sql) => sql.includes("vec_distance_L2"));
    expect(semanticSql).toHaveLength(1);
    expect(semanticSql[0]).toContain(
      "ORDER BY distance,path COLLATE BINARY,ordinal,id COLLATE BINARY"
    );
    expect(statements.some((sql) => sql.includes("embedding MATCH"))).toBe(false);
    expect(hits.map((hit) => hit.path)).toEqual([
      "tie-00.md",
      "tie-01.md",
      "tie-02.md",
      "tie-03.md",
      "tie-04.md",
    ]);
    index.close();
  });

  it("computes Filo's normalized centroid inside the related job", async () => {
    const index = await database();
    const current = "d".repeat(64);
    const related = "e".repeat(64);
    index.upsertNote({
      path: "current.md",
      contentId: current,
      chunks: [
        {
          id: `${current}:0`,
          ordinal: 0,
          startLine: 1,
          endLine: 1,
          text: "current",
          vector: new Float32Array([1, 0]),
        },
      ],
    });
    index.upsertNote({
      path: "related.md",
      contentId: related,
      chunks: [
        {
          id: `${related}:0`,
          ordinal: 0,
          startLine: 1,
          endLine: 1,
          text: "related",
          vector: new Float32Array([1, 0]),
        },
      ],
    });
    expect(index.findRelated("current.md", undefined, 10)[0]).toMatchObject({
      path: "related.md",
      score: 1,
      text: "related",
    });
    index.close();
  });

  it("expands semantic KNN when one note dominates the initial candidate window", async () => {
    const index = await database();
    const makeNote = (path: string, id: string, count: number) => ({
      path,
      contentId: id,
      chunks: Array.from({ length: count }, (_, ordinal) => ({
        id: `${id}:${ordinal}`,
        ordinal,
        startLine: 1,
        endLine: 1,
        text: `${path}-${ordinal}`,
        vector: new Float32Array([1, 0]),
      })),
    });
    const current = "f".repeat(64);
    index.upsertNote(makeNote("current.md", current, 1));
    index.upsertNote(makeNote("dominant.md", "1".repeat(64), 130));
    for (let note = 0; note < 8; note++)
      index.upsertNote(
        makeNote(
          `other-${note}.md`,
          `${(note + 2)
            .toString(16)
            .repeat(64 / 1)
            .slice(0, 64)}`,
          1
        )
      );
    const hits = index.findRelated("current.md", new Float32Array([1, 0]), 128);
    expect(new Set(hits.map((hit) => hit.path)).size).toBeGreaterThanOrEqual(7);
    index.close();
  });

  it("collects an exact-distance boundary tie beyond the old candidate cap", async () => {
    const index = await database();
    const makeNote = (path: string, id: string, count: number) => ({
      path,
      contentId: id,
      chunks: Array.from({ length: count }, (_, ordinal) => ({
        id: `${id}:${ordinal}`,
        ordinal,
        startLine: 1,
        endLine: 1,
        text: `${path}-${ordinal}`,
        vector: new Float32Array([1, 0]),
      })),
    });
    index.upsertNote(makeNote("current.md", "7".repeat(64), 1));
    index.upsertNote(makeNote("dominant.md", "8".repeat(64), 4_100));
    for (let note = 0; note < 8; note++)
      index.upsertNote(
        makeNote(`tie-${note}.md`, `${(note + 9).toString(16).repeat(64).slice(0, 64)}`, 1)
      );

    const hits = index.findRelated("current.md", new Float32Array([1, 0]), 7);
    expect(new Set(hits.map((hit) => hit.path)).size).toBe(7);
    expect(hits.map((hit) => hit.path)).toContain("tie-0.md");
    index.close();
  });
});
