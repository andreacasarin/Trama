import { getFrontMatterInfo, parseYaml } from "obsidian";

export interface SkillCommand {
  readonly path: string;
  readonly description?: string;
  readonly alias?: string;
  readonly issue?: "invalid_alias" | "duplicate_alias";
  readonly conflictingPaths?: readonly string[];
}

export interface SkillCommandReferenceIssue {
  readonly alias: string;
  readonly reason: "not_found" | "duplicate";
  readonly paths: readonly string[];
}

export interface ResolvedSkillCommands {
  readonly commands: readonly SkillCommand[];
  readonly issues: readonly SkillCommandReferenceIssue[];
}

interface CachedSkillMetadata {
  readonly path: string;
  readonly description?: unknown;
  readonly marker: unknown;
  readonly alias: unknown;
}

const COMMAND_ALIAS = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COMMAND_REFERENCE = /\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=$|[\s.,!?;:])/g;

function validAlias(value: unknown): value is string {
  return typeof value === "string" && COMMAND_ALIAS.test(value);
}

export function skillCommandCatalog(metadata: readonly CachedSkillMetadata[]): SkillCommand[] {
  const marked = metadata.filter((entry) => entry.marker === true);
  const aliases = new Map<string, string[]>();
  for (const entry of marked) {
    if (!validAlias(entry.alias)) continue;
    aliases.set(entry.alias, [...(aliases.get(entry.alias) ?? []), entry.path]);
  }
  return marked.map((entry) => {
    const description = typeof entry.description === "string" ? entry.description.trim() : "";
    const base = { path: entry.path, ...(description ? { description } : {}) };
    if (!validAlias(entry.alias)) return { ...base, issue: "invalid_alias" };
    const conflictingPaths = aliases.get(entry.alias)!;
    return conflictingPaths.length > 1
      ? { ...base, alias: entry.alias, issue: "duplicate_alias", conflictingPaths }
      : { ...base, alias: entry.alias };
  });
}

export function resolveSkillCommands(
  content: string,
  catalog: readonly SkillCommand[]
): ResolvedSkillCommands {
  const commands: SkillCommand[] = [];
  const issues: SkillCommandReferenceIssue[] = [];
  for (const match of content.matchAll(COMMAND_REFERENCE)) {
    if (match.index !== 0 && !/\s/.test(content[match.index - 1])) continue;
    const alias = match[1];
    const matches = catalog.filter((command) => command.alias === alias);
    if (matches.length > 1 || matches.some((command) => command.issue === "duplicate_alias")) {
      issues.push({ alias, reason: "duplicate", paths: matches.map((command) => command.path) });
    } else if (matches.length !== 1 || matches[0].issue) {
      issues.push({ alias, reason: "not_found", paths: [] });
    } else if (!commands.some((command) => command.path === matches[0].path)) {
      commands.push(matches[0]);
    }
  }
  return { commands, issues };
}

export function skillCommandReference(command: SkillCommand): string {
  if (!command.alias || command.issue)
    throw new Error(`Skill ${command.path} needs a unique lowercase trama-voce-command alias.`);
  return `/${command.alias}`;
}

export function skillBody(content: string, expected: SkillCommand): string {
  const info = getFrontMatterInfo(content);
  let frontmatter: Record<string, unknown> | null = null;
  try {
    frontmatter = info.exists ? parseYaml(info.frontmatter) : null;
  } catch {
    frontmatter = null;
  }
  if (frontmatter?.["trama-voce-skill"] !== true)
    throw new Error(`Skill ${expected.path} must have trama-voce-skill: true.`);
  if (!expected.alias || frontmatter["trama-voce-command"] !== expected.alias)
    throw new Error(
      `Skill ${expected.path} must have trama-voce-command: ${expected.alias ?? "a unique lowercase alias"}.`
    );
  return content.slice(info.contentStart).trim();
}
