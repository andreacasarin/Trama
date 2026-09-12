import type { AnyOrama } from "@orama/orama";
import type { OramaDatabaseSnapshot } from "./OramaDatabase";

export const ORAMA_SCHEMA_VERSION = 1 as const;
export const ORAMA_SNAPSHOT_FORMAT = "trama-orama-snapshot-v1" as const;
export const ORAMA_VERSION = "3.1.18" as const;

export interface OramaDocument {
  readonly id: string;
  readonly path: string;
  readonly contentId: string;
  readonly chunkId: string;
  readonly ordinal: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly filename: string;
  readonly pathText: string;
  readonly body: string;
  readonly embedding: readonly number[];
}

export interface OramaCatalogNote {
  readonly path: string;
  readonly contentId: string;
  readonly chunkCount: number;
  readonly documentIds: readonly string[];
}

export interface OramaCatalog {
  readonly schema: typeof ORAMA_SCHEMA_VERSION;
  readonly fingerprint: string;
  readonly dimensions: number;
  readonly noteCount: number;
  readonly chunkCount: number;
  readonly notes: readonly OramaCatalogNote[];
}

export interface OramaSearchHit {
  readonly id: string;
  readonly path: string;
  readonly ordinal: number;
  readonly score: number;
  readonly vector?: readonly number[];
  readonly chunkId?: string;
}

export interface OramaProjectionState {
  readonly revision: number;
  readonly complete: boolean;
  readonly dirty: boolean;
  readonly fingerprint: string;
  readonly dimensions: number;
  readonly catalog: OramaCatalog;
  readonly db: AnyOrama;
  getDocument(id: string): OramaDocument | undefined;
  document(path: string, ordinal: number): OramaDocument | undefined;
  documentsForPath(path: string): readonly OramaDocument[];
}

/** Backwards-readable name for consumers that only need the live projection shape. */
export type OramaSnapshot = OramaProjectionState;

export type SnapshotOperation = "update" | "rebuild" | "startup";

export interface OramaSnapshotEnvelope {
  readonly schema: typeof ORAMA_SCHEMA_VERSION;
  readonly format: typeof ORAMA_SNAPSHOT_FORMAT;
  readonly oramaVersion: typeof ORAMA_VERSION;
  readonly fingerprint: string;
  readonly dimensions: number;
  readonly snapshotRevision: number;
  readonly complete: true;
  readonly operation: SnapshotOperation;
  readonly catalog: OramaCatalog;
  /** Opaque payload produced by the public Orama save API. */
  readonly payload: OramaDatabaseSnapshot["raw"];
}
