import {
  count,
  create,
  getByID,
  insert,
  insertMultiple,
  load,
  remove,
  removeMultiple,
  save,
  search,
  type AnyDocument,
  type AnyOrama,
} from "@orama/orama";
import { oramaDocumentId, parseOramaDocumentId } from "@/index/Identity";
import type { OramaDocument, OramaSearchHit } from "./OramaTypes";

export interface OramaRawResult {
  readonly id: string;
  readonly score: number;
  readonly document: AnyDocument;
}

export interface OramaRawLike {
  readonly document: unknown;
}

export interface OramaRawResults {
  readonly count: number;
  readonly hits: readonly OramaRawResult[];
  readonly elapsed?: unknown;
}

export interface OramaDatabaseSnapshot {
  readonly raw: unknown;
}

export const ORAMA_INSERT_BATCH_SIZE = 64;
const PROBE_CONTENT_ID = "0".repeat(64);
/** Maximum unit-length drift tolerated after Float32-safe vector round-tripping. */
export const ORAMA_VECTOR_NORM_TOLERANCE = 1e-3;
const ORAMA_VECTOR_MIN_NORM = 1e-12;
let removalStrategyPromise: Promise<"multiple" | "sequential"> | undefined;

function vectorSchema(dimensions: number): Record<string, string> {
  if (!Number.isSafeInteger(dimensions) || dimensions < 1)
    throw new Error("Invalid vector dimensions");
  return {
    path: "string",
    contentId: "string",
    chunkId: "string",
    ordinal: "number",
    startLine: "number",
    endLine: "number",
    filename: "string",
    pathText: "string",
    body: "string",
    embedding: `vector[${dimensions}]`,
  };
}

export async function createOramaDatabase(dimensions: number): Promise<AnyOrama> {
  return create({ schema: vectorSchema(dimensions) as never }) as AnyOrama;
}

export async function insertOramaDocuments(
  db: AnyOrama,
  documents: readonly OramaDocument[],
  batchSize = ORAMA_INSERT_BATCH_SIZE
): Promise<void> {
  if (!documents.length) return;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1)
    throw new Error("Invalid Orama batch size");
  for (let offset = 0; offset < documents.length; offset += batchSize) {
    const batch = documents.slice(offset, offset + batchSize);
    await insertMultiple(db, batch.map((document) => ({ ...document })) as never[], batch.length);
    if (offset + batchSize < documents.length) await macrotask();
  }
}

export function getOramaDocument(db: AnyOrama, id: string): OramaDocument | undefined {
  const document = getByID(db, id) as unknown as OramaDocument | undefined;
  return document ? normalizeDocument(document) : undefined;
}

export function hasOramaDocument(db: AnyOrama, id: string): boolean {
  return getByID(db, id) !== undefined;
}

export function countOramaDocuments(db: AnyOrama): number {
  return count(db);
}

export function saveOramaDatabase(db: AnyOrama): OramaDatabaseSnapshot {
  return { raw: save(db) };
}

export async function loadOramaDatabase(
  dimensions: number,
  snapshot: OramaDatabaseSnapshot
): Promise<AnyOrama> {
  const db = await createOramaDatabase(dimensions);
  load(db, snapshot.raw as never);
  return db;
}

/** The only search boundary: every public search includes vectors. */
export async function searchOrama(
  db: AnyOrama,
  params: Record<string, unknown>
): Promise<OramaRawResults> {
  const result = await search(db, { ...params, includeVectors: true } as never);
  return result as unknown as OramaRawResults;
}

export function mapOramaHit(result: OramaRawResult): OramaSearchHit {
  const document = validateOramaDocument(result.document as unknown as OramaDocument);
  return {
    id: result.id,
    path: document.path,
    ordinal: document.ordinal,
    score: Number.isFinite(result.score) ? result.score : 0,
    chunkId: document.chunkId,
    vector: Object.freeze([...document.embedding]),
  };
}

/** Probe removeMultiple and a public save/load round trip once per process. */
export async function probeOramaRemoval(): Promise<"multiple" | "sequential"> {
  if (!removalStrategyPromise) {
    removalStrategyPromise = (async () => {
      const db = await createOramaDatabase(1);
      const document: OramaDocument = {
        id: oramaDocumentId("probe.md", 0),
        path: "probe.md",
        contentId: PROBE_CONTENT_ID,
        chunkId: `${PROBE_CONTENT_ID}:0`,
        ordinal: 0,
        startLine: 1,
        endLine: 1,
        filename: "probe.md",
        pathText: "probe.md",
        body: "probe",
        embedding: [1],
      };
      try {
        await insert(db, document as never);
        await removeMultiple(db, [document.id]);
        await macrotask();
        if (count(db) !== 0 || getByID(db, document.id) !== undefined)
          throw new Error("removeMultiple did not remove");
        await insert(db, document as never);
        const saved = saveOramaDatabase(db);
        const fresh = await loadOramaDatabase(1, saved);
        if (count(fresh) !== 1 || getByID(fresh, document.id) === undefined)
          throw new Error("removeMultiple save/load probe failed");
        return "multiple";
      } catch {
        const fallback = await createOramaDatabase(1);
        await insert(fallback, document as never);
        await remove(fallback, document.id);
        await macrotask();
        if (count(fallback) !== 0) throw new Error("Orama public document removal is unavailable");
        return "sequential";
      }
    })();
  }
  return removalStrategyPromise;
}

export async function removeOramaDocuments(db: AnyOrama, ids: readonly string[]): Promise<void> {
  if (!ids.length) return;
  const strategy = await probeOramaRemoval();
  if (strategy === "multiple") {
    try {
      await removeMultiple(db, [...ids]);
      await macrotask();
      if (ids.some((id) => getByID(db, id) !== undefined))
        throw new Error("removeMultiple incomplete");
      return;
    } catch {
      // A loaded database can still require the public sequential fallback.
    }
  }
  for (const id of ids) {
    if (getByID(db, id) === undefined) continue;
    await remove(db, id);
    await macrotask();
    if (getByID(db, id) !== undefined) throw new Error("Orama document removal failed");
  }
}

export function validateOramaDocument(document: OramaDocument, dimensions?: number): OramaDocument {
  if (
    !document ||
    typeof document.id !== "string" ||
    typeof document.path !== "string" ||
    typeof document.contentId !== "string" ||
    !/^[0-9a-f]{64}$/.test(document.contentId) ||
    typeof document.chunkId !== "string" ||
    !Number.isSafeInteger(document.ordinal) ||
    document.ordinal < 0 ||
    document.chunkId !== `${document.contentId}:${document.ordinal}` ||
    !Number.isSafeInteger(document.startLine) ||
    document.startLine < 1 ||
    !Number.isSafeInteger(document.endLine) ||
    document.endLine < document.startLine ||
    typeof document.filename !== "string" ||
    typeof document.pathText !== "string" ||
    document.pathText !== document.path ||
    typeof document.body !== "string" ||
    !Array.isArray(document.embedding) ||
    (dimensions !== undefined && document.embedding.length !== dimensions) ||
    document.embedding.some((value) => typeof value !== "number" || !Number.isFinite(value)) ||
    !isUnitVector(document.embedding)
  )
    throw new Error("Invalid Orama document");
  const parsed = parseOramaDocumentId(document.id);
  if (parsed.path !== document.path || parsed.ordinal !== document.ordinal)
    throw new Error("Orama document identity mismatch");
  if (document.filename !== document.path.slice(document.path.lastIndexOf("/") + 1))
    throw new Error("Orama document filename mismatch");
  return document;
}

function isUnitVector(vector: readonly number[]): boolean {
  let normSquared = 0;
  for (const value of vector) normSquared += value * value;
  const norm = Math.sqrt(normSquared);
  return norm > ORAMA_VECTOR_MIN_NORM && Math.abs(norm - 1) <= ORAMA_VECTOR_NORM_TOLERANCE;
}

function normalizeDocument(document: OramaDocument): OramaDocument {
  validateOramaDocument(document);
  return { ...document, embedding: Object.freeze([...document.embedding]) };
}

async function macrotask(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
