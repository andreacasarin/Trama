import { describe, expect, it, vi } from "vitest";
import { ObsidianReadonlyVault } from "@/vault/readOnly/ObsidianReadonlyVault";

describe("Obsidian read-only vault", () => {
  it("returns complete Markdown content while preserving accessible-path and cancellation checks", async () => {
    const content = Array.from(
      { length: 210 },
      (_, index) => `Line ${index} ${"x".repeat(120)}`
    ).join("\n");
    expect(content.length).toBeGreaterThan(20_000);
    expect(content.split("\n")).toHaveLength(210);

    let releaseRead!: (value: string) => void;
    const file = { path: "Long.md", name: "Long.md" };
    const vault = {
      configDir: ".obsidian",
      getFileByPath: vi.fn((path: string) => (path === "Long.md" ? file : null)),
      read: vi.fn(async () => content),
    };
    const metadataCache = {
      getFirstLinkpathDest: vi.fn(() => null),
      getFileCache: vi.fn(() => null),
    };
    const readonlyVault = new ObsidianReadonlyVault(vault as never, metadataCache as never);
    const note = await readonlyVault.readNote("Long.md", new AbortController().signal);

    expect(note).toEqual({
      path: "Long.md",
      content,
      truncated: false,
      startLine: 1,
      endLine: 210,
    });
    await expect(
      readonlyVault.readNote(".obsidian/Secret.md", new AbortController().signal)
    ).rejects.toThrow("Path is not an accessible Markdown note");
    await expect(
      readonlyVault.readNote("../Long.md", new AbortController().signal)
    ).rejects.toThrow("Path traversal is not allowed");

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(readonlyVault.readNote("Long.md", alreadyAborted.signal)).rejects.toThrow(
      "Operation cancelled"
    );

    vault.read.mockImplementationOnce(() => new Promise((resolve) => (releaseRead = resolve)));
    const controller = new AbortController();
    const pending = readonlyVault.readNote("Long.md", controller.signal);
    await vi.waitFor(() => expect(releaseRead).toBeTypeOf("function"));
    controller.abort();
    releaseRead(content);
    await expect(pending).rejects.toThrow("Operation cancelled");
  });

  it("discovers frontmatter links before ordered body links and embeds, with bounded results", async () => {
    const files = [
      "Folder/Source.md",
      "Folder/Yaml.md",
      "Folder/Embedded.md",
      "Folder/First.md",
      "Folder/Last.md",
    ].map((path) => ({ path, name: path.split("/").at(-1)! }));
    const positions = {
      start: { line: 0, col: 0, offset: 0 },
      end: { line: 4, col: 3, offset: 50 },
    };
    const cache = {
      frontmatterLinks: [{ key: "review", link: "Yaml" }],
      frontmatterPosition: positions,
      links: [
        {
          link: "Last",
          position: {
            start: { line: 12, col: 4, offset: 200 },
            end: { line: 12, col: 12, offset: 208 },
          },
        },
        {
          link: "First#Review",
          original: "> - [[First#Review|Friday]]",
          displayText: "Friday",
          position: {
            start: { line: 6, col: 4, offset: 100 },
            end: { line: 6, col: 13, offset: 109 },
          },
        },
      ],
      embeds: [
        {
          link: "Embedded",
          position: {
            start: { line: 9, col: 0, offset: 150 },
            end: { line: 9, col: 14, offset: 164 },
          },
        },
      ],
    };
    const vault = {
      configDir: ".obsidian",
      getMarkdownFiles: () => files,
      getFileByPath: (path: string) => files.find((file) => file.path === path) ?? null,
      read: vi.fn(async () => ""),
    };
    const metadataCache = {
      getFirstLinkpathDest: (link: string, source: string) => {
        const target = `${source.slice(0, source.lastIndexOf("/") + 1)}${link}.md`;
        return files.find((file) => file.path === target) ?? null;
      },
      getFileCache: (file: { path: string }) => (file.path === "Folder/Source.md" ? cache : null),
    };
    const readonlyVault = new ObsidianReadonlyVault(vault as never, metadataCache as never);
    const signal = new AbortController().signal;

    const all = await readonlyVault.discoverLinks("Folder/Source.md", signal);
    expect(all.map(({ link, targetPath, startLine }) => ({ link, targetPath, startLine }))).toEqual(
      [
        { link: "Yaml", targetPath: "Folder/Yaml.md", startLine: 1 },
        { link: "First#Review", targetPath: "Folder/First.md", startLine: 7 },
        { link: "Embedded", targetPath: "Folder/Embedded.md", startLine: 10 },
        { link: "Last", targetPath: "Folder/Last.md", startLine: 13 },
      ]
    );
    expect(await readonlyVault.resolveLinkDetails("Yaml", "Folder/Source.md", signal)).toEqual({
      path: "Folder/Yaml.md",
      startLine: 1,
      endLine: 5,
    });
    expect(
      await readonlyVault.resolveLinkDetails("First#Review", "Folder/Source.md", signal)
    ).toEqual({ path: "Folder/First.md", startLine: 7, endLine: 7 });
    expect(
      (await readonlyVault.discoverLinks("Folder/Source.md", signal, 2)).map((item) => item.link)
    ).toEqual(["Yaml", "First#Review"]);
  });

  it("does not invent line ranges for YAML references without frontmatter position", async () => {
    const source = { path: "Folder/Source.md", name: "Source.md" };
    const target = { path: "Folder/Target.md", name: "Target.md" };
    const vault = {
      configDir: ".obsidian",
      getMarkdownFiles: () => [source, target],
      getFileByPath: (path: string) => [source, target].find((file) => file.path === path) ?? null,
      read: vi.fn(async () => ""),
    };
    const readonlyVault = new ObsidianReadonlyVault(
      vault as never,
      {
        getFirstLinkpathDest: () => target,
        getFileCache: () => ({ frontmatterLinks: [{ key: "review", link: "Target" }] }),
      } as never
    );
    const links = await readonlyVault.discoverLinks(
      "Folder/Source.md",
      new AbortController().signal
    );
    expect(links).toEqual([
      { link: "Target", sourcePath: "Folder/Source.md", targetPath: "Folder/Target.md" },
    ]);
  });

  it("resolves wrapped wikilinks while preserving bare link text, line provenance, and access checks", async () => {
    const files = [
      "Folder/Source.md",
      "Folder/Principles to live by.md",
      "Folder/Life Planning.md",
      "Folder/Daily.md",
      "Folder/Literal|Pipe.md",
    ].map((path) => ({ path, name: path.split("/").at(-1)! }));
    const cache = {
      links: [
        { link: "Principles to live by", position: { start: { line: 3 }, end: { line: 3 } } },
        { link: "Life Planning", position: { start: { line: 4 }, end: { line: 4 } } },
        { link: "Daily#Review", position: { start: { line: 8 }, end: { line: 8 } } },
      ],
    };
    const vault = {
      configDir: ".obsidian",
      getMarkdownFiles: () => files,
      getFileByPath: (path: string) => files.find((file) => file.path === path) ?? null,
      read: vi.fn(async () => ""),
    };
    const metadataCache = {
      getFileCache: (file: { path: string }) => (file.path === "Folder/Source.md" ? cache : null),
      getFirstLinkpathDest: (link: string, source: string) => {
        if (link === "../Secret") return { path: "../Secret.md" };
        const target = `${source.slice(0, source.lastIndexOf("/") + 1)}${link.split("#", 1)[0]}.md`;
        if (target === "Folder/.obsidian/Secret.md") return { path: target };
        return files.find((file) => file.path === target) ?? null;
      },
    };
    const readonlyVault = new ObsidianReadonlyVault(vault as never, metadataCache as never);
    const signal = new AbortController().signal;

    expect(
      await readonlyVault.resolveLinkDetails(
        "[[Principles to live by]]",
        "Folder/Source.md",
        signal
      )
    ).toEqual({
      path: "Folder/Principles to live by.md",
      startLine: 4,
      endLine: 4,
    });
    expect(
      await readonlyVault.resolveLinkDetails("[[Life Planning]]", "Folder/Source.md", signal)
    ).toEqual({
      path: "Folder/Life Planning.md",
      startLine: 5,
      endLine: 5,
    });
    expect(
      await readonlyVault.resolveLinkDetails("[[Daily#Review|Friday]]", "Folder/Source.md", signal)
    ).toEqual({
      path: "Folder/Daily.md",
      startLine: 9,
      endLine: 9,
    });
    expect(
      await readonlyVault.resolveLink("![[Daily#Review|Friday]]", "Folder/Source.md", signal)
    ).toBe("Folder/Daily.md");
    expect(await readonlyVault.resolveLink("Literal|Pipe", "Folder/Source.md", signal)).toBe(
      "Folder/Literal|Pipe.md"
    );
    expect(await readonlyVault.resolveLink("[[Daily", "Folder/Source.md", signal)).toBeNull();
    expect(
      await readonlyVault.resolveLink("[[.obsidian/Secret]]", "Folder/Source.md", signal)
    ).toBeNull();
    expect(await readonlyVault.resolveLink("[[../Secret]]", "Folder/Source.md", signal)).toBeNull();

    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      readonlyVault.resolveLink("[[Daily#Review|Friday]]", "Folder/Source.md", cancelled.signal)
    ).rejects.toThrow("Operation cancelled");
  });

  it("resolves source-free note names only when they identify one visible note", async () => {
    const files = [
      "Root.md",
      "Journal/Principles to live by.md",
      "Planning/Life Planning.md",
      "Journal/Duplicate.md",
      "Planning/Duplicate.md",
      ".obsidian/Hidden.md",
    ].map((path) => ({ path, name: path.split("/").at(-1)! }));
    const vault = {
      configDir: ".obsidian",
      getMarkdownFiles: vi.fn(() => files),
      getFileByPath: (path: string) => files.find((file) => file.path === path) ?? null,
      read: vi.fn(async (file: { path: string }) => `Body of ${file.path}`),
    };
    const metadataCache = {
      getFirstLinkpathDest: vi.fn(() => null),
      getFileCache: vi.fn(() => null),
    };
    const readonlyVault = new ObsidianReadonlyVault(vault as never, metadataCache as never);
    const signal = new AbortController().signal;

    expect(await readonlyVault.resolveLink("[[Principles to live by]]", null, signal)).toBe(
      "Journal/Principles to live by.md"
    );
    expect(await readonlyVault.resolveLink("Root.MD", null, signal)).toBe("Root.md");
    expect(await readonlyVault.resolveLink("![[Life Planning#Plan|Planning]]", null, signal)).toBe(
      "Planning/Life Planning.md"
    );
    await expect(readonlyVault.resolveLink("Duplicate", null, signal)).rejects.toThrow(
      "Ambiguous note name"
    );
    expect(await readonlyVault.resolveLink("Missing", null, signal)).toBeNull();
    await expect(readonlyVault.resolveLink(".obsidian/Hidden", null, signal)).rejects.toThrow(
      "Path is not an accessible Markdown note"
    );
    await expect(readonlyVault.resolveLink("../Hidden", null, signal)).rejects.toThrow(
      "Path traversal"
    );
    await expect(readonlyVault.resolveLink("/Root", null, signal)).rejects.toThrow(
      "Invalid vault path"
    );
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(readonlyVault.resolveLink("Root", null, cancelled.signal)).rejects.toThrow(
      "Operation cancelled"
    );
    expect(metadataCache.getFirstLinkpathDest).not.toHaveBeenCalled();
  });

  it("uses Obsidian's source-relative resolution when duplicate titles exist", async () => {
    const files = [
      { path: "Folder/Source.md", name: "Source.md" },
      { path: "Folder/Daily.md", name: "Daily.md" },
      { path: "Other/Daily.md", name: "Daily.md" },
    ];
    const vault = {
      configDir: ".obsidian",
      getMarkdownFiles: () => files,
      getFileByPath: (path: string) => files.find((file) => file.path === path) ?? null,
      read: vi.fn(async () => ""),
    };
    const metadataCache = {
      getFirstLinkpathDest: vi.fn((link: string, source: string) =>
        link === "Daily" && source === "Folder/Source.md" ? files[1] : null
      ),
      getFileCache: () => null,
    };
    const readonlyVault = new ObsidianReadonlyVault(vault as never, metadataCache as never);

    await expect(
      readonlyVault.resolveLink("Daily", "Folder/Source.md", new AbortController().signal)
    ).resolves.toBe("Folder/Daily.md");
    expect(metadataCache.getFirstLinkpathDest).toHaveBeenCalledWith("Daily", "Folder/Source.md");
  });
});
