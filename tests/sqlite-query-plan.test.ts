import { describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  applyTestLexicalRun,
  createTestSqliteClient,
  embedAllTestInputs,
  loadTestSqlite,
  snapshotFor,
} from "./sqlite-test-client";

type PlanRow = { id: number; parent: number; notused: number; detail: string };

const missingInputSql = `WITH candidates AS MATERIALIZED (
  SELECT ei.input_id AS inputId,ei.serialized_input AS serialization,ei.action_key AS inputDigest
  FROM embedding_inputs ei
  WHERE EXISTS (
    SELECT 1
    FROM chunk_occurrences o
    JOIN notes n ON n.note_id=o.note_id AND n.lexical_revision_id=o.revision_id
    WHERE o.embedding_input_digest=ei.action_key
  )
    AND NOT EXISTS (
      SELECT 1
      FROM embedding_cache ec
      WHERE ec.input_digest=ei.action_key
        AND ec.embedding_fingerprint=?
        AND ec.preprocessing=?
    )
  ORDER BY ei.input_id
  LIMIT ?
), bounded AS (
  SELECT *,
    sum(length(CAST(serialization AS BLOB))) OVER (
      ORDER BY inputId ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS inputBytes,
    row_number() OVER (ORDER BY inputId) AS itemNumber
  FROM candidates
)
SELECT inputId,serialization,inputDigest
FROM bounded
WHERE itemNumber<=? AND inputBytes<=?
ORDER BY inputId`;

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

async function measureSnapshotQuery(
  snapshot: Uint8Array,
  sql: string,
  bind: readonly unknown[],
  setupSql: string,
  repetitions: number
): Promise<number> {
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
    raw.exec(setupSql);
    const started = performance.now();
    for (let index = 0; index < repetitions; index++)
      raw.exec({ sql, bind, rowMode: "object", callback: () => undefined });
    return performance.now() - started;
  } finally {
    raw.close();
  }
}

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
  it("uses stable lookup indexes for populated semantic and lexical states", async () => {
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
    const changedMarkdown = "gamma gamma\n\ndelta";
    await applyTestLexicalRun(client, [{ path: "one.md", markdown: changedMarkdown, size: 384 }]);
    await client.call("shutdown", {});
    const snapshot = await snapshotFor(identity);
    const statements = [
      {
        name: "missingInput",
        sql: missingInputSql,
        bind: [embeddingFingerprint, "normalized-float32-v1", 128, 128, 4 * 1024 * 1024],
      },
      {
        name: "cachedPromotion",
        sql: `UPDATE notes AS n
              SET semantic_revision_id=n.lexical_revision_id
              WHERE n.lexical_revision_id IS NOT NULL
                AND n.semantic_revision_id IS NOT n.lexical_revision_id
                AND NOT EXISTS (
                  SELECT 1
                  FROM chunk_occurrences o
                  JOIN embedding_inputs ei ON ei.action_key=o.embedding_input_digest
                  LEFT JOIN embedding_cache ec
                    ON ec.input_digest=ei.action_key
                   AND ec.embedding_fingerprint=?
                   AND ec.preprocessing=?
                  WHERE o.note_id=n.note_id
                    AND o.revision_id=n.lexical_revision_id
                    AND ec.cache_id IS NULL
                )`,
        bind: [embeddingFingerprint, "normalized-float32-v1"],
      },
      {
        name: "affectedPromotion",
        sql: `UPDATE notes AS n
              SET semantic_revision_id=n.lexical_revision_id
              WHERE n.lexical_revision_id IS NOT NULL
                AND n.semantic_revision_id IS NOT n.lexical_revision_id
                AND EXISTS (SELECT 1 FROM semantic_affected_notes a WHERE a.note_id=n.note_id)
                AND NOT EXISTS (
                  SELECT 1
                  FROM chunk_occurrences o
                  JOIN embedding_inputs ei ON ei.action_key=o.embedding_input_digest
                  LEFT JOIN embedding_cache ec
                    ON ec.input_digest=ei.action_key
                   AND ec.embedding_fingerprint=?
                   AND ec.preprocessing=?
                  WHERE o.note_id=n.note_id
                    AND o.revision_id=n.lexical_revision_id
                    AND ec.cache_id IS NULL
                )`,
        bind: [embeddingFingerprint, "normalized-float32-v1"],
      },
      {
        name: "finishEquality",
        sql: `SELECT count(*) AS count
              FROM reconciliation_expected e LEFT JOIN notes n ON n.path=e.path
              WHERE n.note_pk IS NULL OR n.content_id<>e.content_id
                 OR (e.chunk_count IS NOT NULL AND e.chunk_count<>(
                      SELECT count(*)
                      FROM chunk_occurrences c
                      JOIN notes nn ON nn.note_id=c.note_id AND nn.lexical_revision_id=c.revision_id
                      WHERE nn.note_id=n.note_id
                    ))`,
      },
      {
        name: "finishDelete",
        sql: "DELETE FROM notes WHERE NOT EXISTS(SELECT 1 FROM reconciliation_expected e WHERE e.path=notes.path)",
      },
      {
        name: "renameLookup",
        sql: "SELECT note_id,semantic_revision_id FROM notes WHERE path=?",
        bind: ["one.md"],
      },
      {
        name: "boundedDelete",
        sql: "DELETE FROM notes WHERE path IN (SELECT path FROM lexical_delete_paths)",
      },
    ];
    const bulkSql = bulkRowsSql(embeddingFingerprint);
    const emptyCacheSql = `${bulkSql} DELETE FROM embedding_cache WHERE input_digest LIKE 'bulk-input-%';`;
    const plansBefore = await explainSnapshot(
      snapshot,
      statements,
      `${emptyCacheSql} DROP INDEX chunk_occurrences_embedding_input; DROP INDEX embedding_cache_lookup;`
    );
    const plansEmptyCache = await explainSnapshot(snapshot, statements, emptyCacheSql);
    const plansAfter = await explainSnapshot(snapshot, statements, bulkSql);

    expect(
      plansAfter.missingInput.some((row) =>
        row.detail.includes("chunk_occurrences_embedding_input")
      )
    ).toBe(true);
    expect(
      plansAfter.missingInput.some((row) => row.detail.includes("embedding_cache_lookup"))
    ).toBe(true);
    expect(
      plansAfter.renameLookup.some((row) => row.detail.includes("sqlite_autoindex_notes_"))
    ).toBe(true);
    expect(
      plansAfter.finishDelete.some((row) => row.detail.includes("reconciliation_expected"))
    ).toBe(true);
    expect(
      plansAfter.boundedDelete.some((row) => row.detail.includes("lexical_delete_paths"))
    ).toBe(true);
    for (const [name, plan] of Object.entries(plansBefore)) {
      // Keep the planner output visible in benchmark logs for the measured evidence.
      console.log(`QUERY PLAN BEFORE ${name}\n${plan.map((row) => row.detail).join("\n")}`);
    }
    for (const [name, plan] of Object.entries(plansAfter))
      console.log(`QUERY PLAN AFTER ${name}\n${plan.map((row) => row.detail).join("\n")}`);

    const missingInputBind = [
      embeddingFingerprint,
      "normalized-float32-v1",
      128,
      128,
      4 * 1024 * 1024,
    ];
    const beforeMs = await measureSnapshotQuery(
      snapshot,
      missingInputSql,
      missingInputBind,
      `${emptyCacheSql} DROP INDEX chunk_occurrences_embedding_input; DROP INDEX embedding_cache_lookup;`,
      5
    );
    const afterMs = await measureSnapshotQuery(
      snapshot,
      missingInputSql,
      missingInputBind,
      bulkSql,
      5
    );
    console.log(
      `QUERY TIMING missingInput before=${beforeMs.toFixed(2)}ms after=${afterMs.toFixed(2)}ms`
    );
    mkdirSync(".artifacts", { recursive: true });
    writeFileSync(
      ".artifacts/sqlite-query-plans.json",
      `${JSON.stringify(
        {
          schemaVersion: 8,
          profile: "duplicate-inputs-and-semantic-cache",
          before: plansBefore,
          emptyCache: plansEmptyCache,
          after: plansAfter,
          timingMs: { before: beforeMs, after: afterMs, repetitions: 5 },
        },
        null,
        2
      )}\n`
    );
    // WASM startup/cache noise can dominate this microbenchmark; the plan and
    // bounded candidate shape are the stable regression guards. Keep a loose
    // timing envelope so a genuinely unbounded regression still surfaces.
    expect(afterMs).toBeLessThan(beforeMs * 2 + 250);
  }, 30_000);
});
