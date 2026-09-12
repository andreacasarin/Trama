import { chunkId } from "@/index/Hash";

/** Vault-relative paths are canonicalized before they enter persisted IDs. */
export function normalizeIndexPath(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  if (parts[0] === ".") parts.shift();
  if (!parts.length || parts.some((part) => !part || part === ".."))
    throw new Error("Invalid vault-relative index path");
  const normalized = parts.filter((part) => part !== ".").join("/");
  if (!normalized || normalized.startsWith("/"))
    throw new Error("Invalid vault-relative index path");
  return normalized;
}

/** Reversible strict-JSON ID; the public content-addressed chunkId is separate. */
export function oramaDocumentId(path: string, ordinal: number): string {
  const normalized = normalizeIndexPath(path);
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new Error("Invalid chunk ordinal");
  return JSON.stringify([normalized, ordinal]);
}

export function parseOramaDocumentId(id: string): {
  readonly path: string;
  readonly ordinal: number;
} {
  let value: unknown;
  try {
    value = JSON.parse(id);
  } catch {
    throw new Error("Invalid Orama document ID");
  }
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "string" ||
    !Number.isSafeInteger(value[1]) ||
    value[1] < 0 ||
    oramaDocumentId(value[0], value[1]) !== id
  )
    throw new Error("Invalid Orama document ID");
  return { path: value[0], ordinal: value[1] };
}

export function publicChunkId(contentId: string, ordinal: number): string {
  return chunkId(contentId, ordinal);
}
