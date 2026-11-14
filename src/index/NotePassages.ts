import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import {
  getFrontMatterInfo,
  parseFrontMatterAliases,
  parseFrontMatterTags,
  parseYaml,
} from "obsidian";

export interface NotePassage {
  readonly ordinal: number;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly sectionStartOffset: number | null;
  readonly sectionPath: string[];
  readonly text: string;
}

export interface NoteMetadata {
  readonly title: string;
  readonly aliases: string[];
  readonly tags: string[];
}

export const NOTE_SPLITTER_ID = "body-recursive-utf8-1000-codepoint-v1";

const maxBytes = 1000;
const encoder = new TextEncoder();

class CodePointTextSplitter extends RecursiveCharacterTextSplitter {
  protected override splitOnSeparator(text: string, separator: string): string[] {
    return separator === "" ? Array.from(text) : super.splitOnSeparator(text, separator);
  }
}

const splitter = new CodePointTextSplitter({
  chunkSize: maxBytes,
  chunkOverlap: 0,
  keepSeparator: true,
  lengthFunction: (text) => (text.length > maxBytes ? maxBytes + 1 : encoder.encode(text).length),
});

export async function prepareNote(
  markdown: string,
  path: string
): Promise<{ passages: NotePassage[]; metadata: NoteMetadata }> {
  const frontmatter = getFrontMatterInfo(markdown);
  let parsed: unknown = null;
  if (frontmatter.exists) {
    try {
      parsed = parseYaml(frontmatter.frontmatter);
    } catch {
      /* Invalid YAML is still front matter. */
    }
  }
  const metadata = {
    title: (path.split("/").pop() ?? path).replace(/\.md$/i, ""),
    aliases: parseFrontMatterAliases(parsed) ?? [],
    tags: parseFrontMatterTags(parsed) ?? [],
  };
  const bodyStart = frontmatter.exists ? frontmatter.contentStart : 0;
  const body = markdown.slice(bodyStart);
  const chunks = await splitter.splitText(body);
  let cursor = 0;
  const passages = chunks.map((chunk, ordinal) => {
    const start = body.indexOf(chunk, cursor);
    if (start < 0 || body.slice(cursor, start).trim())
      throw new Error("Could not map passage to source text");
    cursor = start + chunk.length;
    const startOffset = bodyStart + start;
    const endOffset = bodyStart + cursor;
    return {
      ordinal,
      startOffset,
      endOffset,
      sectionStartOffset: null,
      sectionPath: [],
      text: markdown.slice(startOffset, endOffset),
    };
  });
  if (body.slice(cursor).trim()) throw new Error("Could not map passage to source text");
  return { passages, metadata };
}
