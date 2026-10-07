import { describe, expect, it } from "vitest";
import {
  applyTestLexicalRun,
  createTestSqliteClient,
  embedAllTestInputs,
} from "./sqlite-test-client";

const digest = (_value: string) => "a".repeat(64);

async function semanticCorpus(
  notes: readonly { path: string; markdown: string; vector: readonly number[] }[]
) {
  const client = createTestSqliteClient();
  const corpusFingerprint = digest("semantic-retrieval");
  const embeddingFingerprint = digest("semantic-model");
  await client.call("boot", { corpusFingerprint, embeddingFingerprint, dimensions: 2 });
  await applyTestLexicalRun(
    client,
    notes.map(({ path, markdown }) => ({ path, markdown }))
  );
  await embedAllTestInputs(client, embeddingFingerprint, (request) => {
    const body = (JSON.parse(request.serialization) as { body: string }).body;
    const note = notes.find((candidate) => candidate.markdown === body);
    if (!note) throw new Error(`Missing test vector for ${body}`);
    return new Float32Array(note.vector);
  });
  return client;
}

async function passageCorpus(
  notes: readonly {
    path: string;
    passages: readonly { text: string; vector: readonly number[] }[];
  }[]
) {
  const client = createTestSqliteClient();
  const corpusFingerprint = digest("related-passage-corpus");
  const embeddingFingerprint = digest("related-passage-model");
  await client.call("boot", { corpusFingerprint, embeddingFingerprint, dimensions: 3 });
  const markdownNotes = notes.map(({ path, passages }) => ({
    path,
    markdown: passages.map(({ text }) => text).join("\n\n"),
  }));
  for (let offset = 0; offset < markdownNotes.length; offset += 8)
    await applyTestLexicalRun(client, markdownNotes.slice(offset, offset + 8));
  const vectors = new Map(
    notes.flatMap(({ passages }) => passages.map(({ text, vector }) => [text, vector]))
  );
  await embedAllTestInputs(client, embeddingFingerprint, (request) => {
    const { body } = JSON.parse(request.serialization) as { body: string };
    const vector = vectors.get(body);
    if (!vector) throw new Error(`Missing test vector for ${body}`);
    return new Float32Array(vector);
  });
  return client;
}

describe("revision retrieval", () => {
  it.each([
    "# Zebracobalt\n\nOrdinary prose",
    "Zebracobalt\n============\n\nOrdinary prose",
    "## Zebracobalt\n\nOrdinary prose",
  ])("includes heading content in Voce lexical retrieval: %s", async (markdown) => {
    const client = createTestSqliteClient();
    await client.call("boot", { corpusFingerprint: digest("headings"), dimensions: 2 });
    await applyTestLexicalRun(client, [
      { path: "content.md", markdown },
      { path: "Zebracobalt.md", markdown: "Unrelated prose" },
    ]);
    const hits = await client.call("retrieve", {
      query: "Zebracobalt",
      limit: 5,
      lexicalProfile: "voce",
    });
    expect(hits.map((hit: { path: string }) => hit.path)).toEqual(["content.md"]);
    expect(hits[0].text).toContain("Zebracobalt");
  });

  it("retrieves lexical occurrences from the active head", async () => {
    const client = createTestSqliteClient();
    const corpusFingerprint = digest("corpus-retrieval");
    await client.call("boot", { corpusFingerprint, dimensions: 2 });
    const markdown = "# Heading\nneedle alpha";
    await applyTestLexicalRun(client, [{ path: "note.md", markdown, size: 384 }]);
    const hits = await client.call("retrieve", { query: "needle", limit: 5 });
    expect(hits[0]?.path).toBe("note.md");
    expect(hits[0]?.text).toContain("needle");
  });

  it("keeps full-note lexical search available when heading context exceeds the embedding bound", async () => {
    const client = createTestSqliteClient();
    const embeddingFingerprint = digest("long-heading-profile");
    await client.call("boot", {
      corpusFingerprint: digest("long-heading-corpus"),
      embeddingFingerprint,
      dimensions: 2,
    });
    const markdown = `# ${"Oversized heading ".repeat(40)}\n\nneedle stays searchable`;
    await applyTestLexicalRun(client, [{ path: "long-heading.md", markdown, size: 384 }]);
    const hits = await client.call("retrieve", { query: "needle", limit: 5 });
    expect(hits[0]).toMatchObject({ path: "long-heading.md", text: "needle stays searchable" });
    const headingHits = await client.call("retrieve", {
      query: "Oversized",
      limit: 5,
      resultShape: "notes",
    });
    expect(headingHits[0]).toMatchObject({ path: "long-heading.md", ordinal: 0, startLine: 1 });
    expect(headingHits[0].text).toContain("Oversized");
    const work = await client.call("prepareSemanticWork", {
      embeddingFingerprint,
      preprocessing: "normalized-float32-v1",
      limit: 100,
      maxInputBytes: 4 * 1024 * 1024,
    });
    expect(
      work.requests.every(
        (request: { serialization: string }) => request.serialization.length <= 384
      )
    ).toBe(true);
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

  it("keeps the best semantic chunk per note before applying the candidate cap", async () => {
    const client = createTestSqliteClient();
    const corpusFingerprint = digest("semantic-note-candidates");
    const embeddingFingerprint = digest("semantic-note-model");
    await client.call("boot", { corpusFingerprint, embeddingFingerprint, dimensions: 2 });
    await applyTestLexicalRun(client, [
      { path: "same.md", markdown: "weak\n\nstrong\n\nstrong\n\nstrong" },
      { path: "other.md", markdown: "middle" },
    ]);
    const vectors: Record<string, readonly number[]> = {
      weak: [0, 1],
      strong: [1, 0],
      middle: [0.8, 0.6],
    };
    await embedAllTestInputs(client, embeddingFingerprint, (request) => {
      const { body } = JSON.parse(request.serialization) as { body: string };
      return new Float32Array(vectors[body]);
    });

    const hits = await client.call("retrieve", {
      vector: new Float32Array([1, 0]),
      limit: 1,
      semanticCandidateLimit: 1,
      resultShape: "notes",
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ path: "same.md", ordinal: 1, text: "strong" });

    const chunkShape = await client.call("retrieve", {
      vector: new Float32Array([1, 0]),
      limit: 2,
      semanticCandidateLimit: 2,
      resultShape: "chunks",
    });
    expect(chunkShape.map((hit: { path: string }) => hit.path)).toEqual(["same.md", "other.md"]);
    expect(chunkShape[0]).toMatchObject({ ordinal: 1, text: "strong" });

    const excludingBestNote = await client.call("retrieve", {
      vector: new Float32Array([1, 0]),
      limit: 1,
      semanticCandidateLimit: 1,
      currentPath: "same.md",
      resultShape: "notes",
    });
    expect(excludingBestNote.map((hit: { path: string }) => hit.path)).toEqual(["other.md"]);
  });

  it("applies lexical note deduplication and current-path exclusion before the cap", async () => {
    const client = createTestSqliteClient();
    await client.call("boot", {
      corpusFingerprint: digest("lexical-note-candidates"),
      dimensions: 2,
    });
    await applyTestLexicalRun(client, [
      { path: "a.md", markdown: "alpha\n\nalpha" },
      { path: "b.md", markdown: "alpha" },
    ]);

    const hits = await client.call("retrieve", {
      query: "alpha",
      limit: 1,
      lexicalCandidateLimit: 1,
      resultShape: "notes",
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ path: "a.md", ordinal: 0, text: "alpha" });

    const excludingFirstPath = await client.call("retrieve", {
      query: "alpha",
      limit: 1,
      lexicalCandidateLimit: 1,
      currentPath: "a.md",
      resultShape: "notes",
    });
    expect(excludingFirstPath.map((hit: { path: string }) => hit.path)).toEqual(["b.md"]);
  });

  it("uses the best matching passage as evidence for a full-note lexical hit", async () => {
    const client = createTestSqliteClient();
    await client.call("boot", {
      corpusFingerprint: digest("lexical-note-passage-evidence"),
      dimensions: 2,
    });
    await applyTestLexicalRun(client, [
      {
        path: "evidence.md",
        markdown: "Unrelated opening.\n\nCafé noise.\n\nneedle TARGET café together.",
      },
    ]);

    const hits = await client.call("retrieve", {
      query: "NEEDLE target cafe",
      limit: 1,
      resultShape: "notes",
    });
    const repeated = await client.call("retrieve", {
      query: "NEEDLE target cafe",
      limit: 1,
      resultShape: "notes",
    });
    const chunkShape = await client.call("retrieve", {
      query: "NEEDLE target cafe",
      limit: 1,
      resultShape: "chunks",
    });

    expect(hits[0]).toMatchObject({ path: "evidence.md", ordinal: 2, startLine: 5, endLine: 5 });
    expect(hits[0].text).toContain("needle TARGET café together");
    expect(repeated[0]).toMatchObject({ ordinal: 2, text: hits[0].text });
    expect(chunkShape[0]).toMatchObject({ path: "evidence.md", ordinal: 2, startLine: 5 });
  });

  it("uses the first passage when only the title or path matched", async () => {
    const client = createTestSqliteClient();
    await client.call("boot", {
      corpusFingerprint: digest("title-path-passage-fallback"),
      dimensions: 2,
    });
    await applyTestLexicalRun(client, [
      { path: "needle-topic.md", markdown: "Opening body.\n\nLater body." },
    ]);
    const hits = await client.call("retrieve", {
      query: "needle",
      limit: 1,
      resultShape: "notes",
    });
    expect(hits[0]).toMatchObject({
      path: "needle-topic.md",
      ordinal: 0,
      text: "Opening body.",
      startLine: 1,
    });
  });

  it("searches filename metadata for a note with no semantic occurrences", async () => {
    const client = createTestSqliteClient();
    await client.call("boot", {
      corpusFingerprint: digest("empty-note-fullnote-search"),
      dimensions: 2,
    });
    await applyTestLexicalRun(client, [{ path: "empty-title.md", markdown: "" }]);
    const hits = await client.call("retrieve", {
      query: "empty-title",
      limit: 1,
      resultShape: "notes",
    });
    expect(hits[0]).toMatchObject({
      path: "empty-title.md",
      ordinal: 0,
      text: "",
      startLine: 1,
      endLine: 1,
    });
  });

  it("orders tied lexical candidates in SQLite before applying the cap", async () => {
    const client = createTestSqliteClient();
    await client.call("boot", {
      corpusFingerprint: digest("lexical-tied-candidates"),
      dimensions: 2,
    });
    await applyTestLexicalRun(client, [
      { path: "z.md", markdown: "alpha" },
      { path: "a.md", markdown: "alpha" },
    ]);

    const hits = await client.call("retrieve", {
      query: "alpha",
      limit: 1,
      lexicalCandidateLimit: 1,
    });
    expect(hits.map((hit: { path: string }) => hit.path)).toEqual(["a.md"]);
  });

  it("keeps JavaScript UTF-16 tie ordering at the lexical chunk and note cutoff", async () => {
    const client = createTestSqliteClient();
    await client.call("boot", {
      corpusFingerprint: digest("lexical-unicode-tied-candidates"),
      dimensions: 2,
    });
    await applyTestLexicalRun(client, [
      { path: "\uE000.md", markdown: "alpha" },
      { path: "😀.md", markdown: "alpha" },
    ]);

    const chunks = await client.call("retrieve", {
      query: "alpha",
      limit: 1,
      lexicalCandidateLimit: 1,
    });
    expect(chunks.map((hit: { path: string }) => hit.path)).toEqual(["😀.md"]);

    const notes = await client.call("retrieve", {
      query: "alpha",
      limit: 1,
      lexicalCandidateLimit: 1,
      resultShape: "notes",
    });
    expect(notes.map((hit: { path: string }) => hit.path)).toEqual(["😀.md"]);

    const excludingUtf16First = await client.call("retrieve", {
      query: "alpha",
      limit: 1,
      lexicalCandidateLimit: 1,
      currentPath: "😀.md",
      resultShape: "notes",
    });
    expect(excludingUtf16First.map((hit: { path: string }) => hit.path)).toEqual(["\uE000.md"]);
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

  it("uses the last complete semantic heads and isolates related search by active profile", async () => {
    const client = await semanticCorpus([
      { path: "source.md", markdown: "source old", vector: [1, 0] },
      { path: "related.md", markdown: "related stable", vector: [0.8, 0.6] },
    ]);
    const before = await client.call("findRelated", { path: "source.md", limit: 5 });
    await applyTestLexicalRun(client, [{ path: "source.md", markdown: "source edited" }]);
    const withStaleSemanticHead = await client.call("findRelated", { path: "source.md", limit: 5 });
    expect(withStaleSemanticHead.map((hit: { path: string }) => hit.path)).toEqual(
      before.map((hit: { path: string }) => hit.path)
    );
    expect(withStaleSemanticHead[0]?.path).toBe("related.md");

    await client.call("boot", {
      corpusFingerprint: digest("semantic-retrieval"),
      embeddingFingerprint: "b".repeat(64),
      dimensions: 2,
    });
    await expect(client.call("findRelated", { path: "source.md", limit: 5 })).resolves.toEqual([]);
  });

  it("scores every distinct passage symmetrically and returns the strongest target evidence", async () => {
    const client = await passageCorpus([
      {
        path: "source.md",
        passages: [
          { text: "source a", vector: [0.6, 0, 0.8] },
          { text: "source b", vector: [0, 1, 0] },
          { text: "source c", vector: [0, 0, 1] },
          { text: "source d", vector: [0.8, 0.6, 0] },
        ],
      },
      {
        path: "target.md",
        passages: [{ text: "target best", vector: [1, 0, 0] }],
      },
    ]);
    const hits = await client.call("findRelated", { path: "source.md", limit: 5 });
    const target = hits.find((hit: { path: string }) => hit.path === "target.md");
    expect(target).toMatchObject({ ordinal: 0, text: "target best", startLine: 1, endLine: 1 });
    // The fourth source passage contributes despite the three-probe candidate search.
    // Source top-two mean is 0.7; target's single best match is 0.8; symmetric mean is 0.75.
    expect(target?.score).toBeCloseTo(0.75);
  });

  it("deduplicates identical passage inputs before related-note top-two scoring", async () => {
    const client = await passageCorpus([
      {
        path: "source.md",
        passages: [
          { text: "same source", vector: [1, 0, 0] },
          { text: "same source", vector: [1, 0, 0] },
          { text: "other source", vector: [0, 1, 0] },
        ],
      },
      {
        path: "target.md",
        passages: [
          { text: "same target", vector: [1, 0, 0] },
          { text: "same target", vector: [1, 0, 0] },
          { text: "orthogonal target", vector: [0, 0, 1] },
        ],
      },
    ]);
    const hits = await client.call("findRelated", { path: "source.md", limit: 5 });
    const target = hits.find((hit: { path: string }) => hit.path === "target.md");
    // Repeated exact input counts once per note: source=[1,0], target=[1,0].
    expect(target?.score).toBeCloseTo(0.5);
    expect(target?.ordinal).toBe(0);
  });

  it("averages asymmetric source and target passage counts in both directions", async () => {
    const sourceTwo = await passageCorpus([
      {
        path: "source.md",
        passages: [
          { text: "source aligned", vector: [1, 0, 0] },
          { text: "source orthogonal", vector: [0, 1, 0] },
        ],
      },
      { path: "target.md", passages: [{ text: "target only", vector: [1, 0, 0] }] },
    ]);
    const sourceTwoHits = await sourceTwo.call("findRelated", { path: "source.md", limit: 1 });
    expect(sourceTwoHits[0]?.score).toBeCloseTo(0.75);

    const targetMany = await passageCorpus([
      { path: "source.md", passages: [{ text: "source only", vector: [1, 0, 0] }] },
      {
        path: "target.md",
        passages: [
          { text: "target aligned", vector: [1, 0, 0] },
          { text: "target orthogonal", vector: [0, 1, 0] },
        ],
      },
    ]);
    const targetManyHits = await targetMany.call("findRelated", { path: "source.md", limit: 1 });
    expect(targetManyHits[0]?.score).toBeCloseTo(0.75);
  });

  it("excludes the source before each 32-note probe cap and honors the result limit", async () => {
    const targets = Array.from({ length: 34 }, (_, index) => ({
      path: `target-${String(index).padStart(2, "0")}.md`,
      passages: [{ text: `target body ${index}`, vector: [1, 0, 0] as const }],
    }));
    const client = await passageCorpus([
      { path: "source.md", passages: [{ text: "source body", vector: [1, 0, 0] }] },
      ...targets,
    ]);
    const capped = await client.call("findRelated", { path: "source.md", limit: 40 });
    expect(capped).toHaveLength(32);
    expect(capped.map((hit: { path: string }) => hit.path)).toEqual(
      targets.slice(0, 32).map(({ path }) => path)
    );
    expect(capped.every((hit: { path: string }) => hit.path !== "source.md")).toBe(true);
    const limited = await client.call("findRelated", { path: "source.md", limit: 3 });
    expect(limited.map((hit: { path: string }) => hit.path)).toEqual(
      targets.slice(0, 3).map(({ path }) => path)
    );
  });
});
