import { describe, expect, it } from "vitest";
import { compareCodeUnits } from "@/index/Ordering";
import { oramaDocumentId } from "@/index/Identity";
import {
  createOramaDatabase,
  insertOramaDocuments,
  loadOramaDatabase,
  saveOramaDatabase,
  searchOrama,
  validateOramaDocument,
} from "@/index/orama/OramaDatabase";
import { OramaProjection } from "@/index/orama/OramaProjection";
import {
  createSnapshotEnvelope,
  encodeSnapshot,
  loadAndValidateSnapshot,
  SNAPSHOT_DIMENSIONS,
} from "@/index/orama/SnapshotCodec";
import type { OramaCatalog, OramaDocument, OramaSnapshotEnvelope } from "@/index/orama/OramaTypes";

const FINGERPRINT = "f".repeat(64);

function document(
  path: string,
  ordinal: number,
  embedding: readonly number[],
  contentId = "a".repeat(64),
  body = "tie"
): OramaDocument {
  return {
    id: oramaDocumentId(path, ordinal),
    path,
    contentId,
    chunkId: `${contentId}:${ordinal}`,
    ordinal,
    startLine: 1,
    endLine: 1,
    filename: path.slice(path.lastIndexOf("/") + 1),
    pathText: path,
    body,
    embedding,
  };
}

function catalog(documents: readonly OramaDocument[], dimensions: number): OramaCatalog {
  const notes = new Map<string, { contentId: string; documentIds: string[] }>();
  for (const entry of documents) {
    const note = notes.get(entry.path) ?? { contentId: entry.contentId, documentIds: [] };
    note.documentIds.push(entry.id);
    notes.set(entry.path, note);
  }
  const sorted = [...notes]
    .map(([path, note]) => ({
      path,
      contentId: note.contentId,
      chunkCount: note.documentIds.length,
      documentIds: note.documentIds,
    }))
    .sort((a, b) => compareCodeUnits(a.path, b.path));
  return {
    schema: 1,
    fingerprint: FINGERPRINT,
    dimensions,
    noteCount: sorted.length,
    chunkCount: documents.length,
    notes: sorted,
  };
}

function basisVector(index: number, value = 1): number[] {
  return Array.from({ length: SNAPSHOT_DIMENSIONS }, (_, dimension) =>
    dimension === index ? value : 0
  );
}

async function projection(documents: readonly OramaDocument[], dimensions: number) {
  const db = await createOramaDatabase(dimensions);
  await insertOramaDocuments(db, documents);
  const value = new OramaProjection();
  value.attach(db, catalog(documents, dimensions), FINGERPRINT, dimensions, 1, true, false);
  return value;
}

function replaceSavedEmbedding(
  raw: string,
  documentId: string,
  embedding: readonly number[]
): string {
  const envelope = JSON.parse(raw) as OramaSnapshotEnvelope & {
    payload: { docs: { docs: Record<string, { id: string; embedding: number[] }> } };
  };
  const saved = Object.values(envelope.payload.docs.docs).find(
    (document) => document.id === documentId
  );
  if (!saved) throw new Error("Synthetic saved document is missing");
  saved.embedding = [...embedding];
  return encodeSnapshot(envelope);
}

function replaceSavedVectorIndex(
  raw: string,
  documentId: string,
  embedding: readonly number[]
): string {
  const envelope = JSON.parse(raw) as OramaSnapshotEnvelope & {
    payload: {
      docs: { docs: Record<string, { id: string; embedding: number[] }> };
      index: { vectorIndexes: { embedding: { vectors: Array<[number, number[]]> } } };
    };
  };
  const internalId = Object.entries(envelope.payload.docs.docs).find(
    ([, document]) => document.id === documentId
  )?.[0];
  const saved = envelope.payload.index.vectorIndexes.embedding.vectors.find(
    ([id]) => String(id) === internalId
  );
  if (!saved) throw new Error("Synthetic saved vector index entry is missing");
  saved[1] = [...embedding];
  return encodeSnapshot(envelope);
}

describe("Orama projection retrieval boundaries", () => {
  it("preserves negative and zero vector scores", async () => {
    const value = await projection(
      [
        document("positive.md", 0, [1, 0]),
        document("zero.md", 0, [0, 1]),
        document("negative.md", 0, [-1, 0]),
      ],
      2
    );

    const hits = await value.vectorSearch([1, 0], { limit: 3 });

    expect(hits.map((hit) => [hit.path, hit.score])).toEqual([
      ["positive.md", 1],
      ["zero.md", 0],
      ["negative.md", -1],
    ]);
  });

  it("completes large vector and BM25 tie groups before canonical sorting and restart", async () => {
    const documents = Array.from({ length: 1_105 }, (_, index) => {
      const path = `note-${index.toString().padStart(4, "0")}.md`;
      const contentId = index.toString(16).padStart(64, "0");
      return document(path, 0, [1, 0], contentId);
    }).reverse();
    const value = await projection(documents, 2);

    const vectorHits = await value.vectorSearch([1, 0], { limit: 3 });
    const lexicalHits = await value.lexicalSearch("tie", { limit: 3, candidateLimit: 3 });
    expect(vectorHits.map((hit) => hit.path)).toEqual([
      "note-0000.md",
      "note-0001.md",
      "note-0002.md",
    ]);
    expect(lexicalHits.map((hit) => hit.path)).toEqual([
      "note-0000.md",
      "note-0001.md",
      "note-0002.md",
    ]);

    const saved = saveOramaDatabase(value.db);
    const restartedDb = await loadOramaDatabase(2, saved);
    const restarted = new OramaProjection();
    restarted.attach(restartedDb, catalog(documents, 2), FINGERPRINT, 2, 1, true, false);
    await expect(restarted.vectorSearch([1, 0], { limit: 3 })).resolves.toEqual(vectorHits);
    await expect(restarted.lexicalSearch("tie", { limit: 3, candidateLimit: 3 })).resolves.toEqual(
      lexicalHits
    );
  });

  it("rejects invalid persisted vectors across the full catalog", async () => {
    const documents = [
      document("first.md", 0, basisVector(0)),
      document("second.md", 0, basisVector(1), "b".repeat(64)),
    ];
    const db = await createOramaDatabase(SNAPSHOT_DIMENSIONS);
    await insertOramaDocuments(db, documents);
    const envelope = createSnapshotEnvelope(
      catalog(documents, SNAPSHOT_DIMENSIONS),
      FINGERPRINT,
      SNAPSHOT_DIMENSIONS,
      1,
      "rebuild",
      db
    );
    const raw = encodeSnapshot(envelope);

    await expect(loadAndValidateSnapshot(raw)).resolves.toBeTruthy();
    await expect(
      loadAndValidateSnapshot(replaceSavedEmbedding(raw, documents[1]!.id, basisVector(0, 0)))
    ).rejects.toThrow("Invalid Orama document");
    await expect(
      loadAndValidateSnapshot(replaceSavedEmbedding(raw, documents[1]!.id, basisVector(0, 2)))
    ).rejects.toThrow("Invalid Orama document");

    const float32Normalized = Array.from(new Float32Array([0.6, 0.8]));
    expect(() =>
      validateOramaDocument(document("float32.md", 0, float32Normalized), 2)
    ).not.toThrow();
    // NaN and Infinity cannot be represented by JSON; validate them before serialization.
    expect(() => validateOramaDocument(document("nan.md", 0, [Number.NaN, 0]), 2)).toThrow(
      "Invalid Orama document"
    );
    expect(() =>
      validateOramaDocument(document("infinity.md", 0, [Number.POSITIVE_INFINITY, 0]), 2)
    ).toThrow("Invalid Orama document");
  });

  it("rebuilds clean retrieval when only a later opaque vector index entry is corrupt", async () => {
    const documents = [
      document("first.md", 0, basisVector(0)),
      document("second.md", 0, basisVector(1), "b".repeat(64)),
    ];
    const db = await createOramaDatabase(SNAPSHOT_DIMENSIONS);
    await insertOramaDocuments(db, documents);
    const raw = encodeSnapshot(
      createSnapshotEnvelope(
        catalog(documents, SNAPSHOT_DIMENSIONS),
        FINGERPRINT,
        SNAPSHOT_DIMENSIONS,
        1,
        "rebuild",
        db
      )
    );
    const corrupted = replaceSavedVectorIndex(raw, documents[1]!.id, basisVector(0));
    const loaded = await loadAndValidateSnapshot(corrupted);
    const result = await searchOrama(loaded.db, {
      mode: "vector",
      vector: { value: basisVector(1), property: "embedding" },
      similarity: -1,
      limit: 1,
    });
    expect(result.hits[0]?.id).toBe(documents[1]!.id);
  });
});
