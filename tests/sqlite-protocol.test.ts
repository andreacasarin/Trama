import { describe, expect, it } from "vitest";
import { SQLITE_PROTOCOL_VERSION, validateRequest, sqliteError } from "@/index/sqlite/protocol";
import {
  applyTestLexicalRun,
  createTestSqliteClient,
  embedAllTestInputs,
  malformedSchema7Snapshot,
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
    ).resolves.toMatchObject({ schemaVersion: 8, protocolVersion: SQLITE_PROTOCOL_VERSION });
    await expect(client.call("getState", {})).resolves.toMatchObject({
      schemaVersion: 8,
      protocolVersion: SQLITE_PROTOCOL_VERSION,
    });
  });

  it("returns cloneable state after an incompatible second boot", async () => {
    const client = createTestSqliteClient({ secondBootBoundary: true });
    await client.call("boot", { corpusFingerprint: hash, dimensions: 2 });
    await expect(
      client.call("boot", { corpusFingerprint: hash, dimensions: 3 })
    ).resolves.toMatchObject({ schemaVersion: 8, dimensions: 3, noteCount: 0 });
  });

  for (const defect of ["missing-vector", "wrong-fts", "wrong-index"] as const)
    it(`resets a schema-7 database with ${defect}`, async () => {
      const client = createTestSqliteClient(
        { schemaDefectBoundary: defect },
        { snapshot: await malformedSchema7Snapshot(defect) }
      );
      await expect(
        client.call("boot", {
          corpusFingerprint: hash,
          embeddingFingerprint: "b".repeat(64),
          dimensions: 2,
        })
      ).resolves.toMatchObject({ schemaVersion: 8, noteCount: 0 });
      await expect(client.call("getState", {})).resolves.toMatchObject({ noteCount: 0 });
    });

  it("preserves valid V7 note/head/cache data on reopen", async () => {
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

  it("does not let inspection metadata authorize different adoption bytes", async () => {
    const corpusFingerprint = hash;
    const embeddingFingerprint = "b".repeat(64);
    const prepare = async (identity: object, publicationId: string) => {
      const client = createTestSqliteClient(identity);
      await client.call("boot", { corpusFingerprint, embeddingFingerprint, dimensions: 2 });
      const markdown = "This publication contains enough text to create a valid lexical block.";
      await applyTestLexicalRun(client, [
        { path: `${publicationId}.md`, markdown, size: markdown.length },
      ]);
      return {
        client,
        prepared: (await client.call("preparePublication", { publicationId })) as {
          bytes: ArrayBuffer;
        },
      };
    };
    const sourceA = await prepare({}, "publication-a");
    const sourceB = await prepare({}, "publication-b");
    const inspectionA = await sourceA.client.call("inspectPublication", {
      bytes: sourceA.prepared.bytes,
      corpusFingerprint,
      embeddingFingerprint,
      dimensions: 2,
    });
    const receiver = createTestSqliteClient({ receiver: true });
    await receiver.call("boot", { corpusFingerprint, embeddingFingerprint, dimensions: 2 });
    const before = await receiver.call("getState", {});

    await expect(
      receiver.call("adoptPublication", {
        bytes: sourceB.prepared.bytes,
        expectedPublicationId: "publication-a",
        inspection: inspectionA,
        corpusFingerprint,
        embeddingFingerprint,
        dimensions: 2,
      })
    ).rejects.toMatchObject({ error: { code: "incompatible_state" } });
    expect(await receiver.call("getState", {})).toEqual(before);
  }, 30_000);
});
