import { describe, expect, it } from "vitest";
import { SQLITE_PROTOCOL_VERSION, validateRequest, sqliteError } from "@/index/sqlite/protocol";

const hash = "a".repeat(64);

describe("SQLite protocol", () => {
  it("accepts bounded requests", () => {
    const vector = new Float32Array([1, 0]);
    const request = {
      v: SQLITE_PROTOCOL_VERSION,
      id: 1,
      method: "upsertNote" as const,
      payload: {
        note: {
          path: "notes/a.md",
          contentId: hash,
          chunks: [
            { id: `${hash}:0`, ordinal: 0, startLine: 1, endLine: 1, text: "hello", vector },
          ],
        },
      },
    };
    expect(() => validateRequest(request)).not.toThrow();
  });

  it("rejects unsafe paths, duplicate chunk identities, and unbounded limits", () => {
    expect(() => validateRequest({ v: 1, id: 1, method: "getState", payload: {} })).toThrow();
    expect(() =>
      validateRequest({
        v: SQLITE_PROTOCOL_VERSION,
        id: 1,
        method: "deleteNote",
        payload: { path: "../secret.md" },
      })
    ).toThrow();
    const note = {
      path: "a.md",
      contentId: hash,
      chunks: [
        {
          id: `${hash}:0`,
          ordinal: 0,
          startLine: 1,
          endLine: 1,
          text: "a",
          vector: new Float32Array([1]),
        },
        {
          id: `${hash}:0`,
          ordinal: 0,
          startLine: 1,
          endLine: 1,
          text: "b",
          vector: new Float32Array([1]),
        },
      ],
    };
    expect(() =>
      validateRequest({
        v: SQLITE_PROTOCOL_VERSION,
        id: 1,
        method: "upsertNote",
        payload: { note },
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
