import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

export const CORPUS_COUNT = 3000;
export const NOTE_CHARACTERS = 400;
export const CORPUS_SHA256 = "66d061b6c61c157587bf1dace04c6e72e7b0c5d3f8dd44393699d3b50f7b1c8a";

export function createPerformanceCorpus() {
  const notes = Array.from({ length: CORPUS_COUNT }, (_, index) => {
    const path = `notes/${String(index).padStart(4, "0")}.md`;
    const seed =
      index === 0
        ? "D5 lexical sentinel unique phrase."
        : index === 1 || index === 2
          ? "D5 semantic sentinel shared passage for related-note retrieval."
          : `Trama benchmark note ${index}.`;
    const content =
      `${seed} ${"A fixed benchmark note with ordinary prose for indexing. ".repeat(12)}`
        .slice(0, NOTE_CHARACTERS)
        .padEnd(NOTE_CHARACTERS, "x");
    return { path, content };
  });
  const hash = createHash("sha256");
  for (const note of notes) {
    updateLengthPrefixed(hash, note.path);
    updateLengthPrefixed(hash, note.content);
  }
  const sha256 = hash.digest("hex");
  if (sha256 !== CORPUS_SHA256)
    throw new Error(`Pinned benchmark corpus changed: expected ${CORPUS_SHA256}, got ${sha256}`);
  return { notes, sha256 };
}

function updateLengthPrefixed(hash, value) {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  hash.update(length).update(bytes);
}
