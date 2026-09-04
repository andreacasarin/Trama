export interface NoteReferenceIssue {
  readonly target: string;
  readonly reason: "not_found" | "ambiguous";
}

export interface ResolvedNoteReferences {
  readonly paths: readonly string[];
  readonly issues: readonly NoteReferenceIssue[];
}

interface WikilinkMatch {
  readonly start: number;
  readonly end: number;
  readonly target: string;
}

const WIKILINK = /\[\[([^[]+?)\]\]/g;

function noteTarget(value: string): string {
  return value.split("|", 1)[0].split(/[#^]/, 1)[0].trim();
}

function withoutMarkdownExtension(path: string): string {
  return path.toLowerCase().endsWith(".md") ? path.slice(0, -3) : path;
}

function wikilinks(content: string): readonly WikilinkMatch[] {
  return [...content.matchAll(WIKILINK)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    target: noteTarget(match[1]),
  }));
}

function candidates(target: string, catalog: readonly string[]): readonly string[] {
  const normalizedTarget = withoutMarkdownExtension(target.replace(/^\/+/, ""));
  const exact = catalog.filter((path) => withoutMarkdownExtension(path) === normalizedTarget);
  if (exact.length || normalizedTarget.includes("/")) return exact;
  return catalog.filter((path) => {
    const normalizedPath = withoutMarkdownExtension(path);
    return normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1) === normalizedTarget;
  });
}

/** Resolves Obsidian wikilinks to visible Markdown paths without consulting the active note. */
export function resolveNoteReferences(
  content: string,
  catalog: readonly string[]
): ResolvedNoteReferences {
  const paths: string[] = [];
  const issues: NoteReferenceIssue[] = [];
  const seen = new Set<string>();
  for (const reference of wikilinks(content)) {
    if (!reference.target) continue;
    const matches = candidates(reference.target, catalog);
    if (matches.length !== 1) {
      issues.push({
        target: reference.target,
        reason: matches.length ? "ambiguous" : "not_found",
      });
      continue;
    }
    if (!seen.has(matches[0])) {
      seen.add(matches[0]);
      paths.push(matches[0]);
    }
  }
  return { paths: Object.freeze(paths), issues: Object.freeze(issues) };
}

/** Removes the first wikilink that resolves to a selected path. */
export function removeNoteReference(
  content: string,
  path: string,
  catalog: readonly string[]
): string {
  const reference = wikilinks(content).find(
    (match) =>
      candidates(match.target, catalog).length === 1 &&
      candidates(match.target, catalog)[0] === path
  );
  if (!reference) return content;
  let { start, end } = reference;
  if (/\s$/.test(content.slice(0, start)) && /^\s/.test(content.slice(end))) end++;
  else if (start === 0 && /^\s/.test(content.slice(end))) end++;
  else if (end === content.length && /\s$/.test(content.slice(0, start))) start--;
  return `${content.slice(0, start)}${content.slice(end)}`;
}
