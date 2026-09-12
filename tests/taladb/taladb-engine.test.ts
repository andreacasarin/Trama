import { describe, expect, it } from "vitest";
import { TalaDbEngine } from "@/index/taladb/TalaDbEngine";
import { createTalaNamespace } from "@/index/taladb/namespace";

function note(path: string, values: readonly number[], text = path) {
  return {
    path,
    content: text,
    chunks: [{ ordinal: 0, startLine: 1, endLine: 1, text, vector: values }],
  };
}

function nativeFixture() {
  const nearestCalls: number[] = [];
  const textCalls: Array<{ field: string; limit: number }> = [];
  const notes = [{ path: "catalog.md", contentId: "catalog", chunkCount: 1 }];
  const chunks = [
    {
      rowId: "z",
      canonicalId: "z",
      path: "z.md",
      ordinal: 0,
      score: 1,
      embedding: [1, 0],
      body: "body",
      filename: "z.md",
      pathText: "z.md",
    },
    {
      rowId: "a",
      canonicalId: "a",
      path: "a.md",
      ordinal: 0,
      score: 1,
      embedding: [1, 0],
      body: "body",
      filename: "a.md",
      pathText: "a.md",
    },
    {
      rowId: "b",
      canonicalId: "b",
      path: "b.md",
      ordinal: 0,
      score: 0.2,
      embedding: [0, 1],
      body: "body",
      filename: "b.md",
      pathText: "b.md",
    },
  ];
  const collection = (name: string) => {
    if (name === "notes")
      return {
        find: async () => notes,
        findOne: async () => null,
      };
    if (name === "state") return { findOne: async () => null };
    return {
      count: async () => chunks.length,
      findNearest: async (_field: string, _query: number[], limit: number) => {
        nearestCalls.push(limit);
        return chunks
          .slice()
          .sort((left, right) => right.score - left.score)
          .slice(0, limit)
          .map((document) => ({ document, score: document.score }));
      },
      searchText: async (field: string, _query: string, limit: number) => {
        textCalls.push({ field, limit });
        return chunks
          .filter((document) => document[field as "body" | "filename" | "pathText"])
          .slice(0, limit)
          .map((document) => ({ document, score: field === "filename" ? 2 : 1 }));
      },
      find: async () => [],
    };
  };
  return { collection, nearestCalls, textCalls };
}

describe("TalaDbEngine", () => {
  it("uses deterministic row ids, exact cosine ordering, and skips deleted hydration rows", async () => {
    const engine = new TalaDbEngine({ dimensions: 2, fingerprint: "fp", backend: "memory" });
    await engine.rebuild([note("b.md", [0, 1]), note("a.md", [1, 0])]);
    const hits = await engine.search([1, 0], 10);
    expect(hits.map((hit) => hit.path)).toEqual(["a.md", "b.md"]);
    const [chunk] = await engine.hydrate([hits[0].rowId]);
    expect(chunk?.text).toBe("a.md");
    await engine.delete("a.md");
    expect(await engine.hydrate([hits[0].rowId])).toEqual([]);
  });

  it("keeps an unchanged reconcile idempotent and marks cancelled writes dirty", async () => {
    const engine = new TalaDbEngine({ dimensions: 2, backend: "memory" });
    const first = note("a.md", [1, 0]);
    const ready = await engine.rebuild([first]);
    expect(await engine.reconcile(first)).toEqual(ready);
    const controller = new AbortController();
    controller.abort();
    await expect(
      engine.reconcile(note("b.md", [0, 1]), undefined, controller.signal)
    ).rejects.toThrow("cancelled");
    expect(engine.state().status).toBe("dirty");
    expect(engine.state().syncNeeded).toBe(true);
  });

  it("searches independent lexical body, filename, and path channels", async () => {
    const engine = new TalaDbEngine({ dimensions: 2, backend: "memory" });
    await engine.rebuild([
      note("Folder/Report.md", [1, 0], "Reset PASSWORD"),
      note("Other.md", [0, 1], "unrelated"),
    ]);
    expect((await engine.lexicalSearch("password"))[0].path).toBe("Folder/Report.md");
    expect((await engine.lexicalSearch("report"))[0].path).toBe("Folder/Report.md");
    expect((await engine.lexicalSearch("folder"))[0].path).toBe("Folder/Report.md");
  });

  it("creates random opaque identities and isolates their stores", async () => {
    const firstNamespace = createTalaNamespace();
    const secondNamespace = createTalaNamespace();
    expect(firstNamespace.root).not.toBe(secondNamespace.root);
    expect(firstNamespace.database).not.toContain("/");
    expect(secondNamespace.database).not.toContain("/");

    const first = new TalaDbEngine({
      dimensions: 2,
      backend: "memory",
      namespace: firstNamespace,
    });
    const second = new TalaDbEngine({
      dimensions: 2,
      backend: "memory",
      namespace: secondNamespace,
    });
    await first.rebuild([note("first.md", [1, 0])]);
    await second.rebuild([note("second.md", [1, 0])]);
    expect((await first.search([1, 0])).map((hit) => hit.path)).toEqual(["first.md"]);
    expect((await second.search([1, 0])).map((hit) => hit.path)).toEqual(["second.md"]);
  });

  it("expands native semantic ties before applying the deterministic comparator", async () => {
    const fixture = nativeFixture();
    const engine = new TalaDbEngine({ dimensions: 2, backend: "native" });
    (engine as any).nativeDb = { collection: fixture.collection };
    (engine as any).nativeInitialized = true;
    expect((await engine.search([1, 0], 1)).map((hit) => hit.path)).toEqual(["a.md"]);
    expect(fixture.nearestCalls).toEqual([2, 3]);
  });

  it("retrieves full native channel candidates before weighted lexical ranking", async () => {
    const fixture = nativeFixture();
    const engine = new TalaDbEngine({ dimensions: 2, backend: "native" });
    (engine as any).nativeDb = { collection: fixture.collection };
    (engine as any).nativeInitialized = true;
    await engine.lexicalSearch("body", 1);
    expect(fixture.textCalls).toEqual([
      { field: "body", limit: 3 },
      { field: "filename", limit: 3 },
      { field: "pathText", limit: 3 },
    ]);
  });

  it("loads only the native note catalog and hydrates chunks on demand", async () => {
    const requestedPaths: string[] = [];
    const chunks = {
      find: async (filter?: { path?: string }) => {
        if (filter?.path) requestedPaths.push(filter.path);
        return filter?.path
          ? [
              {
                rowId: "row",
                canonicalId: "row",
                path: filter.path,
                ordinal: 0,
                body: "hydrated",
                embedding: [1, 0],
              },
            ]
          : [];
      },
    };
    const engine = new TalaDbEngine({ dimensions: 2, backend: "native" });
    (engine as any).nativeDb = {
      collection: (name: string) =>
        name === "notes"
          ? { find: async () => [{ path: "large.md", contentId: "id", chunkCount: 1 }] }
          : name === "state"
            ? { findOne: async () => null }
            : chunks,
    };
    (engine as any).nativeInitialized = true;
    await engine.open();
    expect((engine as any).chunksByRow.size).toBe(0);
    expect(engine.noteCatalog()).toEqual([{ path: "large.md", contentId: "id", chunkCount: 1 }]);
    expect(await engine.noteChunks("large.md")).toHaveLength(1);
    expect(requestedPaths).toEqual(["large.md"]);
  });
});
