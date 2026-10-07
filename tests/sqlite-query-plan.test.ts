import { describe, expect, it } from "vitest";
import {
  LEXICAL_BOUNDED_DELETE_SQL,
  LEXICAL_FINISH_EQUALITY_SQL,
  LEXICAL_RENAME_LOOKUP_SQL,
  SEMANTIC_AFFECTED_NOTES_SQL,
  SEMANTIC_AFFECTED_PROMOTION_SQL,
  SEMANTIC_MISSING_INPUTS_SQL,
  SEMANTIC_PROMOTION_SQL,
} from "@/index/sqlite/hot-queries";
import {
  applyTestLexicalRun,
  createTestSqliteClient,
  embedAllTestInputs,
  loadTestSqlite,
  snapshotFor,
} from "./sqlite-test-client";

type PlanRow = { id: number; parent: number; notused: number; detail: string };

const bulkRowsSql = (embeddingFingerprint: string) => `
  WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<2000)
  INSERT INTO notes(note_id,path,content_id)
    SELECT 100000+i,printf('bulk-%04d.md',i),printf('%064x',i) FROM seq;
  WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<2000)
  INSERT INTO note_revisions(revision_id,note_id,content_id,extraction_version,chunk_algorithm_version,created_change_counter)
    SELECT 100000+i,100000+i,printf('%064x',i),1,2,0 FROM seq;
  UPDATE notes SET lexical_revision_id=note_id;
  WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<2000)
  INSERT INTO chunk_occurrences(occurrence_id,revision_id,note_id,chunk_id,ordinal,kind,start_line,end_line,display_text,embedding_input_digest)
    SELECT 100000+i,100000+i,100000+i,printf('bulk-chunk-%04d',i),0,'paragraph',1,1,'bulk', 'bulk-input-'||i FROM seq;
  WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<2000)
  INSERT INTO embedding_inputs(input_id,embedding_fingerprint,serialized_input,preprocessing,action_key)
    SELECT 100000+i,'${embeddingFingerprint}','bulk-input-'||i,'normalized-float32-v1','bulk-input-'||i FROM seq;
  WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<1999)
  INSERT INTO embedding_cache(input_digest,action_key,embedding_fingerprint,preprocessing,vector)
    SELECT 'bulk-input-'||i,'bulk-cache-'||i,'${embeddingFingerprint}','normalized-float32-v1',zeroblob(8) FROM seq;
`;

async function explainSnapshot(
  snapshot: Uint8Array,
  statements: readonly { name: string; sql: string; bind?: readonly unknown[] }[],
  setupSql = ""
): Promise<Record<string, PlanRow[]>> {
  const sqlite = await loadTestSqlite();
  const raw = new sqlite.oo1.DB(":memory:", "c");
  const pointer = sqlite.wasm.allocFromTypedArray(snapshot);
  const flags =
    sqlite.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite.capi.SQLITE_DESERIALIZE_RESIZEABLE;
  const result = sqlite.capi.sqlite3_deserialize(
    raw.pointer,
    "main",
    pointer,
    snapshot.byteLength,
    snapshot.byteLength,
    flags
  );
  if (result !== 0) throw new Error(`sqlite3_deserialize failed: ${result}`);
  try {
    raw.exec(
      `CREATE TEMP TABLE semantic_affected_notes(note_id INTEGER PRIMARY KEY);
       CREATE TEMP TABLE reconciliation_expected(path TEXT PRIMARY KEY, content_id TEXT, chunk_count INTEGER);
       CREATE TEMP TABLE lexical_delete_paths(path TEXT PRIMARY KEY);`
    );
    if (setupSql) raw.exec(setupSql);
    const plans: Record<string, PlanRow[]> = {};
    for (const statement of statements) {
      const rows: PlanRow[] = [];
      raw.exec({
        sql: `EXPLAIN QUERY PLAN ${statement.sql}`,
        bind: statement.bind,
        rowMode: "object",
        callback: (row: Record<string, unknown>) =>
          rows.push({
            id: Number(row.id),
            parent: Number(row.parent),
            notused: Number(row.notused),
            detail: String(row.detail),
          }),
      });
      plans[statement.name] = rows;
    }
    return plans;
  } finally {
    raw.close();
  }
}

const digest = (value: string) =>
  Array.from(value)
    .map((character) => character.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("")
    .padEnd(64, "0")
    .slice(0, 64);

describe("SQLite hot query plans", () => {
  it("supports materialized FTS scoring with windowed note ranking", async () => {
    const identity = {};
    const client = createTestSqliteClient(identity);
    await client.call("boot", { corpusFingerprint: digest("window-ranking"), dimensions: 2 });
    await applyTestLexicalRun(client, [
      { path: "same.md", markdown: "alpha first\n\nalpha second", size: 384 },
      { path: "other.md", markdown: "alpha first", size: 384 },
    ]);
    await client.call("shutdown", {});

    const sqlite = await loadTestSqlite();
    const raw = new sqlite.oo1.DB(":memory:", "c");
    const snapshot = await snapshotFor(identity);
    const pointer = sqlite.wasm.allocFromTypedArray(snapshot);
    const flags =
      sqlite.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite.capi.SQLITE_DESERIALIZE_RESIZEABLE;
    const result = sqlite.capi.sqlite3_deserialize(
      raw.pointer,
      "main",
      pointer,
      snapshot.byteLength,
      snapshot.byteLength,
      flags
    );
    if (result !== 0) throw new Error(`sqlite3_deserialize failed: ${result}`);
    try {
      const rows: { path: string; ordinal: number }[] = [];
      raw.exec({
        sql: `WITH scored AS MATERIALIZED (
                SELECT o.occurrence_id,o.chunk_id,o.ordinal,n.path,
                       bm25(lexical_notes_fts,1,2,3,3,0.5) AS rank
                FROM lexical_notes_fts f
                JOIN lexical_notes l ON l.note_id=f.rowid
                JOIN notes n ON n.note_id=l.note_id AND n.lexical_revision_id=l.revision_id
                LEFT JOIN chunk_occurrences o ON o.occurrence_id=(
                  SELECT first.occurrence_id FROM chunk_occurrences first
                  WHERE first.note_id=l.note_id AND first.revision_id=l.revision_id
                  ORDER BY first.ordinal LIMIT 1
                )
                WHERE lexical_notes_fts MATCH ?
              ), ranked AS (
                SELECT *,row_number() OVER (
                  PARTITION BY path
                  ORDER BY rank ASC,path COLLATE BINARY,ordinal,chunk_id COLLATE BINARY
                ) AS note_rank
                FROM scored
              )
              SELECT path,ordinal FROM ranked WHERE note_rank=1
              ORDER BY rank ASC,path COLLATE BINARY,ordinal,chunk_id COLLATE BINARY LIMIT ?`,
        bind: ['"alpha"', 10],
        rowMode: "object",
        callback: (row: { path: string; ordinal: number }) =>
          rows.push({ path: row.path, ordinal: Number(row.ordinal) }),
      });
      expect(rows).toHaveLength(2);
      expect(rows.map(({ path }) => path).sort()).toEqual(["other.md", "same.md"]);
    } finally {
      raw.close();
    }
  }, 30_000);

  it("uses stable lookup indexes for production semantic and lexical statements", async () => {
    const identity = {};
    const client = createTestSqliteClient(identity);
    const corpusFingerprint = digest("query-plan-corpus");
    const embeddingFingerprint = digest("query-plan-model");
    await client.call("boot", { corpusFingerprint, embeddingFingerprint, dimensions: 2 });
    await applyTestLexicalRun(client, [
      { path: "one.md", markdown: "alpha alpha\n\nbeta", size: 384 },
      { path: "two.md", markdown: "alpha alpha\n\nbeta", size: 384 },
    ]);
    await embedAllTestInputs(client, embeddingFingerprint, () => new Float32Array([1, 0]));
    await applyTestLexicalRun(client, [
      { path: "one.md", markdown: "gamma gamma\n\ndelta", size: 384 },
    ]);
    await client.call("shutdown", {});

    const plans = await explainSnapshot(
      await snapshotFor(identity),
      [
        {
          name: "missingInput",
          sql: SEMANTIC_MISSING_INPUTS_SQL,
          bind: [embeddingFingerprint, "normalized-float32-v1", 128, 128, 4 * 1024 * 1024],
        },
        {
          name: "cachedPromotion",
          sql: SEMANTIC_PROMOTION_SQL,
          bind: [embeddingFingerprint, "normalized-float32-v1"],
        },
        {
          name: "affectedPromotion",
          sql: SEMANTIC_AFFECTED_PROMOTION_SQL,
          bind: [embeddingFingerprint, "normalized-float32-v1"],
        },
        { name: "finishEquality", sql: LEXICAL_FINISH_EQUALITY_SQL },
        { name: "renameLookup", sql: LEXICAL_RENAME_LOOKUP_SQL, bind: ["one.md"] },
        { name: "boundedDelete", sql: LEXICAL_BOUNDED_DELETE_SQL },
      ],
      bulkRowsSql(embeddingFingerprint)
    );

    expect(
      plans.missingInput.some((row) => row.detail.includes("chunk_occurrences_embedding_input"))
    ).toBe(true);
    expect(plans.missingInput.some((row) => row.detail.includes("embedding_cache_lookup"))).toBe(
      true
    );
    expect(plans.renameLookup.some((row) => row.detail.includes("sqlite_autoindex_notes_"))).toBe(
      true
    );
    expect(plans.boundedDelete.some((row) => row.detail.includes("lexical_delete_paths"))).toBe(
      true
    );
    expect(plans.finishEquality).not.toHaveLength(0);
    expect(plans.cachedPromotion).not.toHaveLength(0);
    expect(plans.affectedPromotion).not.toHaveLength(0);
  }, 30_000);

  it("measures affected-note selection with sparse semantic results and stale revisions", async () => {
    const identity = {};
    const client = createTestSqliteClient(identity);
    const embeddingFingerprint = digest("affected-note-plan-model");
    await client.call("boot", {
      corpusFingerprint: digest("affected-note-plan-corpus"),
      embeddingFingerprint,
      dimensions: 2,
    });
    await client.call("shutdown", {});

    const sqlite = await loadTestSqlite();
    const raw = new sqlite.oo1.DB(":memory:", "c");
    const snapshot = await snapshotFor(identity);
    const pointer = sqlite.wasm.allocFromTypedArray(snapshot);
    const flags =
      sqlite.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite.capi.SQLITE_DESERIALIZE_RESIZEABLE;
    const result = sqlite.capi.sqlite3_deserialize(
      raw.pointer,
      "main",
      pointer,
      snapshot.byteLength,
      snapshot.byteLength,
      flags
    );
    if (result !== 0) throw new Error(`sqlite3_deserialize failed: ${result}`);
    try {
      raw.exec(
        `CREATE TEMP TABLE semantic_affected_notes(note_id INTEGER PRIMARY KEY);
         CREATE TEMP TABLE semantic_candidate_notes(note_id INTEGER PRIMARY KEY);
         CREATE TEMP TABLE semantic_result_inputs(input_digest TEXT PRIMARY KEY,action_key TEXT NOT NULL,serialization TEXT NOT NULL,vector BLOB NOT NULL);
         ${bulkRowsSql(embeddingFingerprint)}
         UPDATE notes SET lexical_revision_id=999999 WHERE note_id=100001;`
      );
      const selectAffected = `SELECT DISTINCT n.note_id
        FROM notes n
        JOIN chunk_occurrences o ON o.note_id=n.note_id AND o.revision_id=n.lexical_revision_id
        JOIN semantic_result_inputs r ON r.input_digest=o.embedding_input_digest
        WHERE n.lexical_revision_id IS NOT NULL`;
      for (const batchSize of [1, 128]) {
        raw.exec(
          "DELETE FROM semantic_affected_notes; DELETE FROM semantic_candidate_notes; DELETE FROM semantic_result_inputs;"
        );
        raw.exec({
          sql: `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<?)
                INSERT INTO semantic_result_inputs(input_digest,action_key,serialization,vector)
                SELECT 'bulk-input-'||i,'bulk-input-'||i,'bulk-input-'||i,zeroblob(8) FROM seq`,
          bind: [batchSize],
        });
        const measurePlan = (sql: string): PlanRow[] => {
          const plan: PlanRow[] = [];
          raw.exec({
            sql: `EXPLAIN QUERY PLAN ${sql}`,
            rowMode: "object",
            callback: (row: Record<string, unknown>) =>
              plan.push({
                id: Number(row.id),
                parent: Number(row.parent),
                notused: Number(row.notused),
                detail: String(row.detail),
              }),
          });
          return plan;
        };
        const currentPlan = measurePlan(selectAffected);
        const productionPlan = measurePlan(SEMANTIC_AFFECTED_NOTES_SQL);
        let resultInputCount = -1;
        raw.exec({
          sql: "SELECT COUNT(*) AS count FROM semantic_result_inputs",
          rowMode: "object",
          callback: (row: { count: number }) => (resultInputCount = Number(row.count)),
        });
        raw.exec(`INSERT INTO semantic_candidate_notes(note_id) ${selectAffected}`);
        raw.exec(SEMANTIC_AFFECTED_NOTES_SQL);
        const readIds = (table: string): number[] => {
          const ids: number[] = [];
          raw.exec({
            sql: `SELECT note_id FROM ${table} ORDER BY note_id`,
            rowMode: "object",
            callback: (row: { note_id: number }) => ids.push(Number(row.note_id)),
          });
          return ids;
        };
        const currentIds = readIds("semantic_candidate_notes");
        const productionIds = readIds("semantic_affected_notes");
        expect(resultInputCount).toBe(batchSize);
        expect(
          currentPlan.some(({ detail }) => detail.includes("SCAN o USING COVERING INDEX"))
        ).toBe(true);
        expect(
          productionPlan.some(({ detail }) => detail.includes("SCAN r USING COVERING INDEX"))
        ).toBe(true);
        expect(
          productionPlan.some(({ detail }) =>
            detail.includes("SEARCH o USING COVERING INDEX chunk_occurrences_embedding_input")
          )
        ).toBe(true);
        expect(
          productionPlan.some(({ detail }) =>
            detail.includes("SEARCH n USING INDEX sqlite_autoindex_notes_1")
          )
        ).toBe(true);
        expect(productionIds).toEqual(currentIds);
        expect(currentIds).toHaveLength(batchSize - 1);
      }
    } finally {
      raw.close();
    }
  }, 30_000);
});
