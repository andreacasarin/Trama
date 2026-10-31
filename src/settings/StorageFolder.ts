export const DEFAULT_STORAGE_FOLDER = ".trama";

export function normalizeStorageFolder(value: unknown, configDir = ".obsidian"): string {
  if (typeof value !== "string") throw new Error("Storage folder must be a vault-relative path.");
  const raw = value.trim();
  if (!raw || raw.startsWith("/") || raw.includes("\\") || /^[a-z]:/i.test(raw))
    throw new Error("Storage folder must be a non-empty vault-relative path.");
  const parts = raw
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part && part !== ".");
  if (!parts.length || parts.includes(".."))
    throw new Error("Storage folder cannot contain traversal segments.");
  const normalized = parts.join("/");
  const config = configDir.split("/").filter(Boolean).join("/");
  if (normalized === config || normalized.startsWith(`${config}/`))
    throw new Error("Storage folder cannot be inside Obsidian's configuration folder.");
  return normalized;
}

export function storagePaths(folder: string) {
  return {
    identity: `${folder}/identity.json`,
    embeddings: `${folder}/embeddings`,
  };
}
