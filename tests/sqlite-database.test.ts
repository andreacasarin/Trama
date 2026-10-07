import { describe, expect, it, vi } from "vitest";
import { SQLITE_BUILD_IDENTITY } from "@/build/identity";
import { MutableSqliteDatabase } from "@/index/sqlite/database";
import { applyLexicalMarkdownBatch } from "@/index/sqlite/markdown";
import {
  applyTestLexicalRun,
  createTestSqliteClient,
  embedAllTestInputs,
  inspectIndexStateColumns,
  inspectSnapshotTables,
  loadTestSqlite,
  snapshotFor,
} from "./sqlite-test-client";

const digest = (_value: string) => "a".repeat(64);

describe("revision cache database", () => {
  it.each([
    { markdown: "# Real title\n\nBody", expected: "Real title" },
    { markdown: "Real title\n==========\n\nBody", expected: "Real title" },
    { markdown: "# old\n\nBody", expected: "old" },
    { markdown: "old\n===\n\nBody", expected: "old" },
    { markdown: "## old\n\nBody", expected: "new" },
    { markdown: "Body only", expected: "new" },
  ])(
    "preserves content titles and updates fallback titles on rename: $markdown",
    async ({ markdown, expected }) => {
      const sqlite = await loadTestSqlite();
      const raw = new sqlite.oo1.DB(":memory:", "c");
      const database = new MutableSqliteDatabase(raw);
      database.boot(digest("rename"), 2);
      const initial = database.beginLexicalRun({ scope: { mayClearIncomplete: true } });
      await applyLexicalMarkdownBatch(database, initial.runId, [{ path: "old.md", markdown }]);
      database.finishLexicalRun(initial.runId);
      const rename = database.beginLexicalRun({
        scope: { renames: [{ from: "old.md", to: "new.md" }], mayClearIncomplete: true },
      });
      database.finishLexicalRun(rename.runId);
      expect(raw.selectValue("SELECT title FROM lexical_notes")).toBe(expected);
      expect(raw.selectValue("SELECT filename FROM lexical_notes")).toBe("new");
      expect(raw.selectValue("SELECT path_text FROM lexical_notes")).toBe("new.md");
      database.close();
    }
  );

  it("keeps expired shard identities discoverable after cache rows have been deleted", async () => {
    const sqlite = await loadTestSqlite();
    const raw = new sqlite.oo1.DB(":memory:", "c");
    const database = new MutableSqliteDatabase(raw);
    const profile = "a".repeat(64);
    database.boot(digest("expiry"), 2, profile);
    const now = 2_000_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      await database.storeQueryVector("old query", profile, 2, new Float32Array([1, 0]));
      const actionKey = String(raw.selectValue("SELECT action_key FROM embedding_cache"));
      const source = "b".repeat(64);
      database.recordCacheShard(source, profile, "query", [actionKey]);
      raw.exec("UPDATE embedding_cache SET created_at=1");
      await database.recordCacheRetirements([], [], now);
      expect(database.maintainCache(now + 1).expiredSourceDigests).toEqual([source]);
      expect(raw.selectValue("SELECT count(*) FROM embedding_cache")).toBe(0);
      expect(database.maintainCache(now + 8 * 24 * 60 * 60 * 1000).expiredSourceDigests).toEqual([
        source,
      ]);

      // Query lookup can evict a row before publication gets to maintenance.
      await database.storeQueryVector("second query", profile, 2, new Float32Array([1, 0]));
      const secondKey = String(raw.selectValue("SELECT action_key FROM embedding_cache"));
      const second = "c".repeat(64);
      database.recordCacheShard(second, profile, "query", [secondKey]);
      raw.exec("UPDATE embedding_cache SET created_at=1");
      await database.lookupQueryVector("second query", profile);
      expect(database.maintainCache(now + 1).expiredSourceDigests.sort()).toEqual([source, second]);
    } finally {
      clock.mockRestore();
      database.close();
    }
  });

  it("fully resets local semantic state on model change while preserving lexical retrieval", async () => {
    const sqlite = await loadTestSqlite();
    const raw = new sqlite.oo1.DB(":memory:", "c");
    const database = new MutableSqliteDatabase(raw);
    const corpus = digest("query-profile-fence-corpus");
    const previousProfile = "a".repeat(64);
    const nextProfile = "b".repeat(64);
    database.boot(corpus, 2, previousProfile);
    const run = database.beginLexicalRun({ scope: { mayClearIncomplete: true } });
    await applyLexicalMarkdownBatch(database, run.runId, [
      { path: "fence.md", markdown: "alpha lexical evidence" },
    ]);
    database.finishLexicalRun(run.runId);
    const work = database.prepareSemanticWork(previousProfile);
    database.commitSemanticResults(
      work.requests.map((request) => ({ ...request, vector: new Float32Array([1, 0]) })),
      previousProfile
    );
    expect(database.getState().semanticHeadCount).toBe(1);
    raw.exec({
      sql: "INSERT INTO embedding_profiles(fingerprint,dimensions,model_id,endpoint_origin) VALUES(?,2,'other','')",
      bind: [nextProfile],
    });
    raw.exec({
      sql: "INSERT INTO embedding_cache(input_digest,action_key,embedding_fingerprint,preprocessing,vector,task_kind,created_at) VALUES('input','cache-key',?,'normalized-float32-v1',?,'document',1)",
      bind: [nextProfile, new Uint8Array(new Float32Array([0, 1]).buffer)],
    });
    expect(database.boot(corpus, 2, nextProfile).semanticRebuildRequired).toBe(true);
    // Both old and already imported new-model query/document entries are discarded.
    for (const fingerprint of [previousProfile, nextProfile]) {
      raw.exec({
        sql: "INSERT INTO embedding_cache(input_digest,action_key,embedding_fingerprint,preprocessing,vector,task_kind,created_at) VALUES(?,?,?,'normalized-float32-v1',?,'query',1)",
        bind: [
          fingerprint,
          `query-${fingerprint}`,
          fingerprint,
          new Uint8Array(new Float32Array([1, 0]).buffer),
        ],
      });
    }
    raw.exec("INSERT INTO cache_compaction_retirements VALUES('source','replacement-set',1)");
    raw.exec("INSERT INTO cache_compaction_replacements VALUES('replacement-set','replacement')");
    raw.exec("INSERT INTO cache_artifact_receipts VALUES('source','old-profile',1)");
    raw.exec("INSERT INTO cache_shard_membership VALUES('source','key','document','old-profile')");
    const lexicalGeneration = database.getState().lexicalGeneration;
    const reset = database.selectEmbeddingProfile(nextProfile);
    expect(reset.lexicalGeneration).toBe(lexicalGeneration);
    expect(reset.semanticHeadCount).toBe(0);
    expect(reset.semanticRebuildRequired).toBe(false);
    for (const table of [
      "embedding_cache",
      "cache_compaction_retirements",
      "cache_compaction_replacements",
      "cache_artifact_receipts",
      "cache_shard_membership",
    ])
      expect(Number(raw.selectValue(`SELECT count(*) FROM ${table}`))).toBe(0);
    expect(raw.selectValue("SELECT fingerprint FROM embedding_profiles")).toBe(nextProfile);
    const hits = database.retrieve("alpha", new Float32Array([0, 1]), 5, undefined, {
      expectedEmbeddingFingerprint: previousProfile,
    });
    expect(hits).toEqual([expect.objectContaining({ path: "fence.md" })]);
    expect(hits[0].semanticScore).toBeUndefined();
    database.close();
  });

  it("retains the vault model offline and rejects arbitrary profile switching", async () => {
    const sqlite = await loadTestSqlite();
    const raw = new sqlite.oo1.DB(":memory:", "c");
    const database = new MutableSqliteDatabase(raw);
    const corpus = digest("offline-profile-selection");
    const first = "b".repeat(64);
    const second = "c".repeat(64);
    database.boot(corpus, 2, "");
    for (const [index, fingerprint] of [first, second].entries()) {
      raw.exec({
        sql: "INSERT INTO embedding_profiles(fingerprint,dimensions,model_id,endpoint_origin) VALUES(?,2,?,?)",
        bind: [fingerprint, `model-${index}`, `http://127.0.0.1:${1234 + index}`],
      });
      raw.exec({
        sql: "INSERT INTO embedding_cache(input_digest,action_key,embedding_fingerprint,preprocessing,vector,task_kind,created_at) VALUES(?,?,?,?,?,'document',?)",
        bind: [
          `input-${index}`,
          `cache-${index}`,
          fingerprint,
          "normalized-float32-v1",
          new Uint8Array(new Float32Array([1, 0]).buffer),
          index,
        ],
      });
    }
    expect(database.boot(corpus, 2, "").embeddingFingerprint).toBe("");
    expect(() => database.selectEmbeddingProfile(first)).toThrow("configured in settings");
    database.boot(corpus, 2, first);
    expect(database.boot(corpus, 2, "").embeddingFingerprint).toBe(first);
    expect(() => database.selectEmbeddingProfile(second)).toThrow("configured in settings");
    database.close();
  });

  it("aggregates lexical preparation and SQL phases for changed, unchanged, and staged batches", async () => {
    const sqlite = await loadTestSqlite();
    const raw = new sqlite.oo1.DB(":memory:", "c");
    const database = new MutableSqliteDatabase(raw);
    const corpusFingerprint = digest("lexical-phase-corpus");
    database.boot(corpusFingerprint, 2, digest("lexical-phase-model"), SQLITE_BUILD_IDENTITY);
    const observe =
      (records: { phase: string; durationMs: number }[]) => (phase: string, durationMs: number) =>
        records.push({ phase, durationMs });
    const expectedPhases = ["lexicalInputPreparation", "lexicalSqlMutation"];
    try {
      const changedRun = database.beginLexicalRun({ scope: { mayClearIncomplete: true } });
      const changedPhases: { phase: string; durationMs: number }[] = [];
      await applyLexicalMarkdownBatch(
        database,
        changedRun.runId,
        [{ path: "one.md", markdown: "alpha" }],
        undefined,
        observe(changedPhases)
      );
      database.finishLexicalRun(changedRun.runId);
      expect(changedPhases.map(({ phase }) => phase)).toEqual(expectedPhases);
      expect(changedPhases.every(({ durationMs }) => durationMs >= 0)).toBe(true);

      const unchangedRun = database.beginLexicalRun({ scope: { mayClearIncomplete: true } });
      const unchangedPhases: { phase: string; durationMs: number }[] = [];
      const unchanged = await applyLexicalMarkdownBatch(
        database,
        unchangedRun.runId,
        [{ path: "one.md", markdown: "alpha" }],
        undefined,
        observe(unchangedPhases)
      );
      database.finishLexicalRun(unchangedRun.runId);
      expect(unchanged.skipped).toBe(1);
      expect(unchangedPhases.map(({ phase }) => phase)).toEqual(expectedPhases);

      const cancelledRun = database.beginLexicalRun({ scope: { mayClearIncomplete: true } });
      const cancelled = new AbortController();
      cancelled.abort();
      const cancelledPhases: { phase: string; durationMs: number }[] = [];
      await expect(
        applyLexicalMarkdownBatch(
          database,
          cancelledRun.runId,
          [{ path: "cancelled.md", markdown: "cancelled" }],
          cancelled.signal,
          observe(cancelledPhases)
        )
      ).rejects.toMatchObject({ error: { code: "cancelled" } });
      expect(cancelledPhases.map(({ phase }) => phase)).toEqual(expectedPhases);
      database.abortLexicalRun(cancelledRun.runId);

      const stagedRun = database.beginLexicalRun({ scope: { mayClearIncomplete: true } });
      const stagedPhases: { phase: string; durationMs: number }[] = [];
      const stage = vi.spyOn(database, "stageLexicalRevision");
      const markdown = Array.from({ length: 2001 }, (_, index) => `line ${index}`).join("\n\n");
      await applyLexicalMarkdownBatch(
        database,
        stagedRun.runId,
        [{ path: "bulk.md", markdown, size: 128 }],
        undefined,
        observe(stagedPhases)
      );
      database.finishLexicalRun(stagedRun.runId);
      expect(stage).toHaveBeenCalledOnce();
      expect(stagedPhases.map(({ phase }) => phase)).toEqual(expectedPhases);
    } finally {
      database.close();
    }
  });

  it("resets all WASM index heads and cache while retaining the same identity and configuration", async () => {
    const identity = {};
    const client = createTestSqliteClient(identity);
    const corpusFingerprint = digest("reset-corpus");
    const embeddingFingerprint = digest("reset-model");
    await client.call("boot", {
      corpusFingerprint,
      embeddingFingerprint,
      dimensions: 2,
    });
    await applyTestLexicalRun(client, [{ path: "one.md", markdown: "alpha beta", size: 100 }]);
    const prepared = await client.call("prepareSemanticWork", {
      embeddingFingerprint,
      limit: 4,
      maxInputBytes: 1024,
    });
    await client.call("commitSemanticResults", {
      embeddingFingerprint,
      dimensions: 2,
      expectedCount: prepared.requests.length,
      results: prepared.requests.map(
        (request: { actionKey: string; inputId: number; serialization: string }) => ({
          ...request,
          vector: new Float32Array([1, 0]),
        })
      ),
    });
    const populated = await inspectSnapshotTables(await snapshotFor(identity));
    expect(populated.revisions).toBeGreaterThan(0);
    expect(populated.occurrences).toBeGreaterThan(0);
    expect(populated.inputs).toBeGreaterThan(0);
    expect(populated.cache).toBeGreaterThan(0);

    const before = await client.call("getState", {});
    const state = await client.call("resetLocalDatabase", {});

    expect(state).toMatchObject({
      corpusFingerprint,
      embeddingFingerprint,
      dimensions: 2,
      buildIdentity: before.buildIdentity,
      noteCount: 0,
      chunkCount: 0,
      compatibleVectorCount: 0,
      vectorCount: 0,
      semanticEligibleCount: 0,
      semanticHeadCount: 0,
      semanticMissingCount: 0,
    });
    expect(await inspectSnapshotTables(await snapshotFor(identity))).toEqual({
      revisions: 0,
      occurrences: 0,
      inputs: 0,
      cache: 0,
    });
    const reopened = createTestSqliteClient(identity);
    await expect(reopened.call("getState", {})).resolves.toMatchObject({
      corpusFingerprint,
      embeddingFingerprint,
      buildIdentity: before.buildIdentity,
      dimensions: 2,
      noteCount: 0,
      vectorCount: 0,
    });
  });

  it("creates only the revision/cache model", async () => {
    const identity = {};
    const client = createTestSqliteClient(identity, { persistMutations: true });
    await client.call("boot", { corpusFingerprint: digest("schema"), dimensions: 2 });
    const state = await client.call("getState", {});
    expect(state.schemaVersion).toBe(16);
    expect(state.noteCount).toBe(0);
    const columns = await inspectIndexStateColumns(await snapshotFor(identity));
    expect(columns).not.toContain("lexical_revision_count");
    expect(columns).not.toContain("semantic_revision_count");
    expect(columns).not.toContain("embedding_input_count");
  });

  it("derives note counts across empty, populated, updated, and deleted states", async () => {
    const client = createTestSqliteClient();
    await client.call("boot", { corpusFingerprint: digest("counts"), dimensions: 2 });
    await expect(client.call("getState", {})).resolves.toMatchObject({
      noteCount: 0,
      chunkCount: 0,
    });

    await applyTestLexicalRun(client, [
      { path: "one.md", markdown: "alpha", size: 100 },
      { path: "two.md", markdown: "beta", size: 100 },
    ]);
    await expect(client.call("getState", {})).resolves.toMatchObject({
      noteCount: 2,
      chunkCount: 2,
    });

    await applyTestLexicalRun(client, [{ path: "one.md", markdown: "alpha\n\nbeta", size: 100 }]);
    await expect(client.call("getState", {})).resolves.toMatchObject({
      noteCount: 2,
      chunkCount: 3,
    });

    await applyTestLexicalRun(client, [], {
      deletes: ["one.md", "two.md"],
      mayClearIncomplete: true,
    });
    await expect(client.call("getState", {})).resolves.toMatchObject({
      noteCount: 0,
      chunkCount: 0,
    });
  });

  it("deduplicates embedding actions across active occurrences", async () => {
    const client = createTestSqliteClient();
    const corpusFingerprint = digest("dedupe");
    const embeddingFingerprint = digest("model");
    await client.call("boot", { corpusFingerprint, embeddingFingerprint, dimensions: 2 });
    const markdown = "alpha alpha";
    await applyTestLexicalRun(client, [
      { path: "one.md", markdown, size: 384 },
      { path: "two.md", markdown, size: 384 },
    ]);
    const requests = await client.call("prepareSemanticWork", {
      embeddingFingerprint,
      limit: 10,
      maxInputBytes: 1024,
    });
    expect(requests.requests).toHaveLength(1);
  });

  it("preserves lexical row order, first embedding input, and rollback on insert failure", async () => {
    const sqlite = await loadTestSqlite();
    const raw = new sqlite.oo1.DB(":memory:", "c");
    const database = new MutableSqliteDatabase(raw);
    const fingerprint = digest("lexical-json-rows");
    database.boot(fingerprint, 2, digest("model"), SQLITE_BUILD_IDENTITY);
    const select = (sql: string) => {
      const result: Record<string, unknown>[] = [];
      raw.exec({
        sql,
        rowMode: "object",
        callback: (row: Record<string, unknown>) => result.push(row),
      });
      return result;
    };
    try {
      const run = database.beginLexicalRun({ scope: { mayClearIncomplete: true } });
      database.applyLexicalBatch(run.runId, [
        {
          path: "ordered.md",
          revisionDigest: digest("ordered-revision"),
          blocks: [
            {
              ordinal: 2,
              kind: "paragraph",
              startLine: 5,
              endLine: 6,
              displayText: "first row",
              headingContext: ["Header", "First"],
              embeddingInput: "first wins",
              embeddingInputDigest: "d".repeat(64),
            },
            {
              ordinal: 0,
              kind: "heading",
              startLine: 1,
              endLine: 1,
              displayText: "second row",
              headingContext: ["Second"],
              embeddingInput: "must not replace first",
              embeddingInputDigest: "d".repeat(64),
            },
            {
              ordinal: 1,
              kind: "paragraph",
              startLine: 3,
              endLine: 4,
              displayText: "third row",
              headingContext: [],
              embeddingInput: "third input",
              embeddingInputDigest: "e".repeat(64),
            },
          ],
        },
      ]);
      database.finishLexicalRun(run.runId);

      expect(
        select("SELECT ordinal,chunk_id,display_text FROM chunk_occurrences ORDER BY occurrence_id")
      ).toEqual([
        {
          ordinal: 2,
          chunk_id: `${digest("ordered-revision")}:2`,
          display_text: "first row",
        },
        {
          ordinal: 0,
          chunk_id: `${digest("ordered-revision")}:0`,
          display_text: "second row",
        },
        {
          ordinal: 1,
          chunk_id: `${digest("ordered-revision")}:1`,
          display_text: "third row",
        },
      ]);
      expect(
        select("SELECT action_key,serialized_input FROM embedding_inputs ORDER BY input_id")
      ).toEqual([
        { action_key: "d".repeat(64), serialized_input: "first wins" },
        { action_key: "e".repeat(64), serialized_input: "third input" },
      ]);

      const countsBeforeFailure = select(
        "SELECT (SELECT count(*) FROM notes) AS notes,(SELECT count(*) FROM note_revisions) AS revisions,(SELECT count(*) FROM chunk_occurrences) AS occurrences,(SELECT count(*) FROM embedding_inputs) AS inputs"
      );
      const stateBeforeFailure = database.getState();
      const failingRun = database.beginLexicalRun({ scope: { mayClearIncomplete: true } });
      expect(() =>
        database.applyLexicalBatch(failingRun.runId, [
          {
            path: "rolled-back.md",
            revisionDigest: digest("rolled-back-revision"),
            blocks: [
              {
                ordinal: 0,
                kind: "paragraph",
                startLine: 1,
                endLine: 1,
                displayText: "would be inserted before failure",
                headingContext: [],
                embeddingInput: "rollback input",
                embeddingInputDigest: digest("rollback-input"),
              },
            ],
          },
          {
            path: "invalid.md",
            revisionDigest: digest("invalid-revision"),
            blocks: [
              {
                ordinal: 0,
                kind: "paragraph",
                startLine: 1,
                endLine: 1,
                displayText: null as unknown as string,
                headingContext: [],
                embeddingInput: "invalid input",
                embeddingInputDigest: digest("invalid-input"),
              },
            ],
          },
        ])
      ).toThrow();
      database.abortLexicalRun(failingRun.runId);
      expect(
        select(
          "SELECT (SELECT count(*) FROM notes) AS notes,(SELECT count(*) FROM note_revisions) AS revisions,(SELECT count(*) FROM chunk_occurrences) AS occurrences,(SELECT count(*) FROM embedding_inputs) AS inputs"
        )
      ).toEqual(countsBeforeFailure);
      expect(database.getState()).toEqual(stateBeforeFailure);
    } finally {
      database.close();
    }
  });

  it("keeps semantic batches and state identical with phase observation enabled", async () => {
    const phases: { phase: string; sqlCalls: number; callbackRows: number }[] = [];
    const observed = createTestSqliteClient(
      {},
      {
        persistMutations: false,
        onSemanticPhase: (phase) => phases.push(phase),
      }
    );
    const plain = createTestSqliteClient({}, { persistMutations: false });
    const fingerprint = digest("observer-model");
    const run = async (client: typeof plain) => {
      await client.call("boot", {
        corpusFingerprint: digest("observer"),
        embeddingFingerprint: fingerprint,
        dimensions: 2,
      });
      await applyTestLexicalRun(client, [{ path: "one.md", markdown: "alpha", size: 100 }]);
      const prepared = await client.call("prepareSemanticWork", {
        embeddingFingerprint: fingerprint,
        limit: 1,
        maxInputBytes: 1024,
      });
      const committed = await client.call("commitSemanticResults", {
        embeddingFingerprint: fingerprint,
        dimensions: 2,
        expectedCount: prepared.requests.length,
        results: prepared.requests.map(
          (request: { actionKey: string; inputId: number; serialization: string }) => ({
            ...request,
            vector: new Float32Array([1, 0]),
          })
        ),
      });
      const empty = await client.call("prepareSemanticWork", {
        embeddingFingerprint: fingerprint,
        limit: 1,
        maxInputBytes: 1024,
      });
      const state = await client.call("getState", {});
      return { prepared, committed, empty, state };
    };
    expect(await run(observed)).toEqual(await run(plain));
    expect(
      phases.some(
        (phase) =>
          phase.phase === "boundedMissingSelection" &&
          phase.sqlCalls === 1 &&
          phase.callbackRows === 1
      )
    ).toBe(true);
    expect(phases.some((phase) => phase.phase === "firstInputLookup")).toBe(false);
    expect(phases.some((phase) => phase.phase === "transaction" && phase.sqlCalls >= 2)).toBe(true);
  });

  it("does not skip valid semantic results when diagnostics throw during enablement", async () => {
    const client = createTestSqliteClient(
      {},
      {
        diagnostics: {
          enabled: () => {
            throw new Error("diagnostics failed");
          },
          emit: () => {
            throw new Error("diagnostics failed");
          },
        },
      }
    );
    const fingerprint = digest("throwing-diagnostics");
    await client.call("boot", {
      corpusFingerprint: digest("throwing-diagnostics-corpus"),
      embeddingFingerprint: fingerprint,
      dimensions: 2,
    });
    await applyTestLexicalRun(client, [{ path: "one.md", markdown: "alpha", size: 100 }]);
    const prepared = await client.call("prepareSemanticWork", {
      embeddingFingerprint: fingerprint,
      limit: 1,
      maxInputBytes: 1024,
    });
    const committed = await client.call("commitSemanticResults", {
      embeddingFingerprint: fingerprint,
      dimensions: 2,
      expectedCount: 1,
      results: [{ ...prepared.requests[0], vector: new Float32Array([1, 0]) }],
    });
    expect(committed).toMatchObject({ stored: 1, skipped: 0, hasMore: false });
  });

  it("counts only copied semantic vectors after cancellation, stale keys, and duplicates", async () => {
    const phases: { phase: string; copiedBytes: number }[] = [];
    const client = createTestSqliteClient(
      {},
      {
        persistMutations: false,
        onSemanticPhase: (phase) => phases.push(phase),
      }
    );
    const fingerprint = digest("observer-resume-model");
    await client.call("boot", {
      corpusFingerprint: digest("observer-resume"),
      embeddingFingerprint: fingerprint,
      dimensions: 2,
    });
    await applyTestLexicalRun(client, [
      { path: "one.md", markdown: "alpha", size: 100 },
      { path: "two.md", markdown: "beta", size: 100 },
    ]);
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      client.call(
        "prepareSemanticWork",
        { embeddingFingerprint: fingerprint, limit: 1, maxInputBytes: 1024 },
        cancelled.signal
      )
    ).rejects.toMatchObject({ error: { code: "cancelled" } });
    expect(phases).toHaveLength(0);
    const first = await client.call("prepareSemanticWork", {
      embeddingFingerprint: fingerprint,
      limit: 1,
      maxInputBytes: 1024,
    });
    expect(first.requests).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    const valid = { ...first.requests[0], vector: new Float32Array([1, 0]) };
    const committed = await client.call("commitSemanticResults", {
      embeddingFingerprint: fingerprint,
      dimensions: 2,
      expectedCount: 3,
      results: [valid, valid, { ...valid, actionKey: "stale" }],
    });
    expect(committed).toMatchObject({ stored: 1, skipped: 1, hasMore: true });
    const copies = phases.filter((phase) => phase.phase === "knownBlobCopy");
    expect(copies).toHaveLength(1);
    expect(copies[0].copiedBytes).toBe(8);
    const second = await client.call("prepareSemanticWork", {
      embeddingFingerprint: fingerprint,
      limit: 1,
      maxInputBytes: 1024,
      promoteUnrestricted: false,
    });
    expect(second.requests).toHaveLength(1);
    expect(second.requests[0].actionKey).not.toBe(first.requests[0].actionKey);
    const resumed = await client.call("commitSemanticResults", {
      embeddingFingerprint: fingerprint,
      dimensions: 2,
      expectedCount: 1,
      results: [{ ...second.requests[0], vector: new Float32Array([0, 1]) }],
    });
    expect(resumed).toMatchObject({ stored: 1, skipped: 0, hasMore: false });
    expect((await client.call("getState", {})).semanticHeadCount).toBe(2);
  });

  it("tracks compact lexical and semantic visibility generations", async () => {
    const client = createTestSqliteClient();
    const corpusFingerprint = digest("generations");
    const embeddingFingerprint = digest("generation-model");
    await client.call("boot", { corpusFingerprint, embeddingFingerprint, dimensions: 2 });
    const markdown = "alpha";

    const initial = await client.call("getState", {});
    expect(initial).toMatchObject({ lexicalGeneration: 0, semanticGeneration: 0 });

    await applyTestLexicalRun(client, [{ path: "one.md", markdown, size: 100 }]);
    const lexical = await client.call("getState", {});
    expect(lexical).toMatchObject({ lexicalGeneration: 1, semanticGeneration: 0 });

    await applyTestLexicalRun(client, [{ path: "one.md", markdown, size: 100 }]);
    await expect(client.call("getState", {})).resolves.toMatchObject({
      lexicalGeneration: 1,
      semanticGeneration: 0,
    });

    await embedAllTestInputs(client, embeddingFingerprint, () => new Float32Array([1, 0]));
    const promoted = await client.call("getState", {});
    expect(promoted.semanticGeneration).toBe(1);

    await applyTestLexicalRun(client, [], {
      renames: [{ from: "one.md", to: "renamed.md" }],
      mayClearIncomplete: true,
    });
    expect(await client.call("getState", {})).toMatchObject({
      lexicalGeneration: 2,
      semanticGeneration: 2,
    });

    await applyTestLexicalRun(client, [], {
      deletes: ["renamed.md"],
      mayClearIncomplete: true,
    });
    expect(await client.call("getState", {})).toMatchObject({
      lexicalGeneration: 3,
      semanticGeneration: 3,
    });
  });

  it("keeps cache-only semantic stores off the visible generation", async () => {
    const client = createTestSqliteClient();
    const corpusFingerprint = digest("cache-only");
    const embeddingFingerprint = digest("cache-only-model");
    await client.call("boot", { corpusFingerprint, embeddingFingerprint, dimensions: 2 });
    const markdown = "alpha\n\nbeta";
    await applyTestLexicalRun(client, [{ path: "two-blocks.md", markdown, size: 100 }]);
    const prepared = await client.call("prepareSemanticWork", {
      embeddingFingerprint,
      limit: 4,
      maxInputBytes: 1024,
    });
    const requests = prepared.requests;
    expect(requests.length).toBeGreaterThanOrEqual(2);
    const first = requests[0];
    await client.call("commitSemanticResults", {
      embeddingFingerprint,
      dimensions: 2,
      expectedCount: 1,
      results: [{ ...first, vector: new Float32Array([1, 0]) }],
    });
    expect(await client.call("getState", {})).toMatchObject({
      semanticGeneration: 0,
      semanticHeadCount: 0,
    });

    const remaining = (
      await client.call("prepareSemanticWork", {
        embeddingFingerprint,
        limit: 4,
        maxInputBytes: 1024,
      })
    ).requests[0];
    await client.call("commitSemanticResults", {
      embeddingFingerprint,
      dimensions: 2,
      expectedCount: 1,
      results: [{ ...remaining, vector: new Float32Array([0, 1]) }],
    });
    expect(await client.call("getState", {})).toMatchObject({
      semanticGeneration: 1,
      semanticHeadCount: 1,
    });
  });

  it("prepares and commits semantic work in bounded set-based slices", async () => {
    const client = createTestSqliteClient();
    const corpusFingerprint = digest("semantic-slices");
    const embeddingFingerprint = digest("semantic-slices-model");
    await client.call("boot", { corpusFingerprint, embeddingFingerprint, dimensions: 2 });
    const markdown = "alpha\n\nbeta";
    await applyTestLexicalRun(client, [{ path: "slice.md", markdown, size: 100 }]);
    const prepared = await client.call("prepareSemanticWork", {
      embeddingFingerprint,
      limit: 1,
      maxInputBytes: 1024,
    });
    expect(prepared.requests).toHaveLength(1);
    expect(prepared.hasMore).toBe(true);
    const first = await client.call("commitSemanticResults", {
      embeddingFingerprint,
      dimensions: 2,
      expectedCount: 1,
      results: [{ ...prepared.requests[0], vector: new Float32Array([1, 0]) }],
    });
    expect(first).toMatchObject({ stored: 1, promoted: 0, hasMore: true });
    const next = await client.call("prepareSemanticWork", {
      embeddingFingerprint,
      limit: 1,
      maxInputBytes: 1024,
    });
    const second = await client.call("commitSemanticResults", {
      embeddingFingerprint,
      dimensions: 2,
      expectedCount: 1,
      results: [{ ...next.requests[0], vector: new Float32Array([0, 1]) }],
    });
    expect(second).toMatchObject({ stored: 1, promoted: 1, hasMore: false });
    await expect(client.call("getState", {})).resolves.toMatchObject({ semanticHeadCount: 1 });
  });

  it("bounds candidates before byte accounting while preserving input order", async () => {
    const client = createTestSqliteClient();
    const corpusFingerprint = digest("semantic-candidate-bound");
    const embeddingFingerprint = digest("semantic-candidate-model");
    await client.call("boot", { corpusFingerprint, embeddingFingerprint, dimensions: 2 });
    const empty = await client.call("prepareSemanticWork", {
      embeddingFingerprint,
      limit: 128,
      maxInputBytes: 4 * 1024 * 1024,
    });
    expect(empty.requests).toEqual([]);
    expect(empty.hasMore).toBe(false);

    const markdown = Array.from({ length: 129 }, (_, index) => `unique-${index}`).join("\n\n");
    await applyTestLexicalRun(client, [{ path: "candidate-bound.md", markdown, size: 80 }]);

    const first = await client.call("prepareSemanticWork", {
      embeddingFingerprint,
      limit: 128,
      maxInputBytes: 4 * 1024 * 1024,
    });
    expect(first.requests).toHaveLength(128);
    expect(first.requests.map((request: any) => request.inputId)).toEqual(
      [...first.requests].map((request: any) => request.inputId).sort((a, b) => a - b)
    );
    expect(first.hasMore).toBe(true);

    const repeat = await client.call("prepareSemanticWork", {
      embeddingFingerprint,
      limit: 128,
      maxInputBytes: 4 * 1024 * 1024,
    });
    expect(repeat.requests.map((request: any) => request.serialization)).toEqual(
      first.requests.map((request: any) => request.serialization)
    );

    const firstBytes = new TextEncoder().encode(first.requests[0].serialization).byteLength;
    const zeroLimit = await client.call("prepareSemanticWork", {
      embeddingFingerprint,
      limit: 0,
      maxInputBytes: firstBytes - 1,
    });
    expect(zeroLimit.requests).toEqual([]);
    expect(zeroLimit.hasMore).toBe(true);

    const byteBound = await client.call("prepareSemanticWork", {
      embeddingFingerprint,
      limit: 128,
      maxInputBytes: firstBytes,
    });
    expect(byteBound.requests).toHaveLength(1);
    expect(byteBound.requests[0].serialization).toBe(first.requests[0].serialization);

    await expect(
      client.call("prepareSemanticWork", {
        embeddingFingerprint,
        limit: 128,
        maxInputBytes: firstBytes - 1,
      })
    ).rejects.toMatchObject({
      error: {
        code: "limit_exceeded",
        retryable: false,
        message: `Semantic input is ${firstBytes} bytes; maximum is ${firstBytes - 1} bytes.`,
      },
    });
  });

  it("keeps a stale semantic result cached without promoting a changed lexical head", async () => {
    const client = createTestSqliteClient();
    const corpusFingerprint = digest("semantic-stale");
    const embeddingFingerprint = digest("semantic-stale-model");
    await client.call("boot", { corpusFingerprint, embeddingFingerprint, dimensions: 2 });
    const first = "alpha";
    await applyTestLexicalRun(client, [{ path: "stale.md", markdown: first, size: 100 }]);
    const prepared = await client.call("prepareSemanticWork", {
      embeddingFingerprint,
      limit: 1,
    });
    const second = "beta";
    await applyTestLexicalRun(client, [{ path: "stale.md", markdown: second, size: 100 }]);
    await client.call("commitSemanticResults", {
      embeddingFingerprint,
      dimensions: 2,
      expectedCount: 1,
      results: [{ ...prepared.requests[0], vector: new Float32Array([1, 0]) }],
    });
    await expect(client.call("getState", {})).resolves.toMatchObject({
      semanticHeadCount: 0,
      semanticLagCount: 1,
    });
  });

  it("keeps current full-note lexical content beside the last complete semantic head", async () => {
    const sqlite = await loadTestSqlite();
    const raw = new sqlite.oo1.DB(":memory:", "c");
    const database = new MutableSqliteDatabase(raw);
    const corpus = digest("independent-corpus");
    const embedding = digest("independent-model");
    database.boot(corpus, 2, embedding, SQLITE_BUILD_IDENTITY);
    const read = (sql: string) => {
      const result: Record<string, unknown>[] = [];
      raw.exec({
        sql,
        rowMode: "object",
        callback: (row: Record<string, unknown>) => result.push(row),
      });
      return result;
    };
    try {
      const apply = async (markdown: string) => {
        const run = database.beginLexicalRun({ scope: { mayClearIncomplete: true } });
        await applyLexicalMarkdownBatch(database, run.runId, [
          { path: "independent.md", markdown, size: 384 },
        ]);
        database.finishLexicalRun(run.runId);
      };
      const commit = (
        requests: readonly { actionKey: string; inputId: number; serialization: string }[]
      ) =>
        database.commitSemanticResults(
          requests.map((request) => ({ ...request, vector: new Float32Array([1, 0]) })),
          embedding
        );
      await apply("# Old title\n\nOld semantic passage.");
      commit(database.prepareSemanticWork(embedding, undefined, 8, 1024).requests);
      const priorSemanticRevision = read("SELECT semantic_revision_id FROM notes")[0]
        .semantic_revision_id;
      await apply("# New title\n\nCurrent lexical passage.\n\nDistant topic\n---\nneedle term.");
      expect(read("SELECT semantic_revision_id FROM notes")[0].semantic_revision_id).toBe(
        priorSemanticRevision
      );

      expect(
        database.retrieve("needle", new Float32Array([1, 0]), 5, undefined, {
          resultShape: "notes",
        })[0]
      ).toMatchObject({
        path: "independent.md",
        lexicalScore: expect.any(Number),
        semanticScore: expect.any(Number),
      });
      const lexical = read("SELECT title,headings,body FROM lexical_notes")[0];
      expect(lexical).toMatchObject({ title: "New title", headings: "New title\nDistant topic" });
      expect(lexical.body).toContain("Current lexical passage.");
      expect(lexical.body).toContain("needle term.");
      expect(lexical.body).not.toContain("Distant topic");
      expect(read("SELECT count(*) AS count FROM note_revisions")[0].count).toBe(2);

      const pending = database.prepareSemanticWork(embedding, undefined, 8, 1024);
      expect(pending.requests).toHaveLength(4);
      commit(pending.requests);
      expect(read("SELECT count(*) AS count FROM note_revisions")[0].count).toBe(1);
      expect(database.getState().semanticLagCount).toBe(0);
    } finally {
      database.close();
    }
  });

  it("retains vectors referenced by the old semantic head, then prunes after observed grace", async () => {
    const sqlite = await loadTestSqlite();
    const raw = new sqlite.oo1.DB(":memory:", "c");
    const database = new MutableSqliteDatabase(raw);
    const profile = digest("retention-profile");
    database.boot(digest("retention-corpus"), 2, profile);
    const run = database.beginLexicalRun({ scope: { mayClearIncomplete: true } });
    await applyLexicalMarkdownBatch(database, run.runId, [
      { path: "retained.md", markdown: "old semantic phrase", size: 128 },
    ]);
    database.finishLexicalRun(run.runId);
    const initial = database.prepareSemanticWork(profile);
    database.commitSemanticResults(
      initial.requests.map((request) => ({ ...request, vector: new Float32Array([1, 0]) })),
      profile
    );
    const oldCount: Record<string, unknown>[] = [];
    raw.exec({
      sql: "SELECT count(*) AS count FROM embedding_cache",
      rowMode: "object",
      callback: (row: Record<string, unknown>) => oldCount.push(row),
    });

    const edit = database.beginLexicalRun({ scope: { mayClearIncomplete: true } });
    await applyLexicalMarkdownBatch(database, edit.runId, [
      { path: "retained.md", markdown: "new lexical phrase", size: 128 },
    ]);
    database.finishLexicalRun(edit.runId);
    const now = 2_000_000_000_000;
    database.maintainCache(now);
    const protectedCount: Record<string, unknown>[] = [];
    raw.exec({
      sql: "SELECT count(*) AS count FROM embedding_cache",
      rowMode: "object",
      callback: (row: Record<string, unknown>) => protectedCount.push(row),
    });
    expect(protectedCount[0].count).toBe(oldCount[0].count);

    const next = database.prepareSemanticWork(profile);
    database.commitSemanticResults(
      next.requests.map((request) => ({ ...request, vector: new Float32Array([0, 1]) })),
      profile
    );
    database.maintainCache(now + 1);
    const beforeExpiry: Record<string, unknown>[] = [];
    raw.exec({
      sql: "SELECT count(*) AS count FROM embedding_cache",
      rowMode: "object",
      callback: (row: Record<string, unknown>) => beforeExpiry.push(row),
    });
    expect(beforeExpiry[0].count).toBeGreaterThan(protectedCount[0].count as number);
    database.maintainCache(now + 30 * 24 * 60 * 60 * 1000 + 2);
    const afterExpiry: Record<string, unknown>[] = [];
    raw.exec({
      sql: "SELECT count(*) AS count FROM embedding_cache",
      rowMode: "object",
      callback: (row: Record<string, unknown>) => afterExpiry.push(row),
    });
    expect(afterExpiry[0].count).toBeLessThan(beforeExpiry[0].count as number);
    database.close();
  });

  it("does not complete a captured retirement before its full grace window", async () => {
    const sqlite = await loadTestSqlite();
    const raw = new sqlite.oo1.DB(":memory:", "c");
    const database = new MutableSqliteDatabase(raw);
    database.boot(digest("retirement-corpus"), 2);
    const source = digest("retirement-source");
    const replacement = digest("retirement-replacement");
    const now = 2_000_000_000_000;
    await database.recordCacheRetirements([source], [replacement], now);
    expect(database.listCacheRetirements()).toEqual([
      {
        sourceDigest: source,
        replacementSetId: expect.stringMatching(new RegExp(`^${now}-[a-f0-9]{64}$`)),
        retireAfter: now + 30 * 24 * 60 * 60 * 1000,
        replacements: [replacement],
      },
    ]);
    expect(() =>
      database.completeCacheRetirement(source, now + 30 * 24 * 60 * 60 * 1000 - 1)
    ).toThrow();
    expect(database.listCacheRetirements()).toHaveLength(1);
    const original = database.listCacheRetirements();
    await database.recordCacheRetirements(
      [source],
      ["c".repeat(64)],
      now + 7 * 24 * 60 * 60 * 1000
    );
    expect(database.listCacheRetirements()).toEqual(original);
    database.completeCacheRetirement(source, now + 30 * 24 * 60 * 60 * 1000);
    expect(database.listCacheRetirements()).toEqual([]);
    database.close();
  });
});
