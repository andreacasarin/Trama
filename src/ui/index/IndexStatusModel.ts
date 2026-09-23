import type { IndexProgress, IndexCapabilities, IndexFreshness } from "@/domain/contracts";

export type IndexStatusKind =
  | "loading"
  | "index-required"
  | "ready"
  | "updating"
  | "stale"
  | "building"
  | "preparing"
  | "cancelling"
  | "cancelled"
  | "error"
  | "empty";

export interface IndexStatus {
  readonly kind: IndexStatusKind;
  readonly channel?: "lexical" | "semantic";
  readonly revision: number;
  readonly hasLastGood: boolean;
  readonly progress?: IndexProgress;
  readonly changeCounter?: number;
  readonly etaSeconds?: number;
  readonly message?: string;
  readonly canIndex: boolean;
  readonly canReindex: boolean;
  readonly canPrepare: boolean;
  readonly canCancel: boolean;
  /** Latest orthogonal capability snapshot, independent of the operation kind. */
  readonly capabilities?: IndexCapabilities;
  readonly freshness?: IndexFreshness;
  readonly publicationId?: string;
  readonly publicationWarning?: string;
  /** Current automatic-work detail, independent of lexical readiness. */
  readonly schedulerMessage?: string;
}

const PHASE_LABELS: Record<IndexProgress["phase"], string> = {
  discover: "Finding lexical index notes",
  read: "Estimating lexical index size",
  chunk: "Chunking lexical index",
  embed: "Embedding semantic index chunks",
  "encode-write": "Writing lexical index",
  validate: "Validating lexical index",
  "build-vector": "Updating semantic index",
  "build-lexical": "Preparing lexical index",
  activate: "Activating lexical index",
  GC: "Cleaning up lexical index data",
};

export function formatIndexProgress(progress: IndexProgress, etaSeconds?: number): string {
  const count =
    progress.total === undefined
      ? `${progress.completed} ${progress.unit}`
      : `${progress.completed} of ${progress.estimated ? "about " : ""}${progress.total} ${progress.unit}`;
  const eta =
    etaSeconds === undefined
      ? ""
      : etaSeconds < 60
        ? ` · about ${Math.max(1, Math.ceil(etaSeconds))} sec remaining`
        : ` · about ${Math.ceil(etaSeconds / 60)} min remaining`;
  const label =
    progress.phase === "build-vector" && progress.operation === "full"
      ? "Rebuilding semantic index"
      : PHASE_LABELS[progress.phase];
  return `${label} — ${count}${eta}`;
}
