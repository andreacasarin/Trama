import { describe, expect, it } from "vitest";
import { createTestSqliteClient, inspectSnapshotTables } from "./sqlite-test-client";

const digest = (_value: string) => "a".repeat(64);

describe("revision cache database", () => {
  it("creates only the revision/cache model", async () => {
    const client = createTestSqliteClient();
    await client.call("boot", { corpusFingerprint: digest("schema"), dimensions: 2 });
    const state = await client.call("getState", {});
    expect(state.schemaVersion).toBe(8);
    expect(state.noteCount).toBe(0);
  });

  it("deduplicates embedding actions across active occurrences", async () => {
    const client = createTestSqliteClient();
    const corpusFingerprint = digest("dedupe");
    const embeddingFingerprint = digest("model");
    await client.call("boot", { corpusFingerprint, embeddingFingerprint, dimensions: 2 });
    const markdown = "alpha alpha";
    const revisionDigest = await client.call("hashMarkdown", { markdown, corpusFingerprint });
    await client.call("upsertLexicalRevision", {
      path: "one.md",
      markdown,
      expectedRevisionDigest: revisionDigest,
      size: 384,
    });
    await client.call("upsertLexicalRevision", {
      path: "two.md",
      markdown,
      expectedRevisionDigest: revisionDigest,
      size: 384,
    });
    const requests = await client.call("listMissingEmbeddingInputs", {
      embeddingFingerprint,
      limit: 10,
    });
    expect(requests).toHaveLength(1);
  });

  it("keeps lexical and old semantic heads while pruning pending publication material", async () => {
    const client = createTestSqliteClient();
    const corpusFingerprint = digest("heads");
    const embeddingFingerprint = digest("model");
    await client.call("boot", { corpusFingerprint, embeddingFingerprint, dimensions: 2 });

    const first = await client.call("hashMarkdown", {
      markdown: "alpha",
      corpusFingerprint,
    });
    await client.call("upsertLexicalRevision", {
      path: "one.md",
      markdown: "alpha",
      expectedRevisionDigest: first,
      size: 100,
    });
    const firstRequest = (
      await client.call("listMissingEmbeddingInputs", {
        embeddingFingerprint,
        limit: 10,
      })
    )[0];
    await client.call("storeEmbeddingResults", {
      embeddingFingerprint,
      results: [
        {
          actionKey: firstRequest.actionKey,
          inputId: firstRequest.inputId,
          serialization: firstRequest.serialization,
          vector: new Float32Array([1, 0]),
        },
      ],
    });

    const shared = await client.call("hashMarkdown", {
      markdown: "alpha",
      corpusFingerprint,
    });
    await client.call("upsertLexicalRevision", {
      path: "two.md",
      markdown: "alpha",
      expectedRevisionDigest: shared,
      size: 100,
    });
    expect(
      await client.call("listMissingEmbeddingInputs", { embeddingFingerprint, limit: 10 })
    ).toHaveLength(0);

    const second = await client.call("hashMarkdown", {
      markdown: "beta",
      corpusFingerprint,
    });
    await client.call("upsertLexicalRevision", {
      path: "one.md",
      markdown: "beta",
      expectedRevisionDigest: second,
      size: 100,
    });
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
    const revisionDigest = await client.call("hashMarkdown", {
      markdown,
      corpusFingerprint,
    });

    const initial = await client.call("getState", {});
    expect(initial).toMatchObject({ lexicalGeneration: 0, semanticGeneration: 0 });
    expect(initial.semanticHeadKey).toBeUndefined();

    await client.call("upsertLexicalRevision", {
      path: "one.md",
      markdown,
      expectedRevisionDigest: revisionDigest,
      size: 100,
    });
    const lexical = await client.call("getState", {});
    expect(lexical).toMatchObject({ lexicalGeneration: 1, semanticGeneration: 0 });

    await client.call("upsertLexicalRevision", {
      path: "one.md",
      markdown,
      expectedRevisionDigest: revisionDigest,
      size: 100,
    });
    await expect(client.call("getState", {})).resolves.toMatchObject({
      lexicalGeneration: 1,
      semanticGeneration: 0,
    });

    const request = (
      await client.call("listMissingEmbeddingInputs", { embeddingFingerprint, limit: 4 })
    )[0];
    await client.call("storeEmbeddingResults", {
      embeddingFingerprint,
      results: [{ ...request, vector: new Float32Array([1, 0]) }],
    });
    const promoted = await client.call("getState", {});
    expect(promoted.semanticGeneration).toBe(1);

    await client.call("renameLexicalNote", { from: "one.md", to: "renamed.md" });
    expect(await client.call("getState", {})).toMatchObject({
      lexicalGeneration: 2,
      semanticGeneration: 2,
    });

    await client.call("deleteLexicalNote", { path: "renamed.md" });
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
    const revisionDigest = await client.call("hashMarkdown", {
      markdown,
      corpusFingerprint,
    });
    await client.call("upsertLexicalRevision", {
      path: "two-blocks.md",
      markdown,
      expectedRevisionDigest: revisionDigest,
      size: 100,
    });
    const requests = await client.call("listMissingEmbeddingInputs", {
      embeddingFingerprint,
      limit: 4,
    });
    expect(requests.length).toBeGreaterThanOrEqual(2);
    const first = requests[0];
    await client.call("storeEmbeddingResults", {
      embeddingFingerprint,
      results: [{ ...first, vector: new Float32Array([1, 0]) }],
    });
    expect(await client.call("getState", {})).toMatchObject({
      semanticGeneration: 0,
      semanticHeadCount: 0,
    });

    const remaining = (
      await client.call("listMissingEmbeddingInputs", {
        embeddingFingerprint,
        limit: 4,
      })
    )[0];
    await client.call("storeEmbeddingResults", {
      embeddingFingerprint,
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
    const revisionDigest = await client.call("hashMarkdown", {
      markdown,
      corpusFingerprint,
    });
    await client.call("upsertLexicalRevision", {
      path: "slice.md",
      markdown,
      expectedRevisionDigest: revisionDigest,
      size: 100,
    });
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
    const revisionDigest = await client.call("hashMarkdown", {
      markdown,
      corpusFingerprint,
    });
    await client.call("upsertLexicalRevision", {
      path: "candidate-bound.md",
      markdown,
      expectedRevisionDigest: revisionDigest,
      size: 80,
    });

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
    const firstDigest = await client.call("hashMarkdown", {
      markdown: first,
      corpusFingerprint,
    });
    await client.call("upsertLexicalRevision", {
      path: "stale.md",
      markdown: first,
      expectedRevisionDigest: firstDigest,
      size: 100,
    });
    const prepared = await client.call("prepareSemanticWork", {
      embeddingFingerprint,
      limit: 1,
    });
    const second = "beta";
    const secondDigest = await client.call("hashMarkdown", {
      markdown: second,
      corpusFingerprint,
    });
    await client.call("upsertLexicalRevision", {
      path: "stale.md",
      markdown: second,
      expectedRevisionDigest: secondDigest,
      size: 100,
    });
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
