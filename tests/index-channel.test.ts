import { describe, expect, it } from "vitest";
import { lexicalIndex, semanticIndex, type IndexChannel } from "@/index/IndexChannel";
import type { SqliteState } from "@/index/sqlite/protocol";

const state: SqliteState = {
  schemaVersion: 5,
  protocolVersion: 4,
  buildIdentity: "build",
  dimensions: 2,
  corpusFingerprint: "corpus",
  embeddingFingerprint: "embedding",
  incomplete: false,
  snapshotLoaded: false,
  changeCounter: 1,
  noteCount: 1,
  chunkCount: 1,
  compatibleVectorCount: 1,
  vectorCount: 1,
  vectorCoverage: "complete",
  semanticReady: true,
};

describe("search index channels", () => {
  it("uses one status contract for lexical and semantic indexes", () => {
    const channels: IndexChannel[] = [lexicalIndex, semanticIndex];
    for (const channel of channels) {
      expect(channel.status(undefined, false, false)).toEqual({
        state: "unavailable",
        activity: "idle",
        searchable: false,
      });
      expect(channel.status(state, true, true)).toEqual({
        state: "ready",
        activity: "updating",
        searchable: true,
      });
    }
  });

  it("keeps lexical search available during incomplete reconciliation", () => {
    expect(lexicalIndex.status({ ...state, incomplete: true }, true, true)).toEqual({
      state: "partial",
      activity: "updating",
      searchable: true,
    });
    expect(lexicalIndex.status({ ...state, noteCount: 0 }, true, false).state).toBe("empty");
  });

  it("searches available semantic vectors while reporting partial coverage", () => {
    expect(semanticIndex.status({ ...state, vectorCount: 0 }, true, false).state).toBe("empty");
    expect(
      semanticIndex.status(
        { ...state, vectorCoverage: "partial", semanticReady: false },
        true,
        false
      )
    ).toMatchObject({ state: "partial", searchable: true });
    expect(semanticIndex.status({ ...state, semanticReady: false }, true, false)).toMatchObject({
      state: "partial",
      searchable: false,
    });
    expect(
      semanticIndex.status(
        { ...state, compatibleVectorCount: 0, vectorCoverage: "none", semanticReady: false },
        true,
        false
      )
    ).toMatchObject({ state: "incompatible", searchable: false });
    expect(
      semanticIndex.status({ ...state, incomplete: true, semanticReady: false }, true, false)
    ).toMatchObject({ state: "partial", searchable: true });
  });
});
