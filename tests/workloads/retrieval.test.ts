import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IndexManager, type IndexPathMutation } from "@/index/IndexManager";
import { LenteSearch } from "@/index/LenteSearch";
import { RelatedNotes } from "@/index/RelatedNotes";
import { VaultSearchTool } from "@/tools/ToolRegistry";
import { createWorkload } from "../../test-vaults/benchmark/generator";
import { createTestSqliteClient, inspectWorkloadState, snapshotFor } from "../sqlite-test-client";
import { expectedOutputsV1ByProfile } from "./expected-results";

describe("production retrieval against frozen workload results", () => {
  it("preserves content, coverage, and rankings through note mutations and a local restart", async () => {
    const workload = createWorkload("trama-small");
    const expected = expectedOutputsV1ByProfile["trama-small"];
    const contents = new Map(workload.notes.map((note) => [note.path, note.content]));
    const mtimes = new Map(workload.notes.map((note, i) => [note.path, i + 1]));
    const vectors = new Map<string, Float32Array>();
    for (const note of [
      ...workload.notes,
      ...workload.mutations.flatMap((mutation) => (mutation.note ? [mutation.note] : [])),
    ])
      for (const chunk of note.chunks) vectors.set(chunk.embeddingInput, chunk.vector);
    for (const query of workload.queries) vectors.set(query.text, query.vector);
    const batches: string[][] = [];
    const embedding = {
      dimensions: 768,
      async embed(texts: readonly string[]) {
        batches.push([...texts]);
        return texts.map((text) => {
          const vector = vectors.get(text);
          if (!vector) throw new Error("Unexpected embedding input");
          return Array.from(vector);
        });
      },
    };
    const identity = {};
    const makeIndex = () =>
      new IndexManager(
        {
          listMarkdownPaths: async () => [...contents.keys()],
          readMarkdown: async (path) => {
            const content = contents.get(path);
            if (content === undefined) throw new Error(`Missing fixture note: ${path}`);
            return { path, content };
          },
          isMarkdownAvailable: async (path) => contents.has(path),
        },
        embedding,
        "http://benchmark.invalid/v1",
        "fixture",
        {
          sqliteClient: createTestSqliteClient(identity),
        }
      );
    const signal = new AbortController().signal;
    let index = makeIndex();
    const inspect = async (target: typeof expected.initial | typeof expected.final) => {
      const actual = await inspectWorkloadState(await snapshotFor(identity));
      expect({
        noteCount: actual.noteCount,
        occurrenceCount: actual.occurrenceCount,
        perPathOccurrenceCountsSha256: createHash("sha256")
          .update(JSON.stringify(actual.perPathOccurrenceCounts))
          .digest("hex"),
        occurrenceContentSha256: actual.occurrenceContentSha256,
      }).toEqual(target);
      return actual;
    };
    try {
      await index.build(signal);
      await inspect(expected.initial);
      await index.prepareSemantic(signal);
      for (const mutation of workload.mutations) {
        if (mutation.kind === "unchanged") continue;
        let change: IndexPathMutation;
        if (mutation.kind === "delete") {
          contents.delete(mutation.path);
          mtimes.delete(mutation.path);
          change = { type: "delete", path: mutation.path };
        } else if (mutation.kind === "rename") {
          const content = contents.get(mutation.path)!;
          contents.delete(mutation.path);
          mtimes.delete(mutation.path);
          contents.set(mutation.to!, content);
          mtimes.set(mutation.to!, mtimes.size + 1);
          change = { type: "rename", from: mutation.path, to: mutation.to! };
        } else {
          contents.set(mutation.path, mutation.note!.content);
          mtimes.set(mutation.path, (mtimes.get(mutation.path) ?? mtimes.size) + 1);
          change = { type: "upsert", path: mutation.path };
        }
        await index.reconcileChanges([change], signal);
        await index.prepareSemantic(signal);
      }
      await index.dispose();
      index = makeIndex();
      await index.load();
      const before = batches.length;
      await index.prepareSemantic(signal);
      expect(batches).toHaveLength(before);
      const final = await inspect(expected.final);
      expect(final.semanticState).toEqual(expected.semantic);
      const query = workload.queries.find((candidate) => candidate.id === "hostile")!;
      const lente = new LenteSearch(index, { getMtime: (path) => mtimes.get(path) ?? null });
      const identities = (hits: readonly { path: string; ordinal?: number }[]) =>
        hits.map(({ path, ordinal }) => ({
          path,
          ...(ordinal === undefined ? {} : { occurrenceOrdinal: ordinal }),
        }));
      expect(
        identities((await lente.search(query.text, { searchMethod: "keyword" })).results)
      ).toEqual(expected.probes.lexical);
      expect(identities((await lente.search(query.text)).canonicalResults ?? [])).toEqual(
        expected.probes.hybrid
      );
      const related = await new RelatedNotes(index).find(workload.notes[0].path, signal, 7, true);
      expect(related.results.map(({ path }) => ({ path }))).toEqual(expected.probes.filo);
      const voce = await new VaultSearchTool(index).execute({ query: query.text }, signal);
      expect(voce.provenance.map(({ path }) => ({ path }))).toEqual(expected.probes.voce);
    } finally {
      await index.dispose();
    }
  });
});
