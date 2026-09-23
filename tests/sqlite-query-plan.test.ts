import { describe, expect, it } from "vitest";
import {
  LEXICAL_BOUNDED_DELETE_SQL,
  LEXICAL_FINISH_EQUALITY_SQL,
  LEXICAL_RENAME_LOOKUP_SQL,
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
  INSERT INTO chunk_occurrences(occurrence_id,revision_id,note_id,chunk_id,ordinal,kind,start_line,end_line,display_text,heading_context,embedding_input,embedding_input_digest,body)
    SELECT 100000+i,100000+i,100000+i,printf('bulk-chunk-%04d',i),0,'paragraph',1,1,'bulk', '[]', 'bulk-input-'||i, 'bulk-input-'||i, 'bulk' FROM seq;
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
});
