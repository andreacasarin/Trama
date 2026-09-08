import { describe, expect, it, vi } from "vitest";
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

  it("calibrates the metadata estimate with the real chunker", async () => {
    const content = Array.from({ length: 80 }, () => "x".repeat(250)).join("\n");
    const files = [
      { path: "one.md", stat: { size: content.length } },
      { path: "empty.md", stat: { size: 0 } },
    ] as any[];
    const read = vi.fn(async (file: { path: string }) => (file.path === "one.md" ? content : ""));
    const vault = new ObsidianIndexVault(
      {
        getMarkdownFiles: () => files,
        getFileByPath: (path) => files.find((file) => file.path === path) ?? null,
        read,
      },
      () => true
    );

    await expect(
      vault.estimateMarkdownTextCount(
        files.map((file) => file.path),
        384,
        64,
        new AbortController().signal
      )
    ).resolves.toBeGreaterThan(2);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("bounds estimation work to a deterministic 32-note sample", async () => {
    const files = Array.from({ length: 100 }, (_, index) => ({
      path: `note-${index}.md`,
      stat: { size: 1_000 + index },
    })) as any[];
    const read = vi.fn(async () => "line\n".repeat(200));
    const vault = new ObsidianIndexVault(
      {
        getMarkdownFiles: () => files,
        getFileByPath: (path) => files.find((file) => file.path === path) ?? null,
        read,
      },
      () => true
    );

    await expect(
      vault.estimateMarkdownTextCount(
        files.map((file) => file.path),
        384,
        64,
        new AbortController().signal
      )
    ).resolves.toBeGreaterThan(0);
    expect(read).toHaveBeenCalledTimes(32);
  });
});
