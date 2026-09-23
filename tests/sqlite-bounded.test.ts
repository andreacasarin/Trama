import { describe, expect, it } from "vitest";
import {
  SQLITE_MAX_MARKDOWN,
  SQLITE_MAX_LEXICAL_BATCH_MARKDOWN_BYTES,
  SQLITE_MAX_LEXICAL_BATCH_NOTES,
  SQLITE_PROTOCOL_VERSION,
  validateRequest,
} from "@/index/sqlite/protocol";
import { createTestSqliteClient, inspectPersistedLexicalRevisionCount } from "./sqlite-test-client";

const digest = (_value: string) => "a".repeat(64);

describe("bounded lexical runs", () => {
  it("validates note, Markdown, and run limits at the protocol boundary", () => {
    const envelope = (payload: object) => ({
      v: SQLITE_PROTOCOL_VERSION,
      id: 1,
      method: "applyLexicalBatch",
      payload,
    });
    const note = { path: "a.md", markdown: "x" };
    expect(() =>
      validateRequest(
        envelope({
          runId: "run-1",
          notes: Array.from({ length: SQLITE_MAX_LEXICAL_BATCH_NOTES + 1 }, () => note),
        })
      )
    ).toThrow();
    expect(() =>
      validateRequest(
        envelope({
          runId: "run-1",
          notes: [{ path: "a.md", markdown: "x".repeat(SQLITE_MAX_LEXICAL_BATCH_MARKDOWN_BYTES) }],
        })
      )
    ).not.toThrow();
    expect(() =>
      validateRequest(
        envelope({
          runId: "run-1",
          notes: [
            {
              path: "a.md",
              markdown: "x".repeat(SQLITE_MAX_LEXICAL_BATCH_MARKDOWN_BYTES + 1),
            },
          ],
        })
      )
    ).not.toThrow();
    expect(() =>
      validateRequest(
        envelope({
          runId: "run-1",
          notes: [
            { path: "a.md", markdown: "x".repeat(4 * 1024 * 1024) },
            { path: "b.md", markdown: "x".repeat(4 * 1024 * 1024) },
          ],
        })
      )
    ).not.toThrow();
    expect(() =>
      validateRequest(
        envelope({
          runId: "run-1",
          notes: [
            { path: "a.md", markdown: "x".repeat(4 * 1024 * 1024) },
            { path: "b.md", markdown: "x".repeat(4 * 1024 * 1024 + 1) },
          ],
        })
      )
    ).toThrow();
    expect(() =>
      validateRequest(
        envelope({
          runId: "run-1",
          notes: [{ path: "a.md", markdown: "x".repeat(SQLITE_MAX_MARKDOWN) }],
        })
      )
    ).not.toThrow();
    expect(() =>
      validateRequest(
        envelope({
          runId: "run-1",
          notes: [{ path: "a.md", markdown: "x".repeat(SQLITE_MAX_MARKDOWN + 1) }],
        })
      )
    ).toThrow();
  });

  it("commits one generation for a changed batch and skips unchanged notes before parsing", async () => {
    const client = createTestSqliteClient();
    const corpusFingerprint = digest("corpus");
    await client.call("boot", { corpusFingerprint, dimensions: 2 });
    const run = await client.call("beginLexicalRun", {});
    const applied = await client.call("applyLexicalBatch", {
      runId: run.runId,
      notes: [
        { path: "one.md", markdown: "alpha" },
        { path: "two.md", markdown: "beta" },
      ],
    });
    expect(applied).toMatchObject({
      changed: true,
      applied: 2,
      skipped: 0,
      receipt: { generation: { lexicalGeneration: 1 } },
    });
    const finished = await client.call("finishLexicalRun", { runId: run.runId });
    expect(finished.state).toMatchObject({ lexicalGeneration: 1, noteCount: 2, incomplete: false });

    const second = await client.call("beginLexicalRun", {});
    await expect(
      client.call("applyLexicalBatch", {
        runId: second.runId,
        notes: [{ path: "one.md", markdown: "alpha" }],
      })
    ).resolves.toMatchObject({ changed: false, applied: 0, skipped: 1 });
    await client.call("finishLexicalRun", { runId: second.runId });
    await expect(client.call("getState", {})).resolves.toMatchObject({ lexicalGeneration: 1 });
  });

  it("pairs duplicate-content renames by sorted path and preserves note IDs", async () => {
    const client = createTestSqliteClient();
    const corpusFingerprint = digest("rename-corpus");
    await client.call("boot", { corpusFingerprint, dimensions: 2 });
    const contentId = await client.call("hashMarkdown", { corpusFingerprint, markdown: "same" });
    for (const path of ["one.md", "two.md"])
      await client.call("upsertLexicalRevision", {
        path,
        markdown: "same",
        expectedRevisionDigest: contentId,
      });
    const before = await client.call("listLexicalSummaries", {});
    const run = await client.call("beginLexicalRun", {
      summaries: [
        { path: "new-a.md", contentId },
        { path: "new-b.md", contentId },
      ],
    });
    await client.call("applyLexicalBatch", { runId: run.runId, notes: [] });
    await client.call("finishLexicalRun", { runId: run.runId });
    const after = await client.call("listLexicalSummaries", {});
    expect(after.map((item: any) => [item.path, item.noteId])).toEqual([
      ["new-a.md", before.find((item: any) => item.path === "one.md").noteId],
      ["new-b.md", before.find((item: any) => item.path === "two.md").noteId],
    ]);
  });

  it("keeps prior batches durable and leaves an aborted run incomplete", async () => {
    const client = createTestSqliteClient();
    const corpusFingerprint = digest("abort-corpus");
    await client.call("boot", { corpusFingerprint, dimensions: 2 });
    const run = await client.call("beginLexicalRun", {});
    await client.call("applyLexicalBatch", {
      runId: run.runId,
      notes: [{ path: "prior.md", markdown: "prior" }],
    });
    const next = await client.call("beginLexicalRun", {});
    await client.call("abortLexicalRun", { runId: next.runId });
    await expect(client.call("getState", {})).resolves.toMatchObject({
      noteCount: 1,
      incomplete: true,
    });
    await client.call("abortLexicalRun", { runId: run.runId });
  });

  it("retracts old FTS postings and drains deleted paths at finish", async () => {
    const client = createTestSqliteClient();
    const corpusFingerprint = digest("fts-corpus");
    await client.call("boot", { corpusFingerprint, dimensions: 2 });
    const first = await client.call("beginLexicalRun", {});
    await client.call("applyLexicalBatch", {
      runId: first.runId,
      notes: [{ path: "old.md", markdown: "stale-word" }],
    });
    await client.call("finishLexicalRun", { runId: first.runId });
    const replacement = await client.call("beginLexicalRun", {
      summaries: [
        {
          path: "new.md",
          contentId: await client.call("hashMarkdown", {
            corpusFingerprint,
            markdown: "fresh-word",
          }),
        },
      ],
    });
    await client.call("applyLexicalBatch", {
      runId: replacement.runId,
      notes: [{ path: "new.md", markdown: "fresh-word" }],
    });
    await client.call("finishLexicalRun", { runId: replacement.runId });
    await expect(client.call("retrieve", { query: "stale-word", limit: 10 })).resolves.toHaveLength(
      0
    );
    await expect(client.call("retrieve", { query: "fresh-word", limit: 10 })).resolves.toHaveLength(
      1
    );
  });

  it("drains deletion manifests in bounded groups", async () => {
    const client = createTestSqliteClient();
    const corpusFingerprint = digest("delete-corpus");
    await client.call("boot", { corpusFingerprint, dimensions: 2 });
    const run = await client.call("beginLexicalRun", {});
    await client.call("applyLexicalBatch", {
      runId: run.runId,
      notes: Array.from({ length: 16 }, (_, index) => ({
        path: `delete-${index}.md`,
        markdown: `delete-${index}`,
      })),
    });
    await client.call("finishLexicalRun", { runId: run.runId });
    const extra = await client.call("beginLexicalRun", {});
    await client.call("applyLexicalBatch", {
      runId: extra.runId,
      notes: [{ path: "delete-16.md", markdown: "delete-16" }],
    });
    await client.call("finishLexicalRun", { runId: extra.runId });
    const drain = await client.call("beginLexicalRun", { summaries: [] });
    const first = await client.call("finishLexicalRun", { runId: drain.runId });
    expect(first).toMatchObject({ complete: false, remaining: 1, state: { noteCount: 1 } });
    const second = await client.call("finishLexicalRun", { runId: drain.runId });
    expect(second).toMatchObject({ complete: true, state: { noteCount: 0, incomplete: false } });
  });

  it("stages and promotes a single revision above the internal occurrence slice", async () => {
    const client = createTestSqliteClient();
    const corpusFingerprint = digest("oversized-note");
    await client.call("boot", { corpusFingerprint, dimensions: 2 });
    const run = await client.call("beginLexicalRun", {});
    const markdown = Array.from({ length: 2_001 }, (_, index) => `# marker-${index}`).join("\n");
    const result = await client.call("applyLexicalBatch", {
      runId: run.runId,
      notes: [{ path: "oversized.md", markdown, size: 64 }],
    });
    expect(result).toMatchObject({ changed: true, applied: 1, occurrences: 2_001 });
    expect(result.receipt.generation).toMatchObject({ lexicalGeneration: 1 });
    await client.call("finishLexicalRun", { runId: run.runId });
    await expect(client.call("retrieve", { query: "marker-0", limit: 10 })).resolves.toHaveLength(
      1
    );
    await expect(
      client.call("retrieve", { query: "marker-2000", limit: 10 })
    ).resolves.toHaveLength(1);
  });

  it("flushes complete notes adaptively and aggregates one response", async () => {
    const client = createTestSqliteClient();
    const corpusFingerprint = digest("adaptive-notes");
    await client.call("boot", { corpusFingerprint, dimensions: 2 });
    const run = await client.call("beginLexicalRun", {});
    const note = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, index) => `# ${prefix}-${index}`).join("\n");
    const result = await client.call("applyLexicalBatch", {
      runId: run.runId,
      notes: [
        { path: "first.md", markdown: note("first", 1_500), size: 64 },
        { path: "second.md", markdown: note("second", 1_500), size: 64 },
      ],
    });
    expect(result).toMatchObject({ changed: true, applied: 2, occurrences: 3_000 });
    await client.call("finishLexicalRun", { runId: run.runId });
    await expect(client.call("retrieve", { query: "first-1499", limit: 10 })).resolves.toHaveLength(
      1
    );
    await expect(
      client.call("retrieve", { query: "second-1499", limit: 10 })
    ).resolves.toHaveLength(1);
  });

  it("keeps the prior semantic head while atomically replacing oversized lexical postings", async () => {
    const client = createTestSqliteClient();
    const corpusFingerprint = digest("semantic-head");
    const embeddingFingerprint = digest("semantic-model");
    await client.call("boot", { corpusFingerprint, embeddingFingerprint, dimensions: 2 });
    const initialRun = await client.call("beginLexicalRun", {});
    await client.call("applyLexicalBatch", {
      runId: initialRun.runId,
      notes: [{ path: "head.md", markdown: "old-token" }],
    });
    await client.call("finishLexicalRun", { runId: initialRun.runId });
    const prepared = await client.call("prepareSemanticWork", {
      embeddingFingerprint,
      limit: 4,
      maxInputBytes: 1024,
    });
    await client.call("commitSemanticResults", {
      embeddingFingerprint,
      dimensions: 2,
      expectedCount: prepared.requests.length,
      results: prepared.requests.map((request: any) => ({
        ...request,
        vector: new Float32Array([1, 0]),
      })),
    });
    await client.call("prepareSemanticWork", {
      embeddingFingerprint,
      limit: 4,
      maxInputBytes: 1024,
    });
    const before = (await client.call("listLexicalSummaries", {})).find(
      (item: any) => item.path === "head.md"
    );
    expect(before.semanticRevisionId).toBe(before.lexicalRevisionId);

    const replacementRun = await client.call("beginLexicalRun", {});
    const replacement = Array.from({ length: 2_001 }, (_, index) => `# new-token-${index}`).join(
      "\n"
    );
    await client.call("applyLexicalBatch", {
      runId: replacementRun.runId,
      notes: [{ path: "head.md", markdown: replacement, size: 64 }],
    });
    const after = (await client.call("listLexicalSummaries", {})).find(
      (item: any) => item.path === "head.md"
    );
    expect(after.semanticRevisionId).toBe(before.semanticRevisionId);
    expect(after.lexicalRevisionId).not.toBe(before.lexicalRevisionId);
    await expect(client.call("retrieve", { query: "old-token", limit: 10 })).resolves.toHaveLength(
      0
    );
    await expect(
      client.call("retrieve", { query: "new-token-2000", limit: 10 })
    ).resolves.toHaveLength(1);
    await client.call("finishLexicalRun", { runId: replacementRun.runId });
  });

  it("routes the compatibility upsert through bounded staging for oversized notes", async () => {
    const client = createTestSqliteClient();
    const corpusFingerprint = digest("legacy-oversized-note");
    await client.call("boot", { corpusFingerprint, dimensions: 2 });
    const markdown = Array.from({ length: 2_001 }, (_, index) => `# legacy-${index}`).join("\n");
    const revisionDigest = await client.call("hashMarkdown", { corpusFingerprint, markdown });
    const result = await client.call("upsertLexicalRevision", {
      path: "legacy.md",
      markdown,
      expectedRevisionDigest: revisionDigest,
      size: 64,
    });
    expect(result).toMatchObject({ changed: true, state: { lexicalGeneration: 1 } });
    await expect(
      client.call("retrieve", { query: "legacy-2000", limit: 10 })
    ).resolves.toHaveLength(1);
  });

  it("keeps compatibility upsert revision counts aligned with active heads", async () => {
    const identity = {};
    const client = createTestSqliteClient(identity);
    const corpusFingerprint = digest("upsert-count");
    await client.call("boot", { corpusFingerprint, dimensions: 2 });
    const first = "first lexical revision";
    const firstDigest = await client.call("hashMarkdown", {
      corpusFingerprint,
      markdown: first,
    });
    await client.call("upsertLexicalRevision", {
      path: "counted.md",
      markdown: first,
      expectedRevisionDigest: firstDigest,
    });
    const second = "second lexical revision";
    const secondDigest = await client.call("hashMarkdown", {
      corpusFingerprint,
      markdown: second,
    });
    await client.call("upsertLexicalRevision", {
      path: "counted.md",
      markdown: second,
      expectedRevisionDigest: secondDigest,
    });
    await expect(client.call("getState", {})).resolves.toMatchObject({ noteCount: 1 });
    await expect(inspectPersistedLexicalRevisionCount(identity)).resolves.toBe(1);
  });
});
