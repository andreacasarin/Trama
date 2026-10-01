import { describe, expect, it } from "vitest";
import {
  applyTestLexicalRun,
  createTestSqliteClient,
  embedAllTestInputs,
  inspectIndexStateColumns,
  inspectSnapshotTables,
  snapshotFor,
} from "./sqlite-test-client";
import { createBenchmarkCounters, instrumentSqliteClient } from "./workloads/instrumentation";

const digest = (_value: string) => "a".repeat(64);

describe("revision cache database", () => {
  it("creates only the revision/cache model", async () => {
    const identity = {};
    const client = createTestSqliteClient(identity, { persistMutations: true });
    await client.call("boot", { corpusFingerprint: digest("schema"), dimensions: 2 });
    const state = await client.call("getState", {});
    expect(state.schemaVersion).toBe(9);
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
    expect(copy.phases.find((phase) => phase.phase === "transaction")?.sqlCalls).toBe(12);
    expect(
      copy.phases.filter((phase) => !phase.nested).reduce((sum, phase) => sum + phase.sqlCalls, 0)
    ).toBe(15);
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
        message: expect.stringMatching(/^Semantic input is \d+ bytes; maximum is \d+ bytes\.$/),
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
});
