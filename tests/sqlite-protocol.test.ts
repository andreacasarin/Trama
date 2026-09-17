import { describe, expect, it } from "vitest";
import { SQLITE_PROTOCOL_VERSION, validateRequest, sqliteError } from "@/index/sqlite/protocol";

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
      validateRequest(envelope("hashMarkdown", { markdown: "alpha", corpusFingerprint: hash }))
    ).not.toThrow();
    expect(() => validateRequest(envelope("clearVectors", {}))).not.toThrow();
    expect(() =>
      validateRequest(
        envelope("upsertMarkdown", {
          path: "note.md",
          markdown: "alpha",
          expectedContentId: hash,
          size: 384,
          overlap: 64,
        })
      )
    ).not.toThrow();
    expect(() =>
      validateRequest(
        envelope("upsertMarkdown", {
          path: "note.md",
          markdown: "alpha",
          expectedContentId: hash,
          size: 384,
          overlap: 384,
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
        method: "deleteNote",
        payload: { path: "../secret.md" },
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
});
