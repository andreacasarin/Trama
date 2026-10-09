import { describe, expect, it } from "vitest";
import { ObsidianIndexVault } from "@/vault/indexing/ObsidianIndexVault";

describe("ObsidianIndexVault", () => {
  it("indexes content beyond the read-tool line and character caps", async () => {
    const content = `${Array.from({ length: 250 }, (_, i) => `line ${i}`).join("\n")}\n${"x".repeat(21000)}`;
    const file = { path: "note.md" } as any;
    const vault = new ObsidianIndexVault(
      { getMarkdownFiles: () => [file], getFileByPath: () => file, read: async () => content },
      () => true
    );
    await expect(
      vault.readMarkdown("note.md", new AbortController().signal)
    ).resolves.toMatchObject({ content });
  });
  it("reads a note larger than one million characters in full", async () => {
    const file = { path: "large.md" } as any;
    const vault = new ObsidianIndexVault(
      {
        getMarkdownFiles: () => [file],
        getFileByPath: () => file,
        read: async () => "x".repeat(1_000_001),
      },
      () => true
    );
    await expect(
      vault.readMarkdown("large.md", new AbortController().signal)
    ).resolves.toMatchObject({
      content: "x".repeat(1_000_001),
    });
  });
  it("filters hidden roots and non-Markdown files during enumeration", async () => {
    const files = [
      { path: ".obsidian/config.md" },
      { path: ".trama/x.md" },
      { path: "image.png" },
      { path: "ok.md" },
    ] as any[];
    const vault = new ObsidianIndexVault(
      { getMarkdownFiles: () => files, getFileByPath: () => files[3], read: async () => "ok" },
      (path) => /\.md$/i.test(path) && !path.startsWith(".obsidian/") && !path.startsWith(".trama/")
    );
    await expect(vault.listMarkdownPaths(new AbortController().signal)).resolves.toEqual(["ok.md"]);
  });

  it("applies the current index-path filter during listing and reads", async () => {
    let excluded = new Set(["private", "exact.md"]);
    const files = [{ path: "ok.md" }, { path: "private/note.md" }, { path: "exact.md" }] as any[];
    const vault = new ObsidianIndexVault(
      {
        getMarkdownFiles: () => files,
        getFileByPath: (path) => files.find((f) => f.path === path) ?? null,
        read: async () => "ok",
      },
      (path) =>
        path.endsWith(".md") &&
        ![...excluded].some((entry) => path === entry || path.startsWith(`${entry}/`))
    );

    await expect(vault.listMarkdownPaths(new AbortController().signal)).resolves.toEqual(["ok.md"]);
    await expect(
      vault.readMarkdown("private/note.md", new AbortController().signal)
    ).rejects.toThrow();
    excluded = new Set();
    await expect(vault.listMarkdownPaths(new AbortController().signal)).resolves.toEqual([
      "ok.md",
      "private/note.md",
      "exact.md",
    ]);
  });

  it("reports whether a Markdown path is still available after a move", async () => {
    const file = { path: "new.md" } as any;
    const vault = new ObsidianIndexVault(
      {
        getMarkdownFiles: () => [file],
        getFileByPath: (path) => (path === file.path ? file : null),
        read: async () => "content",
      },
      () => true
    );

    await expect(vault.isMarkdownAvailable("old.md", new AbortController().signal)).resolves.toBe(
      false
    );
    await expect(vault.isMarkdownAvailable("new.md", new AbortController().signal)).resolves.toBe(
      true
    );
  });
});
