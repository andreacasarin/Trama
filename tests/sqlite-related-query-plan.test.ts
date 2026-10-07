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

it("scans related candidates once and loads reranking tiles by occurrence keys", async () => {
  const { raw, database, phases, notes } = await relatedCorpus();
  try {
    const queries: { sql: string; bind: readonly unknown[]; rows: number }[] = [];
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
              options.callback(row);
            }
          : undefined,
      });
    };
    const hits = await database.findRelated("note-0.md", undefined, 128);
    expect(hits.map(({ path, score }) => [path, score])).toEqual(
      notes.slice(1).map(({ path }) => [path, 1])
    );
    const scans = queries.filter(({ sql }) => sql.includes("n.path<>?"));
    expect(scans).toHaveLength(1);
    expect(scans[0].rows).toBe(4 * 35);
    const tiles = queries.filter(({ sql }) => sql.includes("o.occurrence_id IN"));
    expect(tiles.length).toBeGreaterThan(1);
    expect(tiles.every(({ rows }) => rows <= 16)).toBe(true);
    const plans: string[] = [];
    for (const query of [scans[0], tiles[0]]) {
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
    if (typeof options !== "string" && options.sql.includes("o.occurrence_id IN")) {
      tiles++;
      if (tiles === 2) setTimeout(() => scheduler.cancelQueued(1), 0);
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
    expect(tiles).toBe(2); // One source tile and one target tile; no later candidate work.
    expect(phases).toEqual(["centroid", "relatedCandidates"]);
    expect(scheduler.pending).toBe(0);
  } finally {
    now.mockRestore();
    database.close();
  }
});
