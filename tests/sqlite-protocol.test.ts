import { describe, expect, it } from "vitest";
import { SQLITE_PROTOCOL_VERSION, sqliteError } from "@/index/sqlite/protocol";
import { validateRequest } from "@/index/sqlite/request-validation";
import {
  applyTestLexicalRun,
  createTestSqliteClient,
  embedAllTestInputs,
} from "./sqlite-test-client";

const hash = "a".repeat(64);

describe("SQLite protocol", () => {
  it("validates bounded Markdown jobs before they reach the Worker", () => {
    const envelope = (method: string, payload: object) => ({
      v: SQLITE_PROTOCOL_VERSION,
      id: 1,
      method,
      payload,
    });
    expect(() =>
      validateRequest(envelope("boot", { corpusFingerprint: hash, dimensions: 2 }))
    ).not.toThrow();
    expect(() =>
      validateRequest(
        envelope("boot", { corpusFingerprint: hash, dimensions: 2, identity: "c".repeat(64) })
      )
    ).not.toThrow();
    for (const identity of [null, {}, "not-a-hash"])
      expect(() =>
        validateRequest(envelope("boot", { corpusFingerprint: hash, dimensions: 2, identity }))
      ).toThrow();
    expect(() => validateRequest(envelope("clearSemanticCache", {}))).not.toThrow();
    expect(() =>
      validateRequest(
        envelope("applyLexicalBatch", {
          runId: "lexical-1",
          notes: [{ path: "note.md", markdown: "alpha", size: 384 }],
        })
      )
    ).not.toThrow();
    expect(() =>
      validateRequest(
        envelope("applyLexicalBatch", {
          runId: "lexical-1",
          notes: [{ path: "note.md", markdown: "alpha", size: 2_000_001 }],
        })
      )
    ).toThrow();
  });

  it("rejects unsafe paths and unbounded limits", () => {
    expect(() => validateRequest({ v: 1, id: 1, method: "getState", payload: {} })).toThrow();
    expect(() =>
      validateRequest({
        v: SQLITE_PROTOCOL_VERSION,
        id: 1,
        method: "beginLexicalRun",
        payload: { scope: { deletes: ["../secret.md"], mayClearIncomplete: true } },
      })
    ).toThrow();
    expect(() =>
      validateRequest({
        v: SQLITE_PROTOCOL_VERSION,
        id: 1,
        method: "retrieve",
        payload: { limit: 256 },
      })
    ).not.toThrow();
    expect(() =>
      validateRequest({
        v: SQLITE_PROTOCOL_VERSION,
        id: 1,
        method: "retrieve",
        payload: { limit: 257 },
      })
    ).toThrow();
  });

  it("rejects malformed retrieval options", () => {
    const request = (method: string, payload: object) => ({
      v: SQLITE_PROTOCOL_VERSION,
      id: 1,
      method,
      payload,
    });
    const retrievalOptions = [
      { semanticCandidateLimit: -1 },
      { semanticCandidateLimit: 257 },
      { lexicalCandidateLimit: 1.5 },
      { lexicalProfile: "unknown" },
      { resultShape: "documents" },
    ];
    for (const option of retrievalOptions)
      expect(() => validateRequest(request("retrieve", { limit: 10, ...option }))).toThrow();
  });

  it("uses safe structured errors", () => {
    const error = sqliteError("invalid_request", "Invalid request");
    expect(error.error).toEqual({
      code: "invalid_request",
      message: "Invalid request",
      retryable: false,
    });
  });

  it("boots a fresh Worker boundary and can immediately read status", async () => {
    const client = createTestSqliteClient({ freshStatusBoundary: true });
    await expect(
      client.call("boot", {
        corpusFingerprint: hash,
        embeddingFingerprint: "b".repeat(64),
        dimensions: 2,
      })
    ).resolves.toMatchObject({ schemaVersion: 16, protocolVersion: SQLITE_PROTOCOL_VERSION });
    await expect(client.call("getState", {})).resolves.toMatchObject({
      schemaVersion: 16,
      protocolVersion: SQLITE_PROTOCOL_VERSION,
    });
  });

  it("returns cloneable state after an incompatible second boot", async () => {
    const client = createTestSqliteClient({ secondBootBoundary: true });
    await client.call("boot", { corpusFingerprint: hash, dimensions: 2 });
    await expect(
      client.call("boot", { corpusFingerprint: hash, dimensions: 3 })
    ).resolves.toMatchObject({ schemaVersion: 16, dimensions: 3, noteCount: 0 });
  });

  it("preserves current note/head/cache data on reopen", async () => {
    const client = createTestSqliteClient({ validReopenBoundary: true });
    const corpusFingerprint = hash;
    const embeddingFingerprint = "b".repeat(64);
    await client.call("boot", { corpusFingerprint, embeddingFingerprint, dimensions: 2 });
    const markdown = "sentinel";
    await applyTestLexicalRun(client, [{ path: "sentinel.md", markdown, size: 100 }]);
    await embedAllTestInputs(client, embeddingFingerprint, () => new Float32Array([1, 0]));
    await client.call("boot", { corpusFingerprint, embeddingFingerprint, dimensions: 2 });
    await expect(client.call("getState", {})).resolves.toMatchObject({
      noteCount: 1,
      semanticHeadCount: 1,
    });
  });
});
