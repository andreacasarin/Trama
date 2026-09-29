import { describe, expect, it } from "vitest";
import {
  applyTestLexicalRun,
  createTestSqliteClient,
  inspectPersistedOccurrences,
} from "./sqlite-test-client";

const digest = (_value: string) => "a".repeat(64);

describe("revision reconciliation", () => {
  it("keeps lexical and semantic heads independent", async () => {
    const client = createTestSqliteClient();
    await client.call("boot", {
      corpusFingerprint: digest("corpus"),
      embeddingFingerprint: digest("embedding"),
      dimensions: 2,
    });
    const markdown = "# Heading\nalpha";
    await applyTestLexicalRun(client, [{ path: "note.md", markdown, size: 384 }]);
    const state = await client.call("getState", {});
    expect(state.semanticHeadCount).toBe(0);
    expect(state.semanticEligibleCount).toBe(1);
  });

  it("accepts skipped Markdown heading levels through the Worker lexical path", async () => {
    const identity = {};
    const client = createTestSqliteClient(identity);
    const corpusFingerprint = digest("corpus");
    await client.call("boot", {
      corpusFingerprint,
      embeddingFingerprint: digest("embedding"),
      dimensions: 2,
    });
    const markdown = "# Parent\n\n### First\n\n### Second\n\nbody";
    await expect(
      applyTestLexicalRun(client, [{ path: "skipped.md", markdown, size: 384 }])
    ).resolves.toMatchObject({ applied: { changed: true } });
    await expect(client.call("getState", {})).resolves.toMatchObject({ noteCount: 1 });
    await expect(inspectPersistedOccurrences(identity)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          headingContext: JSON.stringify(["Parent", "Second"]),
          embeddingInput: JSON.stringify({
            v: 1,
            heading: ["Parent", "Second"],
            body: "body",
          }),
        }),
      ])
    );
  });
});
