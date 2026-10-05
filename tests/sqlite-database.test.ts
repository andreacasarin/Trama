import { describe, expect, it, vi } from "vitest";
import {
  SQLITE_BUILD_IDENTITY,
  SQLITE_SCHEMA_9_BUILD_IDENTITY,
  SQLITE_SCHEMA_11_BUILD_IDENTITY,
  SQLITE_SCHEMA_13_BUILD_IDENTITY,
} from "@/build/identity";
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
import { createBenchmarkCounters, instrumentSqliteClient } from "./workloads/instrumentation";

const digest = (_value: string) => "a".repeat(64);

describe("revision cache database", () => {
  it("migrates schema 13 to full-note lexical search without losing heads or vectors", async () => {
    const sqlite = await loadTestSqlite();
    const raw = new sqlite.oo1.DB(":memory:", "c");
    const database = new MutableSqliteDatabase(raw);
    const corpus = digest("schema-13-migration-corpus");
    const embedding = digest("schema-13-migration-profile");
    database.boot(corpus, 2, embedding);
    const run = database.beginLexicalRun({ scope: { mayClearIncomplete: true } });
    await applyLexicalMarkdownBatch(database, run.runId, [
      { path: "migration.md", markdown: "# Migration\n\nPreserved vector coverage." },
    ]);
    database.finishLexicalRun(run.runId);
    const work = database.prepareSemanticWork(embedding);
    database.commitSemanticResults(
      work.requests.map((request) => ({ ...request, vector: new Float32Array([1, 0]) })),
      embedding
    );
    raw.exec(`CREATE TABLE active_lexical (
      occurrence_id INTEGER PRIMARY KEY,note_id INTEGER NOT NULL,revision_id INTEGER NOT NULL,
      path_text TEXT NOT NULL,filename TEXT NOT NULL,body TEXT NOT NULL
    ) STRICT`);
    raw.exec(`CREATE VIRTUAL TABLE active_lexical_fts USING fts5(
      body,path_text,filename,content='active_lexical',content_rowid='occurrence_id',
      tokenize='unicode61 remove_diacritics 2'
    )`);
    raw.exec({
      sql: `INSERT INTO active_lexical(occurrence_id,note_id,revision_id,path_text,filename,body)
            SELECT o.occurrence_id,o.note_id,o.revision_id,n.path,'migration',o.display_text
            FROM chunk_occurrences o JOIN notes n ON n.note_id=o.note_id
            WHERE o.revision_id=n.lexical_revision_id`,
    });
    raw.exec("INSERT INTO active_lexical_fts(active_lexical_fts) VALUES('rebuild')");
    raw.exec({
      sql: "UPDATE index_state SET schema_version=13,protocol_version=12,build_identity=? WHERE id=1",
      bind: [SQLITE_SCHEMA_13_BUILD_IDENTITY],
    });
    raw.exec("PRAGMA user_version=13");

    const migrated = database.boot(corpus, 2, embedding);
    expect(migrated).toMatchObject({ schemaVersion: 14, semanticHeadCount: 1 });
    expect(Number(raw.selectValue("SELECT count(*) FROM embedding_cache"))).toBeGreaterThan(0);
    expect(
      Number(raw.selectValue("SELECT count(*) FROM sqlite_master WHERE name='active_lexical'"))
    ).toBe(0);
    expect(database.retrieve("Preserved", new Float32Array([1, 0]), 5)).toContainEqual(
      expect.objectContaining({ path: "migration.md", text: expect.stringContaining("Preserved") })
    );
    database.close();
  });

  it("migrates schema 11 profile foundations without losing semantic coverage", async () => {
    const sqlite = await loadTestSqlite();
    const raw = new sqlite.oo1.DB(":memory:", "c");
    const database = new MutableSqliteDatabase(raw);
    const corpus = digest("schema-11-migration-corpus");
    const embedding = digest("schema-11-migration-profile");
    database.boot(corpus, 2, embedding);
    const run = database.beginLexicalRun({ scope: { mayClearIncomplete: true } });
    await applyLexicalMarkdownBatch(database, run.runId, [
      { path: "migration.md", markdown: "# Migration\n\nPreserved vector coverage." },
    ]);
    database.finishLexicalRun(run.runId);
    const work = database.prepareSemanticWork(embedding);
    database.commitSemanticResults(
      work.requests.map((request) => ({ ...request, vector: new Float32Array([1, 0]) })),
      embedding
    );
    raw.exec("DROP TABLE embedding_profiles");
    raw.exec({
      sql: "UPDATE index_state SET schema_version=11,protocol_version=10,build_identity=? WHERE id=1",
      bind: [SQLITE_SCHEMA_11_BUILD_IDENTITY],
    });
    raw.exec("PRAGMA user_version=11");

    const migrated = database.boot(corpus, 2, embedding);
    expect(migrated).toMatchObject({
      schemaVersion: 14,
      semanticHeadCount: 1,
      compatibleVectorCount: 2,
      embeddingFingerprint: embedding,
    });
    expect(migrated.embeddingProfiles).toContainEqual(
      expect.objectContaining({ fingerprint: embedding, dimensions: 2, vectorCount: 2 })
    );
    database.close();
  });

  it("drops a stale query vector when the active profile changes before retrieval", async () => {
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
    raw.exec({
      sql: "INSERT INTO embedding_profiles(fingerprint,dimensions,model_id,endpoint_origin) VALUES(?,2,'other','')",
      bind: [nextProfile],
    });
    raw.exec({
      sql: "INSERT INTO embedding_cache(input_digest,action_key,embedding_fingerprint,preprocessing,vector,task_kind,created_at) VALUES('input','cache-key',?,'normalized-float32-v1',?,'document',1)",
      bind: [nextProfile, new Uint8Array(new Float32Array([0, 1]).buffer)],
    });
    database.selectEmbeddingProfile(nextProfile);
    const hits = database.retrieve("alpha", new Float32Array([0, 1]), 5, undefined, {
      expectedEmbeddingFingerprint: previousProfile,
    });
    expect(hits).toEqual([expect.objectContaining({ path: "fence.md" })]);
    expect(hits[0].semanticScore).toBeUndefined();
    database.close();
  });

  it("keeps ambiguous imported profiles unselected and persists a local profile choice", async () => {
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
    database.selectEmbeddingProfile(first);
    expect(database.boot(corpus, 2, "").embeddingFingerprint).toBe(first);
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
    expect(state.schemaVersion).toBe(14);
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
        select(
          "SELECT ordinal,chunk_id,display_text,heading_context,body FROM chunk_occurrences ORDER BY occurrence_id"
        )
      ).toEqual([
        {
          ordinal: 2,
          chunk_id: `${digest("ordered-revision")}:2`,
          display_text: "first row",
          heading_context: '["Header","First"]',
          body: "first row",
        },
        {
          ordinal: 0,
          chunk_id: `${digest("ordered-revision")}:0`,
          display_text: "second row",
          heading_context: '["Second"]',
          body: "second row",
        },
        {
          ordinal: 1,
          chunk_id: `${digest("ordered-revision")}:1`,
          display_text: "third row",
          heading_context: "[]",
          body: "third row",
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
        onSemanticHandler: () => {
          throw new Error("observer failed");
        },
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
    const counters = createBenchmarkCounters();
    counters.semanticScenario = "observer-resume";
    const client = instrumentSqliteClient(
      createTestSqliteClient(
        {},
        {
          persistMutations: false,
          onSemanticPhase: (phase) => counters.semanticPhases.push(phase),
          onSemanticHandler: (_method, elapsedMs) => counters.semanticHandlerMs.push(elapsedMs),
        }
      ),
      counters
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
    expect(counters.semanticPhases).toHaveLength(0);
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
    const copy = counters.semanticCalls.at(-1)!;
    expect(copy.vectorPayloadBytes).toBe(24);
    expect(copy.blobCopyBytes).toBe(8);
    expect(copy.phases.find((phase) => phase.phase === "knownBlobCopy")?.samples).toBe(1);
    expect(copy.phases.find((phase) => phase.phase === "transaction")?.sqlCalls).toBe(13);
    expect(
      copy.phases.filter((phase) => !phase.nested).reduce((sum, phase) => sum + phase.sqlCalls, 0)
    ).toBe(16);
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

  it("keeps lexical and old semantic heads while pruning pending publication material", async () => {
    const client = createTestSqliteClient();
    const corpusFingerprint = digest("heads");
    const embeddingFingerprint = digest("model");
    await client.call("boot", { corpusFingerprint, embeddingFingerprint, dimensions: 2 });

    await applyTestLexicalRun(client, [{ path: "one.md", markdown: "alpha", size: 100 }]);
    await embedAllTestInputs(client, embeddingFingerprint, () => new Float32Array([1, 0]));

    await applyTestLexicalRun(client, [{ path: "two.md", markdown: "alpha", size: 100 }]);
    expect(
      (
        await client.call("prepareSemanticWork", {
          embeddingFingerprint,
          limit: 10,
          maxInputBytes: 1024,
        })
      ).requests
    ).toHaveLength(0);

    await applyTestLexicalRun(client, [{ path: "one.md", markdown: "beta", size: 100 }]);
    const prepared = await client.call("preparePublication", { publicationId: "heads-1" });
    expect(await inspectSnapshotTables(prepared.bytes)).toEqual({
      revisions: 3,
      occurrences: 3,
      inputs: 2,
      cache: 1,
    });
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

  it("requires both publication generation fences to match", async () => {
    const client = createTestSqliteClient();
    await client.call("boot", { corpusFingerprint: digest("publication-fence"), dimensions: 2 });
    await applyTestLexicalRun(client, [{ path: "one.md", markdown: "alpha", size: 100 }]);
    const prepared = await client.call("preparePublication", { publicationId: "fenced-1" });

    await expect(
      client.call("finalizePublication", {
        publicationId: "fenced-1",
        expectedChangeCounter: prepared.state.changeCounter,
        expectedLexicalGeneration: prepared.state.lexicalGeneration + 1,
        expectedSemanticGeneration: prepared.state.semanticGeneration,
      })
    ).rejects.toMatchObject({ error: { code: "busy" } });

    await expect(
      client.call("finalizePublication", {
        publicationId: "fenced-1",
        expectedChangeCounter: prepared.state.changeCounter,
        expectedLexicalGeneration: prepared.state.lexicalGeneration,
        expectedSemanticGeneration: prepared.state.semanticGeneration,
      })
    ).resolves.toMatchObject({ publicationId: "fenced-1" });
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

  it("migrates legacy schema 9 transactionally while preserving semantic heads and vectors", async () => {
    const sqlite = await loadTestSqlite();
    const raw = new sqlite.oo1.DB(":memory:", "c");
    const database = new MutableSqliteDatabase(raw);
    const corpus = digest("migration-corpus");
    const embedding = digest("migration-model");
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
      const run = database.beginLexicalRun({ scope: { mayClearIncomplete: true } });
      await applyLexicalMarkdownBatch(database, run.runId, [
        { path: "migration/note.md", markdown: "# Migration\n\nOld semantic text.", size: 384 },
      ]);
      database.finishLexicalRun(run.runId);
      const work = database.prepareSemanticWork(embedding, undefined, 8, 1024);
      database.commitSemanticResults(
        work.requests.map((request) => ({ ...request, vector: new Float32Array([1, 0]) })),
        embedding
      );
      expect(database.getState().semanticHeadCount).toBe(1);
      expect(read("SELECT count(*) AS count FROM embedding_cache")[0].count).toBe(2);

      raw.exec(`DROP TRIGGER lexical_notes_ai; DROP TRIGGER lexical_notes_ad; DROP TRIGGER lexical_notes_au;
        DROP TABLE lexical_notes_fts; DROP INDEX lexical_notes_revision; DROP TABLE lexical_notes;
        UPDATE index_state SET schema_version=9,protocol_version=9,build_identity='${SQLITE_SCHEMA_9_BUILD_IDENTITY}';
        PRAGMA user_version=9;`);
      const migrated = new MutableSqliteDatabase(raw);
      const state = migrated.boot(corpus, 2, embedding, SQLITE_BUILD_IDENTITY);

      expect(state.schemaVersion).toBe(14);
      expect(state.semanticHeadCount).toBe(1);
      expect(state.compatibleVectorCount).toBe(2);
      expect(read("SELECT title,headings,body,path_text FROM lexical_notes")).toEqual([
        {
          title: "Migration",
          headings: "# Migration",
          body: "# Migration\nOld semantic text.",
          path_text: "migration/note.md",
        },
      ]);

      const reuseRun = migrated.beginLexicalRun({ scope: { mayClearIncomplete: true } });
      await applyLexicalMarkdownBatch(migrated, reuseRun.runId, [
        { path: "migration/note.md", markdown: "# Migration\n\nOld semantic text.", size: 384 },
        { path: "migration-copy.md", markdown: "# Migration\n\nOld semantic text.", size: 384 },
      ]);
      migrated.finishLexicalRun(reuseRun.runId);
      const reused = migrated.prepareSemanticWork(embedding);
      expect(reused.promoted).toBeGreaterThan(0);
      expect(reused.requests).toEqual([]);
      expect(migrated.getState().semanticHeadCount).toBe(2);
      migrated.close();
    } finally {
      try {
        database.close();
      } catch {
        // The migrated database closes the shared in-memory connection.
      }
    }
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
    database.completeCacheRetirement(source, now + 30 * 24 * 60 * 60 * 1000);
    expect(database.listCacheRetirements()).toEqual([]);
    database.close();
  });

  it("rolls back a failed schema 9 migration without changing legacy coverage", async () => {
    const sqlite = await loadTestSqlite();
    const raw = new sqlite.oo1.DB(":memory:", "c");
    const database = new MutableSqliteDatabase(raw);
    const corpus = digest("migration-rollback-corpus");
    const embedding = digest("migration-rollback-model");
    database.boot(corpus, 2, embedding, SQLITE_BUILD_IDENTITY);
    const run = database.beginLexicalRun({ scope: { mayClearIncomplete: true } });
    await applyLexicalMarkdownBatch(database, run.runId, [
      { path: "legacy.md", markdown: "# Legacy\n\nRetained vector.", size: 384 },
    ]);
    database.finishLexicalRun(run.runId);
    const work = database.prepareSemanticWork(embedding, undefined, 8, 1024);
    database.commitSemanticResults(
      work.requests.map((request) => ({ ...request, vector: new Float32Array([1, 0]) })),
      embedding
    );
    raw.exec(`DROP TRIGGER lexical_notes_ai; DROP TRIGGER lexical_notes_ad; DROP TRIGGER lexical_notes_au;
      DROP TABLE lexical_notes_fts; DROP INDEX lexical_notes_revision; DROP TABLE lexical_notes;
      CREATE TRIGGER lexical_notes_ai AFTER INSERT ON notes BEGIN SELECT 1; END;
      UPDATE index_state SET schema_version=9,protocol_version=9,build_identity='${SQLITE_SCHEMA_9_BUILD_IDENTITY}';
      PRAGMA user_version=9;`);
    try {
      expect(() => database.boot(corpus, 2, embedding, SQLITE_BUILD_IDENTITY)).toThrow();
      const state = database.getState();
      expect(state.schemaVersion).toBe(9);
      expect(state.semanticHeadCount).toBe(1);
      const remaining: Record<string, unknown>[] = [];
      raw.exec({
        sql: "SELECT count(*) AS count FROM embedding_cache",
        rowMode: "object",
        callback: (row: Record<string, unknown>) => remaining.push(row),
      });
      expect(remaining[0].count).toBe(2);
      const tables: Record<string, unknown>[] = [];
      raw.exec({
        sql: "SELECT name FROM sqlite_master WHERE name='lexical_notes'",
        rowMode: "object",
        callback: (row: Record<string, unknown>) => tables.push(row),
      });
      expect(tables).toEqual([]);
    } finally {
      database.close();
    }
  });
});
