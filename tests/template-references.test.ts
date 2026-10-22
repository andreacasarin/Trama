import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async (importOriginal) => ({
  ...(await importOriginal<typeof import("obsidian")>()),
  getFrontMatterInfo: (content: string) => {
    const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
    return {
      exists: Boolean(match),
      frontmatter: match?.[1] ?? "",
      contentStart: match?.[0].length ?? 0,
    };
  },
  parseYaml: (source: string) =>
    Object.fromEntries(
      source.split("\n").flatMap((line) => {
        const match = line.match(/^([^:]+):\s*(.*?)\s*$/);
        if (!match) return [];
        const [, key, value] = match;
        return [[key, value === "true" ? true : value.replace(/^['"]|['"]$/g, "")]];
      })
    ),
}));

import {
  resolveSkillCommands,
  skillBody,
  skillCommandCatalog,
  skillCommandReference,
} from "@/chat/TemplateReferences";

describe("Voce skill commands", () => {
  const catalog = skillCommandCatalog([
    { path: "Skills/Coach.md", marker: true, alias: "coach-analyst" },
    { path: "Skills/Bad.md", marker: true, alias: "Bad Alias" },
    { path: "Skills/Duplicate-a.md", marker: true, alias: "review" },
    { path: "Skills/Duplicate-b.md", marker: true, alias: "review" },
    { path: "Old-tag.md", marker: false, alias: "legacy" },
    { path: "String-true.md", marker: "true", alias: "ignored" },
  ]);

  it("registers only boolean-marked skills and requires an explicit unique lowercase alias", () => {
    expect(catalog).toEqual([
      { path: "Skills/Coach.md", alias: "coach-analyst" },
      { path: "Skills/Bad.md", issue: "invalid_alias" },
      {
        path: "Skills/Duplicate-a.md",
        alias: "review",
        issue: "duplicate_alias",
        conflictingPaths: ["Skills/Duplicate-a.md", "Skills/Duplicate-b.md"],
      },
      {
        path: "Skills/Duplicate-b.md",
        alias: "review",
        issue: "duplicate_alias",
        conflictingPaths: ["Skills/Duplicate-a.md", "Skills/Duplicate-b.md"],
      },
    ]);
  });

  it("resolves aliases while leaving URLs and path fragments literal and reports unavailable commands", () => {
    expect(
      resolveSkillCommands(
        "Visit https://example.com/coach-analyst and dir/coach-analyst, then /coach-analyst /missing",
        catalog
      )
    ).toEqual({
      commands: [catalog[0]],
      issues: [{ alias: "missing", reason: "not_found", paths: [] }],
    });
    expect(resolveSkillCommands("Use /review", catalog).issues).toEqual([
      {
        alias: "review",
        reason: "duplicate",
        paths: ["Skills/Duplicate-a.md", "Skills/Duplicate-b.md"],
      },
    ]);
    expect(skillCommandReference(catalog[0])).toBe("/coach-analyst");
  });

  it("validates the fresh marker and alias, then strips YAML frontmatter", () => {
    const source =
      "---\ntrama-voce-skill: true\ntrama-voce-command: coach-analyst\n---\nAnalyze this request";
    expect(skillBody(source, catalog[0])).toBe("Analyze this request");
    expect(() => skillBody(source.replace("true", "false"), catalog[0])).toThrow(
      /Skills\/Coach.md.*trama-voce-skill: true/
    );
    expect(() => skillBody(source.replace("coach-analyst", "another"), catalog[0])).toThrow(
      /Skills\/Coach.md.*trama-voce-command: coach-analyst/
    );
    expect(() => skillCommandReference(catalog[1])).toThrow(/Skills\/Bad.md/);
  });
});
