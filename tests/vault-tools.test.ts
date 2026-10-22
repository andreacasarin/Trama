import { describe, expect, it, vi } from "vitest";
import { isToolMessage } from "@langchain/core/messages";
import { StructuredError } from "@/domain/errors";
import { VaultRetrieval } from "@/index/VaultRetrieval";
import { createVaultTools, type VaultToolOutcome } from "@/tools/VaultTools";

async function invokeOutcome(tool: any, args: Record<string, unknown>): Promise<VaultToolOutcome> {
  const result = await tool.invoke({
    type: "tool_call",
    id: "test-tool-call",
    name: tool.name,
    args,
  });
  expect(isToolMessage(result)).toBe(true);
  return result.artifact as VaultToolOutcome;
}

describe("native read-only vault tools", () => {
  it("uses strict native schemas and forwards exact paths to the actual vault operation", async () => {
    const readNote = vi.fn(async (path: string) => ({
      path,
      content: "current note",
      startLine: 1,
      endLine: 3,
    }));
    const vault = {
      readNote,
      discoverLinks: vi.fn(async () => []),
      resolveLink: vi.fn(async () => null),
    };
    const retrieval = new VaultRetrieval(
      async () => ({ hits: [], mode: "lexical", degraded: true }),
      undefined,
      undefined,
      async () => null
    );
    const tools = createVaultTools(vault, retrieval);
    const read = tools.find(({ name }) => name === "read_note")!;
    const follow = tools.find(({ name }) => name === "follow_link")!;
    expect(read.description).toContain("exact vault-relative .md path");
    expect(read.description).toContain("follow_link");
    expect(follow.description).toContain("complete [[wikilink]]");
    expect(follow.description).toContain("sourcePath");
    const outcome = await invokeOutcome(read, { path: "  Source note.md  " });
    expect(readNote).toHaveBeenCalledWith("  Source note.md  ", expect.any(AbortSignal));
    expect(outcome).toMatchObject({ ok: true, data: { content: "current note" } });
    await expect(read.invoke({ path: "note.md", surprise: true })).rejects.toThrow();

    const discover = tools.find(({ name }) => name === "discover_links")!;
    await expect(discover.invoke({ path: "note.md", extra: 1 })).rejects.toThrow();
    expect(vault.discoverLinks).not.toHaveBeenCalled();
  });

  it("reads bare and wrapped note names globally while keeping exact paths direct", async () => {
    const readNote = vi.fn(async (path: string) => ({ path, content: `Body: ${path}` }));
    const resolveLink = vi.fn(async (link: string) =>
      link.includes("Principles") ? "Journal/Principles to live by.md" : null
    );
    const retrieval = new VaultRetrieval(
      async () => ({ hits: [], mode: "lexical", degraded: false }),
      undefined,
      undefined,
      async () => null
    );
    const tools = createVaultTools(
      { readNote, resolveLink, discoverLinks: async () => [] },
      retrieval
    );
    const read = tools.find(({ name }) => name === "read_note")!;

    const success = await invokeOutcome(read, { path: "Principles to live by" });
    expect(resolveLink).toHaveBeenCalledWith(
      "Principles to live by",
      null,
      expect.any(AbortSignal)
    );
    expect(readNote).toHaveBeenLastCalledWith(
      "Journal/Principles to live by.md",
      expect.any(AbortSignal)
    );
    expect(success).toMatchObject({
      ok: true,
      data: { content: "Body: Journal/Principles to live by.md" },
      provenance: [{ path: "Journal/Principles to live by.md" }],
    });

    await read.invoke({ path: "[[Principles to live by#Values|Principles]]" });
    expect(resolveLink).toHaveBeenLastCalledWith(
      "[[Principles to live by#Values|Principles]]",
      null,
      expect.any(AbortSignal)
    );
    expect(readNote).toHaveBeenLastCalledWith(
      "Journal/Principles to live by.md",
      expect.any(AbortSignal)
    );

    await read.invoke({ path: "Root.md" });
    expect(readNote).toHaveBeenLastCalledWith("Root.md", expect.any(AbortSignal));
    expect(resolveLink).toHaveBeenCalledTimes(2);

    const missing = await invokeOutcome(read, { path: "Unavailable title" });
    expect(missing).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("No visible note matches 'Unavailable title'") },
      provenance: [],
    });
  });

  it("carries retrieval status and bounded path provenance in the tool result", async () => {
    const retrieval = new VaultRetrieval(
      async () => ({ hits: [{ path: "result.md", score: 1 }], mode: "lexical", degraded: false }),
      undefined,
      undefined,
      async (path) => ({ path, content: "matching evidence" })
    );
    const tools = createVaultTools(
      {
        readNote: async (path) => ({ path, content: "note" }),
        discoverLinks: async () => [],
        resolveLink: async () => null,
      },
      retrieval
    );
    const outcome = await invokeOutcome(
      tools.find(({ name }) => name === "vault_search")!,
      { query: "match" }
    );
    expect(outcome).toMatchObject({
      ok: true,
      data: {
        results: [{ path: "result.md", context: "matching evidence" }],
        mode: "lexical",
        degraded: true,
        degradationReason: "semantic-unavailable",
      },
      provenance: [{ path: "result.md" }],
    });
  });

  it("returns readable follow-link evidence and preserves invalid-request errors", async () => {
    const retrieval = new VaultRetrieval(
      async () => ({ hits: [], mode: "lexical", degraded: false }),
      undefined,
      undefined,
      async () => null
    );
    const vault = {
      readNote: vi.fn(async (path: string) => ({
        path,
        content: "bounded target body",
        startLine: 12,
        endLine: 16,
      })),
      discoverLinks: async () => [],
      resolveLink: async () => null,
      resolveLinkDetails: vi.fn(async () => ({ path: "Target.md", startLine: 3, endLine: 3 })),
    };
    const tools = createVaultTools(vault, retrieval);
    const followed = await invokeOutcome(
      tools.find(({ name }) => name === "follow_link")!,
      {
        link: "Target",
        sourcePath: "Source.md",
      }
    );
    expect(followed).toMatchObject({
      ok: true,
      data: {
        path: "Target.md",
        note: { path: "Target.md", content: "bounded target body", startLine: 12, endLine: 16 },
      },
      provenance: [
        { path: "Source.md", startLine: 3, endLine: 3 },
        { path: "Target.md", startLine: 12, endLine: 16 },
      ],
    });

    vault.resolveLinkDetails.mockRejectedValueOnce(
      new StructuredError("invalid_request", "The link is ambiguous.", false)
    );
    const ambiguous = await invokeOutcome(
      tools.find(({ name }) => name === "follow_link")!,
      {
        link: "Ambiguous",
        sourcePath: "Source.md",
      }
    );
    expect(ambiguous).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  });

  it("returns large tool results and later results without character-budget truncation", async () => {
    const retrieval = new VaultRetrieval(
      async () => ({ hits: [], mode: "lexical", degraded: false }),
      undefined,
      undefined,
      async () => null
    );
    const body = `${"x".repeat(100_000)} END OF NOTE`;
    const tools = createVaultTools(
      {
        readNote: async (path) => ({ path, content: `${body} ${path}` }),
        discoverLinks: async () => [],
        resolveLink: async () => null,
      },
      retrieval
    );
    const read = tools.find(({ name }) => name === "read_note")!;
    const first = await read.invoke({ path: "First.md" });
    const second = await read.invoke({ path: "Second.md" });
    expect(String(first)).toContain("END OF NOTE First.md");
    expect(String(second)).toContain("END OF NOTE Second.md");
  });

  it("keeps discover-link character payloads and search contexts intact within result-count limits", async () => {
    const body = `${"x".repeat(2_000)} END OF SEARCH CONTEXT`;
    const retrieval = new VaultRetrieval(
      async () => ({ hits: [{ path: "result.md", score: 1 }], mode: "lexical", degraded: false }),
      undefined,
      undefined,
      async (path) => ({ path, content: body })
    );
    const links = Array.from({ length: 20 }, (_, index) => ({
      link: `Target-${index}-${"p".repeat(1_000)}`,
      sourcePath: "Source.md",
      targetPath: `Target-${index}.md`,
    }));
    const tools = createVaultTools(
      {
        readNote: async (path) => ({ path, content: "note" }),
        discoverLinks: async () => links,
        resolveLink: async () => null,
      },
      retrieval
    );

    const discovered = await invokeOutcome(
      tools.find(({ name }) => name === "discover_links")!,
      { path: "Source.md" }
    );
    expect(discovered).toMatchObject({ data: { links, truncated: false, resultLimit: 25 } });
    const search = await invokeOutcome(
      tools.find(({ name }) => name === "vault_search")!,
      {
        query: "match",
      }
    );
    expect(search).toMatchObject({
      data: { results: [{ path: "result.md", context: body }] },
    });
  });

  it("accepts positive requested link and search counts while retaining defaults", async () => {
    const links = Array.from({ length: 130 }, (_, index) => ({
      link: `Target-${index}`,
      sourcePath: "Source.md",
      targetPath: `Target-${index}.md`,
    }));
    const discoverLinks = vi.fn(async (_path: string, _signal: AbortSignal, limit: number) =>
      links.slice(0, limit)
    );
    const call = vi.fn(async () => ({
      mode: "lexical" as const,
      degraded: false,
      hits: Array.from({ length: 130 }, (_, index) => ({
        path: `Result-${index}.md`,
        score: 1,
      })),
    }));
    const retrieval = new VaultRetrieval(call as any, undefined, undefined, async (path) => ({
      path,
      content: "result",
    }));
    const tools = createVaultTools(
      {
        readNote: async (path) => ({ path, content: "note" }),
        discoverLinks,
        resolveLink: async () => null,
      },
      retrieval
    );
    const discover = tools.find(({ name }) => name === "discover_links")!;
    const search = tools.find(({ name }) => name === "vault_search")!;

    const discovered = await invokeOutcome(discover, { path: "Source.md", limit: 120 });
    expect(discoverLinks).toHaveBeenLastCalledWith("Source.md", expect.any(AbortSignal), 121);
    expect(discovered).toMatchObject({
      data: { links: links.slice(0, 120), truncated: true, resultLimit: 120 },
    });

    discoverLinks.mockImplementationOnce(async (_path, _signal, requested) =>
      links.slice(0, Math.min(requested, 120))
    );
    const exactBoundary = await invokeOutcome(discover, { path: "Source.md", limit: 120 });
    expect(exactBoundary.data).toMatchObject({ links: links.slice(0, 120), truncated: false });

    discoverLinks.mockImplementationOnce(async () => []);
    const empty = await invokeOutcome(discover, { path: "Source.md", limit: 120 });
    expect(empty.data).toMatchObject({ links: [], truncated: false });

    discoverLinks.mockImplementationOnce(async (_path, _signal, requested) =>
      links.slice(0, Math.min(requested, 3))
    );
    const maximum = await invokeOutcome(discover, {
      path: "Source.md",
      limit: Number.MAX_SAFE_INTEGER,
    });
    expect(discoverLinks).toHaveBeenLastCalledWith(
      "Source.md",
      expect.any(AbortSignal),
      Number.MAX_SAFE_INTEGER
    );
    expect(maximum.data).toMatchObject({ links: links.slice(0, 3), truncated: false });
    await expect(discover.invoke({ path: "Source.md", limit: 0 })).rejects.toThrow();
    await expect(discover.invoke({ path: "Source.md", limit: 1.5 })).rejects.toThrow();
    await expect(discover.invoke({ path: "Source.md", surprise: true })).rejects.toThrow();

    const found = await invokeOutcome(search, { query: "query", limit: 125 });
    expect(call).toHaveBeenLastCalledWith(
      "noteStoreHybrid",
      expect.objectContaining({ query: "query", k: 125 }),
      expect.any(AbortSignal)
    );
    expect(found.data).toMatchObject({
      results: expect.arrayContaining([expect.objectContaining({ path: "Result-124.md" })]),
    });
    expect((found.data as any).results).toHaveLength(125);

    const defaultResult = await invokeOutcome(search, { query: "query" });
    expect(call).toHaveBeenLastCalledWith(
      "noteStoreHybrid",
      expect.objectContaining({ query: "query", k: 20 }),
      expect.any(AbortSignal)
    );
    expect((defaultResult.data as any).results).toHaveLength(10);
    await expect(search.invoke({ query: "query", limit: -1 })).rejects.toThrow();
    await expect(search.invoke({ query: "query", limit: 2.5 })).rejects.toThrow();
    await expect(search.invoke({ query: "query", unexpected: true })).rejects.toThrow();
  });
});
