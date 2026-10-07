import type { SqliteLexicalRevisionInput } from "./protocol";
import type { SqliteConnection } from "./core";

export function pruneUnreferencedRevisions(db: SqliteConnection): void {
  db.exec(`DELETE FROM note_revisions
           WHERE NOT EXISTS (SELECT 1 FROM notes n WHERE n.lexical_revision_id=note_revisions.revision_id)
             AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.semantic_revision_id=note_revisions.revision_id)`);
}

export function lexicalNoteText(input: SqliteLexicalRevisionInput) {
  if (input.lexical) return input.lexical;
  const filename = input.path.slice(input.path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
  const headings = input.blocks
    .filter((block) => block.kind === "heading")
    .map((block) => block.displayText);
  return {
    title: headings[0] ?? filename,
    headings: headings.join("\n"),
    body: input.blocks.map((block) => block.displayText).join("\n"),
  };
}
