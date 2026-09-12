/** Serializable worker protocol. No TalaDB or Obsidian types cross this boundary. */

export type TalaCommand =
  | {
      readonly type: "open";
      readonly namespace: string;
      readonly dimensions: number;
      readonly fingerprint: string;
    }
  | { readonly type: "storage-info" }
  | { readonly type: "schema" }
  | { readonly type: "state" }
  | { readonly type: "rebuild"; readonly notes: readonly TalaNoteInput[]; readonly signal?: never }
  | { readonly type: "reconcile"; readonly note: TalaNoteInput | null; readonly path: string }
  | { readonly type: "delete"; readonly path: string }
  | { readonly type: "validate" }
  | {
      readonly type: "search";
      readonly vector: readonly number[];
      readonly limit?: number;
      readonly excludePath?: string;
    }
  | {
      readonly type: "lexical-search";
      readonly query: string;
      readonly limit?: number;
      readonly excludePath?: string;
    }
  | { readonly type: "hydrate"; readonly rowIds: readonly string[] }
  | {
      readonly type: "related";
      readonly path: string;
      readonly vector: readonly number[];
      readonly limit?: number;
    }
  | { readonly type: "export-checkpoint" }
  | { readonly type: "import-checkpoint"; readonly checkpoint: TalaCheckpoint }
  | { readonly type: "quiesce" }
  | { readonly type: "close" };

export interface TalaNoteInput {
  readonly path: string;
  readonly content: string;
  readonly contentId?: string;
  readonly revision?: string;
  readonly chunks?: readonly TalaChunkInput[];
}

export interface TalaChunkInput {
  readonly ordinal: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
  readonly vector: readonly number[];
  readonly rowId?: string;
  readonly canonicalId?: string;
}

export interface TalaSearchHit {
  readonly rowId: string;
  readonly canonicalId: string;
  readonly path: string;
  readonly ordinal: number;
  readonly score: number;
}

export interface TalaHydratedChunk extends TalaSearchHit {
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
  readonly vector?: readonly number[];
}

export interface TalaState {
  readonly status: "ready" | "dirty";
  readonly syncNeeded: boolean;
  readonly operation: "idle" | "rebuilding" | "syncing" | "validating";
  readonly revision: number;
  readonly fingerprint: string;
  readonly dimensions: number;
}

export interface TalaStorageInfo {
  readonly storage: "injected" | "memory" | "opfs" | "indexeddb";
  readonly durableWrites: boolean;
  readonly owner: boolean;
}

export interface TalaSchemaInfo {
  readonly version: 1;
  readonly dimensions: number;
  readonly collections: readonly string[];
  readonly indexes: Readonly<Record<string, readonly string[]>>;
}

export interface TalaCheckpoint {
  readonly version: 1;
  readonly namespace: string;
  readonly state: TalaState;
  readonly notes: readonly TalaNoteInput[];
}

export interface TalaResponseMap {
  open: { readonly state: TalaState };
  "storage-info": TalaStorageInfo;
  schema: TalaSchemaInfo;
  state: TalaState;
  rebuild: TalaState;
  reconcile: TalaState;
  delete: TalaState;
  validate: TalaState;
  search: readonly TalaSearchHit[];
  "lexical-search": readonly TalaSearchHit[];
  hydrate: readonly TalaHydratedChunk[];
  related: readonly TalaSearchHit[];
  "export-checkpoint": TalaCheckpoint;
  "import-checkpoint": TalaState;
  quiesce: { readonly quiesced: true };
  close: { readonly closed: true };
}

export type TalaRequestId = string;
export interface TalaRequest<T extends TalaCommand = TalaCommand> {
  readonly id: TalaRequestId;
  readonly command: T;
}

export interface TalaSerializedError {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly retryable?: boolean;
}

export type TalaResponse<T extends TalaCommand = TalaCommand> =
  | { readonly id: TalaRequestId; readonly ok: true; readonly value: TalaResponseMap[T["type"]] }
  | { readonly id: TalaRequestId; readonly ok: false; readonly error: TalaSerializedError };

export function serializeError(error: unknown): TalaSerializedError {
  if (error && typeof error === "object") {
    const candidate = error as {
      name?: unknown;
      message?: unknown;
      code?: unknown;
      retryable?: unknown;
    };
    return {
      name: typeof candidate.name === "string" ? candidate.name : "Error",
      message: typeof candidate.message === "string" ? candidate.message : String(error),
      ...(typeof candidate.code === "string" ? { code: candidate.code } : {}),
      ...(typeof candidate.retryable === "boolean" ? { retryable: candidate.retryable } : {}),
    };
  }
  return { name: "Error", message: String(error) };
}

export class TalaWorkerError extends Error {
  readonly code?: string;
  readonly retryable?: boolean;
  constructor(error: TalaSerializedError) {
    super(error.message);
    this.name = error.name;
    this.code = error.code;
    this.retryable = error.retryable;
  }
}

export type TalaTransport = <T extends TalaCommand>(
  request: TalaRequest<T>
) => Promise<TalaResponse<T>>;
