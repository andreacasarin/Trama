import { normalizeVaultPath } from "@/index/Identity";
import type { SqliteState } from "@/index/sqlite/protocol";
import type { IndexJournalSnapshot, IndexPathMutation } from "./contracts";

function coalescePathMutation(changes: IndexPathMutation[], mutation: IndexPathMutation): void {
  const previous = changes[changes.length - 1];
  if (mutation.type === "rename") {
    if (previous?.type === "rename" && previous.to === mutation.from) {
      changes[changes.length - 1] = { type: "rename", from: previous.from, to: mutation.to };
      return;
    }
    if (previous?.type === "upsert" && previous.path === mutation.from) {
      changes[changes.length - 1] = { type: "delete", path: mutation.from };
      changes.push({ type: "upsert", path: mutation.to });
      return;
    }
    if (previous?.type === "delete" && previous.path === mutation.from) {
      changes.push({ type: "upsert", path: mutation.to });
      return;
    }
    changes.push(mutation);
    return;
  }
  const path = mutation.path;
  if (mutation.type === "upsert") {
    if (previous?.type === "upsert" && previous.path === path) return;
    if (previous?.type === "delete" && previous.path === path) {
      changes[changes.length - 1] = mutation;
      return;
    }
    changes.push(mutation);
    return;
  }
  if (previous?.type === "delete" && previous.path === path) return;
  if (previous?.type === "rename" && previous.to === path) {
    changes[changes.length - 1] = { type: "delete", path: previous.from };
    return;
  }
  if (previous?.type === "upsert" && previous.path === path) {
    changes[changes.length - 1] = mutation;
    return;
  }
  changes.push(mutation);
}

export class IndexJournal {
  revision = 0;
  reconciledRevision = 0;
  readonly changes: IndexPathMutation[] = [];
  fullRecoveryRequested = false;

  record(mutation: IndexPathMutation): void {
    const wasFullRecoveryRequested = this.fullRecoveryRequested;
    this.markDirty();
    this.fullRecoveryRequested = wasFullRecoveryRequested;
    if (mutation.type === "rename")
      coalescePathMutation(this.changes, {
        type: "rename",
        from: normalizeVaultPath(mutation.from),
        to: normalizeVaultPath(mutation.to),
      });
    else
      coalescePathMutation(this.changes, {
        type: mutation.type,
        path: normalizeVaultPath(mutation.path),
      });
  }

  requestFullRecovery(): void {
    this.markDirty();
    this.fullRecoveryRequested = true;
  }

  hasPendingWork(state: SqliteState | undefined): boolean {
    return Boolean(
      this.fullRecoveryRequested ||
      this.changes.length ||
      this.revision !== this.reconciledRevision ||
      state?.incomplete
    );
  }

  snapshot(): IndexJournalSnapshot {
    return {
      changes: this.changes.map((change) => ({ ...change })),
      fullRecovery: this.fullRecoveryRequested,
      revision: this.revision,
    };
  }

  clearIfCurrent(revision: number): void {
    if (revision !== this.revision) return;
    this.clear(revision);
  }

  clear(revision: number): void {
    this.changes.length = 0;
    this.fullRecoveryRequested = false;
    this.reconciledRevision = revision;
  }

  private markDirty(): void {
    this.revision++;
    this.fullRecoveryRequested = true;
  }
}
