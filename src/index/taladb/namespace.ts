/** Paths owned by the Tala index. Legacy `.trama/index` artifacts are never addressed here. */
export const TALA_NAMESPACE_VERSION = "taladb-v1";

export interface TalaNamespace {
  readonly root: string;
  readonly database: string;
  readonly state: string;
  readonly checkpoint: string;
}

function randomNamespaceId(): string {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

export function createTalaNamespace(vaultId = randomNamespaceId()): TalaNamespace {
  if (
    !vaultId ||
    vaultId.includes("/") ||
    vaultId.includes("\\") ||
    vaultId === "." ||
    vaultId === ".."
  )
    throw new Error("Invalid Tala namespace id");
  const root = `.trama/index/${TALA_NAMESPACE_VERSION}/${vaultId}`;
  // Tala's browser binding treats this as an OPFS/IndexedDB database name,
  // rather than a vault-relative path.  Keep it opaque and path-free even
  // when a test supplies a deterministic namespace id.
  const database = `trama-tala-${vaultId}`;
  if (!database || database.includes("/") || database.includes("\\"))
    throw new Error("Invalid Tala database name");
  return Object.freeze({
    root,
    database,
    state: `${root}/state.json`,
    checkpoint: `${root}/checkpoint.bin`,
  });
}

export function assertTalaPath(path: string): void {
  if (!path.startsWith(`.trama/index/${TALA_NAMESPACE_VERSION}/`) || path.includes(".."))
    throw new Error("Path is outside the Tala namespace");
}
