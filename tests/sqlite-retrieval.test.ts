import { describe, expect, it } from "vitest";
import { createTestSqliteClient } from "./sqlite-test-client";

const digest = (_value: string) => "a".repeat(64);

async function semanticCorpus(
  notes: readonly { path: string; markdown: string; vector: readonly number[] }[]
) {
  const client = createTestSqliteClient();
  const corpusFingerprint = digest("semantic-retrieval");
  const embeddingFingerprint = digest("semantic-model");
  await client.call("boot", { corpusFingerprint, embeddingFingerprint, dimensions: 2 });
  for (const note of notes) {
    const revisionDigest = await client.call("hashMarkdown", {
      markdown: note.markdown,
      corpusFingerprint,
    });
    await client.call("upsertLexicalRevision", {
      path: note.path,
      markdown: note.markdown,
      expectedRevisionDigest: revisionDigest,
      size: 100,
    });
  }
  const requests = await client.call("listMissingEmbeddingInputs", {
    embeddingFingerprint,
    limit: 10,
  });
  await client.call("storeEmbeddingResults", {
    embeddingFingerprint,
    results: requests.map((request: { serialization: string }) => {
      const body = (JSON.parse(request.serialization) as { body: string }).body;
      const note = notes.find((candidate) => candidate.markdown === body);
      if (!note) throw new Error(`Missing test vector for ${body}`);
      return { ...request, vector: new Float32Array(note.vector) };
    }),
  });
  return client;
}

describe("revision retrieval", () => {
  it("retrieves lexical occurrences from the active head", async () => {
    const client = createTestSqliteClient();
    const corpusFingerprint = digest("corpus-retrieval");
    await client.call("boot", { corpusFingerprint, dimensions: 2 });
    const markdown = "# Heading\nneedle alpha";
    const revisionDigest = await client.call("hashMarkdown", {
      markdown,
      corpusFingerprint,
    });
    await client.call("upsertLexicalRevision", {
      path: "note.md",
      markdown,
      expectedRevisionDigest: revisionDigest,
      size: 384,
    });
    const hits = await client.call("retrieve", { query: "needle", limit: 5 });
    expect(hits[0]?.path).toBe("note.md");
    expect(hits[0]?.text).toContain("needle");
  });

  it("returns finite semantic scores", async () => {
    const client = await semanticCorpus([
      { path: "one.md", markdown: "one", vector: [1, 0] },
      { path: "two.md", markdown: "two", vector: [0, 1] },
    ]);
    const hits = await client.call("retrieve", {
      vector: new Float32Array([1, 0]),
      limit: 5,
      semanticCandidateLimit: 5,
    });
    expect(hits).toHaveLength(2);
    expect(
      hits.every((hit: { semanticScore?: number }) => Number.isFinite(hit.semanticScore))
    ).toBe(true);
  });

  it("scores orthogonal semantic vectors at zero", async () => {
    const client = await semanticCorpus([
      { path: "horizontal.md", markdown: "horizontal", vector: [1, 0] },
      { path: "vertical.md", markdown: "vertical", vector: [0, 1] },
    ]);
    const hits = await client.call("retrieve", {
      vector: new Float32Array([1, 0]),
      limit: 5,
      semanticCandidateLimit: 5,
    });
    const vertical = hits.find((hit: { path: string }) => hit.path === "vertical.md");
    expect(vertical?.semanticScore).toBeCloseTo(0);
  });

  it("orders tied semantic scores by path", async () => {
    const client = await semanticCorpus([
      { path: "zulu.md", markdown: "zulu", vector: [1, 0] },
      { path: "alpha.md", markdown: "alpha", vector: [1, 0] },
    ]);
    const hits = await client.call("retrieve", {
      vector: new Float32Array([1, 0]),
      limit: 5,
      semanticCandidateLimit: 5,
    });
    expect(hits.map((hit: { path: string }) => hit.path)).toEqual(["alpha.md", "zulu.md"]);
  });

  it("returns valid related-note results from stored vectors", async () => {
    const client = await semanticCorpus([
      { path: "source.md", markdown: "source", vector: [1, 0] },
      { path: "related.md", markdown: "related", vector: [0.8, 0.6] },
      { path: "orthogonal.md", markdown: "orthogonal", vector: [0, 1] },
    ]);
    const hits = await client.call("findRelated", { path: "source.md", limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit: { path: string; score: number }) => hit.path !== "source.md")).toBe(
      true
    );
    expect(hits.every((hit: { score: number }) => Number.isFinite(hit.score))).toBe(true);
    expect(hits[0]?.path).toBe("related.md");
  });
});
