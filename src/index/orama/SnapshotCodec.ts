import { compareCodeUnits } from "@/index/Ordering";
import { normalizeIndexPath, parseOramaDocumentId } from "@/index/Identity";
import { StructuredError } from "@/domain/contracts";
import {
  countOramaDocuments,
  getOramaDocument,
  createOramaDatabase,
  insertOramaDocuments,
  loadOramaDatabase,
  ORAMA_INSERT_BATCH_SIZE,
  probeOramaRemoval,
  saveOramaDatabase,
  searchOrama,
  validateOramaDocument,
  type OramaDatabaseSnapshot,
} from "./OramaDatabase";
import {
  ORAMA_SCHEMA_VERSION,
  ORAMA_SNAPSHOT_FORMAT,
  ORAMA_VERSION,
  type OramaCatalog,
  type OramaCatalogNote,
  type OramaDocument,
  type OramaSnapshotEnvelope,
  type SnapshotOperation,
} from "./OramaTypes";
import type { AnyOrama } from "@orama/orama";

export const SNAPSHOT_MAX_BYTES = 1_073_741_824;
export const SNAPSHOT_MAX_CHUNKS = 1_000_000;
export const SNAPSHOT_MAX_NOTES = 1_000_000;
export const SNAPSHOT_DIMENSIONS = 768;

export interface LoadedOramaSnapshot {
  readonly envelope: OramaSnapshotEnvelope;
  readonly db: AnyOrama;
}

export function createSnapshotEnvelope(
  catalog: OramaCatalog,
  fingerprint: string,
  dimensions: number,
  snapshotRevision: number,
  operation: SnapshotOperation,
  db: AnyOrama
): OramaSnapshotEnvelope {
  return {
    schema: ORAMA_SCHEMA_VERSION,
    format: ORAMA_SNAPSHOT_FORMAT,
    oramaVersion: ORAMA_VERSION,
    fingerprint,
    dimensions,
    snapshotRevision,
    complete: true,
    operation,
    catalog,
    payload: jsonSafe(saveOramaDatabase(db).raw),
  };
}

export function encodeSnapshot(envelope: OramaSnapshotEnvelope): string {
  validateEnvelope(envelope);
  const raw = canonical(envelope);
  const bytes = new TextEncoder().encode(raw).byteLength;
  if (bytes > SNAPSHOT_MAX_BYTES) throw new Error("Orama snapshot exceeds the maximum size");
  return `${raw}\n`;
}

export function decodeSnapshot(raw: string, expectedFingerprint?: string): OramaSnapshotEnvelope {
  const bytes = new TextEncoder().encode(raw).byteLength;
  if (!raw || bytes > SNAPSHOT_MAX_BYTES) throw new Error("Invalid Orama snapshot size");
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(raw))
    );
  } catch {
    throw new Error("Invalid Orama snapshot JSON");
  }
  validateEnvelope(value);
  if (`${canonical(value)}\n` !== raw) throw new Error("Non-canonical Orama snapshot");
  if (expectedFingerprint !== undefined && value.fingerprint !== expectedFingerprint)
    throw new Error("Orama snapshot fingerprint mismatch");
  return value;
}

/** Loads into a fresh public Orama database and validates every catalog entry. */
export async function loadAndValidateSnapshot(
  raw: string,
  expectedFingerprint?: string,
  signal?: AbortSignal
): Promise<LoadedOramaSnapshot> {
  const envelope = decodeSnapshot(raw, expectedFingerprint);
  const opaqueDb = await loadOramaDatabase(envelope.dimensions, {
    raw: envelope.payload,
  } satisfies OramaDatabaseSnapshot);
  const db = await validateLoadedSnapshot(opaqueDb, envelope, signal);
  return { envelope, db };
}

/** Validates document-store data, then rebuilds a clean public projection. */
export async function validateLoadedSnapshot(
  db: AnyOrama,
  envelope: OramaSnapshotEnvelope,
  signal?: AbortSignal
): Promise<AnyOrama> {
  validateEnvelope(envelope);
  if (countOramaDocuments(db) !== envelope.catalog.chunkCount)
    throw new Error("Orama snapshot document count mismatch");
  const ids = new Set<string>();
  const rebuilt = await createOramaDatabase(envelope.dimensions);
  let batch: OramaDocument[] = [];
  let firstDocument: OramaDocument | undefined;
  for (const note of envelope.catalog.notes) {
    for (const id of note.documentIds) {
      check(signal);
      if (ids.has(id)) throw new Error("Orama snapshot document ID is duplicated");
      ids.add(id);
      const document = getOramaDocument(db, id);
      if (!document) throw new Error("Orama snapshot catalog document is missing");
      validateOramaDocument(document, envelope.dimensions);
      if (document.path !== note.path || document.contentId !== note.contentId)
        throw new Error("Orama snapshot identity metadata mismatch");
      firstDocument ??= document;
      batch.push(document);
      if (batch.length >= ORAMA_INSERT_BATCH_SIZE) {
        await insertOramaDocuments(rebuilt, batch, ORAMA_INSERT_BATCH_SIZE);
        batch = [];
        await macrotask();
      }
    }
  }
  if (batch.length) await insertOramaDocuments(rebuilt, batch, ORAMA_INSERT_BATCH_SIZE);
  if (ids.size !== envelope.catalog.chunkCount)
    throw new Error("Orama snapshot IDs are incomplete");
  if (countOramaDocuments(rebuilt) !== envelope.catalog.chunkCount)
    throw new Error("Orama rebuilt snapshot document count mismatch");
  check(signal);
  if (firstDocument) {
    const vectorResult = await searchOrama(rebuilt, {
      mode: "vector",
      vector: { value: [...firstDocument.embedding], property: "embedding" },
      similarity: -1,
      limit: 1,
    });
    if (!vectorResult.hits.length) throw new Error("Orama snapshot vector round-trip failed");
    const lexicalResult = await searchOrama(rebuilt, {
      term: firstDocument.body,
      properties: ["body"],
      limit: 1,
    });
    if (!lexicalResult.hits.length) throw new Error("Orama snapshot BM25 round-trip failed");
  }
  await probeOramaRemoval();
  return rebuilt;
}

function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw new StructuredError("cancelled", "Index operation cancelled.", true);
}

async function macrotask(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export function validateEnvelope(value: unknown): asserts value is OramaSnapshotEnvelope {
  if (!value || typeof value !== "object") throw new Error("Invalid Orama snapshot envelope");
  const envelope = value as Record<string, unknown>;
  requireKeys(envelope, [
    "schema",
    "format",
    "oramaVersion",
    "fingerprint",
    "dimensions",
    "snapshotRevision",
    "complete",
    "operation",
    "catalog",
    "payload",
  ]);
  if (
    envelope.schema !== ORAMA_SCHEMA_VERSION ||
    envelope.format !== ORAMA_SNAPSHOT_FORMAT ||
    envelope.oramaVersion !== ORAMA_VERSION ||
    typeof envelope.fingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(envelope.fingerprint) ||
    envelope.dimensions !== SNAPSHOT_DIMENSIONS ||
    !Number.isSafeInteger(envelope.snapshotRevision) ||
    (envelope.snapshotRevision as number) < 0 ||
    envelope.complete !== true ||
    (envelope.operation !== "update" &&
      envelope.operation !== "rebuild" &&
      envelope.operation !== "startup")
  )
    throw new Error("Invalid Orama snapshot header");
  validateCatalog(envelope.catalog);
  if (envelope.catalog.fingerprint !== envelope.fingerprint)
    throw new Error("Orama snapshot catalog fingerprint mismatch");
  if (!isJsonValue(envelope.payload)) throw new Error("Invalid Orama snapshot payload");
}

export function validateCatalog(value: unknown): asserts value is OramaCatalog {
  if (!value || typeof value !== "object") throw new Error("Invalid Orama catalog");
  const catalog = value as Record<string, unknown>;
  requireKeys(catalog, ["schema", "fingerprint", "dimensions", "noteCount", "chunkCount", "notes"]);
  if (
    catalog.schema !== ORAMA_SCHEMA_VERSION ||
    typeof catalog.fingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(catalog.fingerprint) ||
    catalog.dimensions !== SNAPSHOT_DIMENSIONS ||
    !Number.isSafeInteger(catalog.noteCount) ||
    (catalog.noteCount as number) < 0 ||
    (catalog.noteCount as number) > SNAPSHOT_MAX_NOTES ||
    !Number.isSafeInteger(catalog.chunkCount) ||
    (catalog.chunkCount as number) < 0 ||
    (catalog.chunkCount as number) > SNAPSHOT_MAX_CHUNKS ||
    !Array.isArray(catalog.notes) ||
    catalog.notes.length !== catalog.noteCount
  )
    throw new Error("Invalid Orama catalog header");
  let priorPath: string | undefined;
  let chunks = 0;
  const ids = new Set<string>();
  for (const rawNote of catalog.notes) {
    if (!rawNote || typeof rawNote !== "object") throw new Error("Invalid Orama catalog note");
    const note = rawNote as Record<string, unknown>;
    requireKeys(note, ["path", "contentId", "chunkCount", "documentIds"]);
    if (
      typeof note.path !== "string" ||
      normalizeIndexPath(note.path) !== note.path ||
      (priorPath !== undefined && compareCodeUnits(note.path, priorPath) <= 0) ||
      typeof note.contentId !== "string" ||
      !/^[0-9a-f]{64}$/.test(note.contentId) ||
      !Number.isSafeInteger(note.chunkCount) ||
      (note.chunkCount as number) < 0 ||
      (note.chunkCount as number) > SNAPSHOT_MAX_CHUNKS ||
      !Array.isArray(note.documentIds) ||
      note.documentIds.length !== note.chunkCount
    )
      throw new Error("Invalid Orama catalog note");
    priorPath = note.path;
    const ordinals = new Set<number>();
    note.documentIds.forEach((rawId, ordinal) => {
      if (typeof rawId !== "string" || ids.has(rawId))
        throw new Error("Invalid Orama catalog document ID");
      const parsed = parseOramaDocumentId(rawId);
      if (parsed.path !== note.path || parsed.ordinal !== ordinal || ordinals.has(parsed.ordinal))
        throw new Error("Invalid Orama catalog document ordinal");
      ordinals.add(parsed.ordinal);
      ids.add(rawId);
    });
    chunks += note.chunkCount as number;
  }
  if (chunks !== catalog.chunkCount) throw new Error("Orama catalog chunk count mismatch");
}

function requireKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    allowed.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  )
    throw new Error("Unknown Orama snapshot field");
}

function canonical(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort(compareCodeUnits)
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  throw new Error("Unsupported JSON value");
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === "object")
    return Object.values(value as Record<string, unknown>).every(isJsonValue);
  return false;
}

function jsonSafe(value: unknown): unknown {
  const raw = JSON.stringify(value);
  if (raw === undefined) throw new Error("Orama save payload is not JSON serializable");
  return JSON.parse(raw) as unknown;
}
