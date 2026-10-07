import { expect, it, vi } from "vitest";
import { SqliteScheduler } from "@/index/sqlite/scheduler";
import { loadTestSqlite } from "./sqlite-test-client";
import { MutableSqliteDatabase } from "@/index/sqlite/database";
import { applyLexicalMarkdownBatch } from "@/index/sqlite/markdown";

async function relatedCorpus() {
  const sqlite = await loadTestSqlite();
  const raw = new sqlite.oo1.DB(":memory:", "c");
  const phases: string[] = [];
  const database = new MutableSqliteDatabase(
    raw,
    { enabled: () => true, emit: () => {} },
    (phase) => phases.push(phase)
  );
  const profile = "a".repeat(64);
  database.boot("b".repeat(64), 3, profile);
  const notes = Array.from({ length: 5 }, (_, note) => ({
    path: `note-${note}.md`,
    markdown: Array.from({ length: 35 }, (_, passage) => `note ${note} passage ${passage}`).join(
      "\n\n"
    ),
  }));
  const run = database.beginLexicalRun({ scope: { mayClearIncomplete: true } });
  await applyLexicalMarkdownBatch(database, run.runId, notes, new AbortController().signal);
  let finished = database.finishLexicalRun(run.runId);
  while (!finished.complete) finished = database.finishLexicalRun(run.runId);
  for (;;) {
    const work = database.prepareSemanticWork(profile, undefined, 128, 4 * 1024 * 1024);
    if (!work.requests.length) break;
    database.commitSemanticResults(
      work.requests.map((input) => ({
        ...input,
        vector: new Float32Array([1, 0, 0]),
      })),
      profile
    );
  }
  return { raw, database, phases, notes };
}

it("scores related candidates and reranking tiles inside SQLite without corpus vector transfers", async () => {
  const { raw, database, phases, notes } = await relatedCorpus();
  try {
    const queries: { sql: string; bind: readonly unknown[]; rows: number }[] = [];
    let vectorBytes = 0;
    const exec = raw.exec.bind(raw);
    raw.exec = (options: any) => {
      if (typeof options === "string") return exec(options);
      const query = { sql: options.sql, bind: options.bind ?? [], rows: 0 };
      queries.push(query);
      return exec({
        ...options,
        callback: options.callback
          ? (row: any) => {
              query.rows++;
              if (row.vector instanceof Uint8Array) vectorBytes += row.vector.byteLength;
              options.callback(row);
            }
          : undefined,
      });
    };
    const hits = await database.findRelated("note-0.md", undefined, 128);
    expect(hits.map(({ path, score }) => [path, score])).toEqual(
      notes.slice(1).map(({ path }) => [path, 1])
    );
    expect(vectorBytes).toBeLessThanOrEqual(4 * 3 * 4);
    const scans = queries.filter(({ sql }) => sql.includes("n.path<>?"));
    expect(scans).toHaveLength(1);
    expect(scans[0].rows).toBe(4);
    const tiles = queries.filter(({ sql }) => sql.includes("WITH scores AS MATERIALIZED"));
    expect(tiles.length).toBeGreaterThan(1);
    expect(tiles.every(({ rows }) => rows === 0)).toBe(true);
    expect(
      queries.filter(({ sql }) => sql.includes("CREATE TEMP TABLE related_target"))
    ).toHaveLength(4);
    const plans: string[] = [];
    for (const query of [scans[0]]) {
      exec({
        sql: `EXPLAIN QUERY PLAN ${query.sql}`,
        bind: query.bind,
        rowMode: "object",
        callback: (row: { detail: string }) => plans.push(row.detail),
      });
    }
    expect(plans.some((plan) => plan.includes("embedding_cache_fingerprint"))).toBe(false);
    expect(plans.some((plan) => plan.includes("embedding_cache_lookup"))).toBe(true);
    expect(phases).toEqual(["centroid", "relatedCandidates", "relatedRerank"]);
    queries.length = 0;
    vectorBytes = 0;
    const hybrid = database.retrieve("passage", new Float32Array([1, 0, 0]), 10, undefined, {
      resultShape: "notes",
      lexicalProfile: "lente",
      semanticCandidateLimit: 80,
      lexicalCandidateLimit: 80,
    });
    expect(hybrid).toHaveLength(5);
    expect(vectorBytes).toBe(0);
    expect(queries.length).toBeLessThanOrEqual(6);
    expect(queries.some(({ sql }) => /CREATE|DROP/i.test(sql))).toBe(false);
  } finally {
    database.close();
  }
});

it("cancels active SQLite reranking between tiles and releases queued work", async () => {
  const { raw, database, phases } = await relatedCorpus();
  const scheduler = new SqliteScheduler();
  const exec = raw.exec.bind(raw);
  let tiles = 0;
  let clock = 0;
  // Make each checkpoint's time budget expire without relying on machine speed.
  const now = vi.spyOn(performance, "now").mockImplementation(() => (clock += 10));
  raw.exec = (options: any) => {
    if (typeof options !== "string" && options.sql.includes("WITH scores AS MATERIALIZED")) {
      tiles++;
      if (tiles === 1) setTimeout(() => scheduler.cancelQueued(1), 0);
    }
    return exec(options);
  };
  try {
    const related = scheduler.enqueue(1, (signal) =>
      database.findRelated("note-0.md", undefined, 128, signal)
    );
    const next = scheduler.enqueue(2, async () => raw.selectValue("SELECT count(*) FROM notes"));
    await expect(related).rejects.toThrow("Related search cancelled");
    await expect(next).resolves.toBe(5);
    expect(tiles).toBe(1);
    expect(
      raw.selectValue("SELECT count(*) FROM sqlite_temp_master WHERE name LIKE 'related_%'")
    ).toBe(0);
    expect(phases).toEqual(["centroid", "relatedCandidates"]);
    expect(scheduler.pending).toBe(0);
  } finally {
    now.mockRestore();
    database.close();
  }
});
