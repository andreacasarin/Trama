import { describe, expect, it, vi } from "vitest";
import { ReadonlyVault } from "@/domain/contracts";
import {
  CurrentNoteTool,
  DiscoverLinksTool,
  FollowLinkTool,
  ReadNoteTool,
  ToolRegistry,
  VaultSearchTool,
} from "@/tools/ToolRegistry";
import { ObsidianReadonlyVault } from "@/vault/readOnly/ObsidianReadonlyVault";

const signal = new AbortController().signal;
const file = (path: string) => ({ path, name: path.split("/").pop(), extension: "md" });

function adapter(
  options: {
    active?: string;
    content?: string;
    links?: string[];
    destination?: string | null;
    markdownFiles?: string[];
    resolveCount?: { value: number };
    linkPositions?: boolean;
  } = {}
) {
  const files = new Map([
    ["Notes/Source.md", file("Notes/Source.md")],
    ["Notes/Target.md", file("Notes/Target.md")],
  ]);
  const vault = {
    configDir: ".obsidian",
    getFileByPath: vi.fn((path: string) => files.get(path) ?? null),
    read: vi.fn(async () => options.content ?? "one\ntwo\nthree"),
    getMarkdownFiles: vi.fn(() =>
      (options.markdownFiles ?? ["Notes/Source.md", "Notes/Target.md"]).map(file)
    ),
  };
  const metadataCache = {
    getFileCache: vi.fn(() => ({
      links: (options.links ?? ["Target"]).map((link, index) => ({
        link,
        ...(options.linkPositions
          ? { position: { start: { line: index }, end: { line: index } } }
          : {}),
      })),
    })),
    getFirstLinkpathDest: vi.fn(() => {
      if (options.resolveCount) options.resolveCount.value += 1;
      return options.destination === undefined
        ? file("Notes/Target.md")
        : options.destination
          ? file(options.destination)
          : null;
    }),
  };
  const workspace = { getActiveFile: vi.fn(() => (options.active ? file(options.active) : null)) };
  return new ObsidianReadonlyVault(vault as never, workspace as never, metadataCache as never, {
    maxLines: 2,
    maxCharacters: 100,
  });
}

describe("read-only vault and tools module", () => {
  describe("ObsidianReadonlyVault", () => {
    describe("readNote()", () => {
      it("rejects absolute, traversal, hidden, config, index, and non-Markdown paths", async () => {
        const vault = adapter();
        for (const path of [
          "/Notes/Source.md",
          "Notes/../Source.md",
          ".obsidian/app.md",
          ".trama/index/x.md",
          ".private/secret.md",
          "notes/.archive/x.md",
          "Notes/file.txt",
        ]) {
          await expect(vault.readNote(path, signal)).rejects.toThrow();
        }
      });
      it("caps lines and reports truncation with provenance bounds", async () => {
        const vault = adapter({ content: "one\ntwo\nthree" });
        await expect(vault.readNote("Notes/Source.md", signal)).resolves.toMatchObject({
          content: "one\ntwo",
          truncated: true,
          startLine: 1,
          endLine: 2,
        });
      });
    });
    describe("currentNotePath()", () => {
      it("returns null when no note is active", async () => {
        await expect(adapter().currentNotePath(signal)).resolves.toBeNull();
      });
    });
    describe("resolveLink()", () => {
      it("uses an exact path deterministically and rejects an ambiguous basename", async () => {
        await expect(
          adapter({ destination: "Notes/Target.md" }).resolveLink(
            "Notes/Target",
            "Notes/Source.md",
            signal
          )
        ).resolves.toBe("Notes/Target.md");
        const error = await adapter({ markdownFiles: ["A/Target.md", "B/Target.md"] })
          .resolveLink("Target", "Notes/Source.md", signal)
          .catch((reason: unknown) => reason);
        expect(error).toMatchObject({ code: "invalid_request", retryable: false });
        expect(String((error as { message?: unknown }).message)).toContain("A/Target.md");
      });
      it("preserves unresolved links", async () => {
        await expect(
          adapter({ destination: null }).resolveLink("Missing", "Notes/Source.md", signal)
        ).resolves.toBeNull();
      });
    });
    describe("discoverLinks()", () => {
      it("returns both resolved and unresolved links", async () => {
        const vault = adapter({ links: ["Target", "Missing"], destination: null });
        await expect(vault.discoverLinks("Notes/Source.md", signal)).resolves.toEqual([
          { link: "Target", sourcePath: "Notes/Source.md", targetPath: null },
          { link: "Missing", sourcePath: "Notes/Source.md", targetPath: null },
        ]);
      });
      it("resolves no more than the requested maximum in source order", async () => {
        const resolveCount = { value: 0 };
        const vault = adapter({
          links: Array.from({ length: 10_000 }, (_, i) => `Target-${i}`),
          resolveCount,
        });
        const result = await vault.discoverLinks("Notes/Source.md", signal, 100);
        expect(result).toHaveLength(100);
        expect(resolveCount.value).toBe(100);
        expect(result[0]?.link).toBe("Target-0");
        expect(result[99]?.link).toBe("Target-99");
      });
    });
  });

  describe("ReadNoteTool", () => {
    describe("execute()", () => {
      it("rejects malformed input and returns note provenance", async () => {
        const vault = adapter();
        const tool = new ReadNoteTool(vault);
        await expect(tool.execute({ path: 1 }, signal)).resolves.toMatchObject({
          ok: false,
          error: { code: "invalid_request" },
        });
        await expect(tool.execute({ path: "Notes/Source.md" }, signal)).resolves.toMatchObject({
          ok: true,
          provenance: [{ path: "Notes/Source.md", startLine: 1, endLine: 2 }],
        });
      });
    });
  });
  describe("CurrentNoteTool", () => {
    describe("execute()", () => {
      it("returns the active path and reports cancellation", async () => {
        const tool = new CurrentNoteTool(adapter({ active: "Notes/Source.md" }));
        await expect(tool.execute({}, signal)).resolves.toMatchObject({
          data: { path: "Notes/Source.md" },
          provenance: [{ path: "Notes/Source.md" }],
        });
        const controller = new AbortController();
        controller.abort();
        await expect(tool.execute({}, controller.signal)).resolves.toMatchObject({
          error: { code: "cancelled" },
        });
      });
    });
  });
  describe("DiscoverLinksTool", () => {
    describe("execute()", () => {
      it("returns link results and source provenance", async () => {
        await expect(
          new DiscoverLinksTool(adapter()).execute({ path: "Notes/Source.md" }, signal)
        ).resolves.toMatchObject({ ok: true, provenance: [{ path: "Notes/Source.md" }] });
      });
      it("falls back to one source path when no links have positions", async () => {
        const result = await new DiscoverLinksTool(
          adapter({ links: ["Target", "Missing"] })
        ).execute({ path: "Notes/Source.md" }, signal);
        expect(result.provenance).toEqual([{ path: "Notes/Source.md" }]);
      });
      it("includes source provenance when the note has no links", async () => {
        const result = await new DiscoverLinksTool(adapter({ links: [] })).execute(
          { path: "Notes/Source.md" },
          signal
        );
        expect(result.provenance).toEqual([{ path: "Notes/Source.md" }]);
      });
      it("deduplicates ranged source provenance and retains one fallback for unpositioned links", async () => {
        const result = await new DiscoverLinksTool(
          adapter({ links: ["Target", "Missing"], linkPositions: true })
        ).execute({ path: "Notes/Source.md" }, signal);
        expect(result.provenance).toEqual([
          { path: "Notes/Source.md", startLine: 1, endLine: 1 },
          { path: "Notes/Source.md", startLine: 2, endLine: 2 },
        ]);
      });
      it("bounds link count and signals truncation", async () => {
        const links = Array.from(
          { length: DiscoverLinksTool.MAX_LINKS + 1 },
          (_, i) => `Target-${i}`
        );
        const result = await new DiscoverLinksTool(adapter({ links })).execute(
          { path: "Notes/Source.md" },
          signal
        );
        expect(result.data).toMatchObject({
          truncated: true,
          resultLimit: DiscoverLinksTool.MAX_LINKS,
        });
        expect((result.data as { links: unknown[] }).links).toHaveLength(
          DiscoverLinksTool.MAX_LINKS
        );
        expect(JSON.stringify(result.data).length).toBeLessThanOrEqual(
          DiscoverLinksTool.MAX_SERIALIZED_CONTENT
        );
      });
      it("bounds serialized link content while preserving source-relative records", async () => {
        const result = await new DiscoverLinksTool(
          adapter({ links: ["x".repeat(DiscoverLinksTool.MAX_SERIALIZED_CONTENT)] })
        ).execute({ path: "Notes/Source.md" }, signal);
        expect(result.data).toMatchObject({ truncated: true });
        expect(JSON.stringify(result.data).length).toBeLessThanOrEqual(
          DiscoverLinksTool.MAX_SERIALIZED_CONTENT
        );
      });
    });
  });
  describe("FollowLinkTool", () => {
    describe("execute()", () => {
      it("proves source-relative navigation in provenance", async () => {
        await expect(
          new FollowLinkTool(adapter()).execute(
            { link: "Target", sourcePath: "Notes/Source.md" },
            signal
          )
        ).resolves.toMatchObject({
          data: { path: "Notes/Target.md" },
          provenance: [{ path: "Notes/Source.md" }, { path: "Notes/Target.md" }],
        });
      });
    });
  });
  describe("VaultSearchTool", () => {
    describe("execute()", () => {
      it("delegates with the hard result cap and returns provenance", async () => {
        const search = vi.fn(async (_query: string, _signal: AbortSignal, limit: number) => [
          { path: `result-${limit}.md` },
        ]);
        await expect(
          new VaultSearchTool({ search }).execute({ query: "needle" }, signal)
        ).resolves.toMatchObject({
          data: { results: [{ path: "result-20.md" }] },
          provenance: [{ path: "result-20.md" }],
        });
        expect(search).toHaveBeenCalledWith("needle", signal, 20);
      });
    });
  });
  describe("ToolRegistry", () => {
    describe("constructor()", () => {
      it("rejects duplicate names and freezes definitions", () => {
        const tool = new CurrentNoteTool(adapter());
        expect(() => new ToolRegistry([tool, tool])).toThrow("Duplicate tool");
        const registry = new ToolRegistry([tool]);
        expect(Object.isFrozen(registry.definitions)).toBe(true);
        expect(registry.get("missing")).toBeUndefined();
      });
    });
  });
});
