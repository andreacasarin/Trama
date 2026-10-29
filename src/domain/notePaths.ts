export function noteTarget(value: string): string {
  const wrapped = value.match(/^!?\[\[([^\]]+)\]\]$/);
  return (wrapped ? wrapped[1].split("|", 1)[0] : value).split(/[#^]/, 1)[0].trim();
}

function withoutExtension(path: string): string {
  return path.toLowerCase().endsWith(".md") ? path.slice(0, -3) : path;
}

/** Exact vault paths win; bare titles must resolve to a unique visible note. */
export function noteCandidates(target: string, catalog: readonly string[]): readonly string[] {
  const clean = withoutExtension(noteTarget(target));
  if (
    !clean ||
    clean.startsWith("/") ||
    clean.includes("\\") ||
    clean.split("/").some((part) => part.startsWith("."))
  )
    return [];
  const exact = catalog.filter((path) => withoutExtension(path) === clean);
  if (exact.length || clean.includes("/")) return exact;
  return catalog.filter(
    (path) => withoutExtension(path).split("/").at(-1)?.toLowerCase() === clean.toLowerCase()
  );
}
