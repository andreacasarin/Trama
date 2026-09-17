import type { IndexChannelStatus } from "@/domain/contracts";
import type { SqliteState } from "@/index/sqlite/protocol";

export interface IndexChannel {
  readonly kind: "lexical" | "semantic";
  status(state: SqliteState | undefined, available: boolean, updating: boolean): IndexChannelStatus;
}

export const lexicalIndex: IndexChannel = {
  kind: "lexical",
  status(state, available, updating) {
    const activity = updating ? "updating" : "idle";
    if (!available || !state) return { state: "unavailable", activity, searchable: false };
    if (state.incomplete) return { state: "partial", activity, searchable: state.noteCount > 0 };
    if (state.noteCount === 0) return { state: "empty", activity, searchable: false };
    return { state: "ready", activity, searchable: true };
  },
};

export const semanticIndex: IndexChannel = {
  kind: "semantic",
  status(state, available, updating) {
    const activity = updating ? "updating" : "idle";
    if (!available || !state) return { state: "unavailable", activity, searchable: false };
    if (state.vectorCount === 0) return { state: "empty", activity, searchable: false };
    if (state.compatibleVectorCount === 0)
      return { state: "incompatible", activity, searchable: false };
    if (state.incomplete || state.vectorCoverage === "partial")
      return { state: "partial", activity, searchable: true };
    return state.semanticReady
      ? { state: "ready", activity, searchable: true }
      : { state: "partial", activity, searchable: false };
  },
};
