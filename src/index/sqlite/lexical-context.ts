import type { SqliteNoteSummary } from "./protocol";

export interface LexicalRunState {
  readonly runId: string;
  readonly expected?: readonly SqliteNoteSummary[];
  readonly renames: readonly { from: string; to: string; contentId: string }[];
  readonly deletes: SqliteNoteSummary[];
  readonly scoped: boolean;
  readonly mayClearIncomplete: boolean;
  changeCounter: number;
  renamesApplied: boolean;
}

export interface LexicalRevisionApplyResult {
  readonly changed: number;
  readonly skipped: number;
  readonly occurrences: number;
  readonly renamed: number;
  readonly semanticChanged: number;
}

export class LexicalRunRegistry {
  private sequence = 0;
  readonly runs = new Map<string, LexicalRunState>();

  nextRunId(): string {
    return `lexical-${++this.sequence}`;
  }
}
