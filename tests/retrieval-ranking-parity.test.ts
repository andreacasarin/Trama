import { expect, it } from "vitest";
import { Document } from "@langchain/core/documents";
import { _HashedDocument } from "@langchain/core/indexing";
import frozenPassages from "./fixtures/retrieval-ranking-passages.json";
import { NoteSqliteDatabase } from "@/index/note-sqlite/database";
import { NoteStoreClient } from "@/index/note-sqlite/client";
import { loadTestSqlite, TestNoteWorker } from "./note-sqlite-test-client";

it("preserves native hybrid and related ranking", async () => {
  const sqlite = await loadTestSqlite();
  const db = new sqlite.oo1.DB(":memory:", "c");
  const database = new NoteSqliteDatabase(db);
  const client = new NoteStoreClient(new TestNoteWorker(database), "a".repeat(64));
  const profile = "ranking-profile";
  try {
    for (const [path, markdown, vector] of [
      ["source.md", "# Source\n\nalpha source", [1, 0]],
      [
        "Folder/alpha.md",
        "---\naliases: [needle alias]\ntags: [needle-tag]\n---\n# Alpha\n\nalpha body\n\n" +
          "Long passage. ".repeat(500),
        [1, 0],
      ],
      ["beta.md", "# needle title\n\nalpha body", [1, 0]],
      ["lexical.md", "# Other\n\nneedle needle", [0, 1]],
    ] as const) {
      const { passages, metadata } = frozenPassages[path];
      if (path === "Folder/alpha.md") expect(passages.length).toBeGreaterThan(1);
      const uid = _HashedDocument.fromDocument(
        new Document({ pageContent: markdown, metadata: { path, embeddingProfile: profile } })
      ).uid;
      await client.call("noteStoreReplace", {
        uid,
        path,
        profile: path === "lexical.md" ? null : profile,
        markdown,
        passages,
        metadata,
        vectors: passages.map(() => vector),
      });
    }
    const hybrid = await client.call("noteStoreHybrid", {
      query: "needle",
      vector: [1, 0],
      profile,
      k: 10,
      evidence: true,
    });
    const lexical = await client.call("noteStoreHybrid", { query: "needle", k: 10 });
    const fallback = await client.call("noteStoreHybrid", {
      query: "needle",
      vector: [1, 0],
      profile: "missing",
      k: 10,
    });
    const related = await client.call("noteStoreRelated", {
      sourcePath: "source.md",
      profile,
      k: 10,
    });
    const unavailable = await client.call("noteStoreRelated", {
      sourcePath: "missing.md",
      profile,
      k: 10,
    });
    const ranking = hybrid as {
      hits: Array<{ evidence?: { startOffset?: number; endOffset?: number } }>;
    };
    const normalizedHybrid = {
      ...(hybrid as object),
      hits: ranking.hits.map(({ evidence, ...hit }) => ({
        ...hit,
        ...(evidence?.startOffset === undefined
          ? {}
          : { evidence: { startOffset: evidence.startOffset, endOffset: evidence.endOffset } }),
      })),
    };
    expect({ hybrid: normalizedHybrid, lexical, fallback, related, unavailable }).toEqual(EXPECTED);
  } finally {
    db.close();
  }
});

const EXPECTED = {
  hybrid: {
    hits: [
      {
        path: "Folder/alpha.md",
        score: 0.032266458495966696,
        lexicalScore: -1.123311976343026e-6,
        semanticScore: 1,
        evidence: {
          startOffset: 51,
          endOffset: 72,
        },
      },
      {
        path: "beta.md",
        score: 0.03225806451612903,
        lexicalScore: -1.6612244897959184e-6,
        semanticScore: 1,
        evidence: {
          startOffset: 0,
          endOffset: 26,
        },
      },
      {
        path: "lexical.md",
        score: 0.01639344262295082,
        lexicalScore: -1.8958575944102477e-6,
      },
      {
        path: "source.md",
        score: 0.015873015873015872,
        semanticScore: 1,
        evidence: {
          startOffset: 0,
          endOffset: 22,
        },
      },
    ],
    mode: "hybrid",
    degraded: false,
  },
  lexical: {
    hits: [
      {
        path: "lexical.md",
        score: 0.01639344262295082,
        lexicalScore: -1.8958575944102477e-6,
      },
      {
        path: "beta.md",
        score: 0.016129032258064516,
        lexicalScore: -1.6612244897959184e-6,
      },
      {
        path: "Folder/alpha.md",
        score: 0.015873015873015872,
        lexicalScore: -1.123311976343026e-6,
      },
    ],
    mode: "lexical",
    degraded: false,
  },
  fallback: {
    hits: [
      {
        path: "lexical.md",
        score: 0.01639344262295082,
        lexicalScore: -1.8958575944102477e-6,
      },
      {
        path: "beta.md",
        score: 0.016129032258064516,
        lexicalScore: -1.6612244897959184e-6,
      },
      {
        path: "Folder/alpha.md",
        score: 0.015873015873015872,
        lexicalScore: -1.123311976343026e-6,
      },
    ],
    mode: "lexical",
    degraded: true,
    degradationReason: "semantic-unavailable",
  },
  related: {
    hits: [
      {
        path: "Folder/alpha.md",
        score: 1,
      },
      {
        path: "beta.md",
        score: 1,
      },
    ],
    available: true,
  },
  unavailable: {
    hits: [],
    available: false,
  },
};
