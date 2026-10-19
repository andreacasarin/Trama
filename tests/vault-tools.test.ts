import { describe, expect, it, vi } from "vitest";
import { VaultRetrieval } from "@/index/VaultRetrieval";
import { createVaultTools } from "@/tools/VaultTools";

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
    const tools = createVaultTools(vault, retrieval, vi.fn());
    const read = tools.find(({ name }) => name === "read_note")!;
    await read.invoke({ path: "  Source note.md  " });
    expect(readNote).toHaveBeenCalledWith("  Source note.md  ", expect.any(AbortSignal));
    await expect(read.invoke({ path: "note.md", surprise: true })).rejects.toThrow();

    const discover = tools.find(({ name }) => name === "discover_links")!;
    await expect(discover.invoke({ path: "note.md", extra: 1 })).rejects.toThrow();
    expect(vault.discoverLinks).not.toHaveBeenCalled();
  });

  it("carries retrieval status and bounded path provenance in the tool result", async () => {
    const retrieval = new VaultRetrieval(
      async () => ({ hits: [{ path: "result.md", score: 1 }], mode: "lexical", degraded: false }),
      undefined,
      undefined,
      async (path) => ({ path, content: "matching evidence" })
    );
    const observer = vi.fn();
    const tools = createVaultTools(
      {
        readNote: async (path) => ({ path, content: "note" }),
        discoverLinks: async () => [],
        resolveLink: async () => null,
      },
      retrieval,
      observer
    );
    await tools.find(({ name }) => name === "vault_search")!.invoke({ query: "match" });
    expect(observer).toHaveBeenCalledWith(
      "vault_search",
      expect.anything(),
      expect.objectContaining({
        ok: true,
        data: {
          results: [{ path: "result.md", context: "matching evidence" }],
          mode: "lexical",
          degraded: true,
          degradationReason: "semantic-unavailable",
        },
        provenance: [{ path: "result.md" }],
      }),
      expect.any(Number)
    );
  });
});
