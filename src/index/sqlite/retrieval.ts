import { SQLITE_MAX_RESULTS, type SqliteHit } from "./protocol";
import { sqliteError } from "./protocol";
import {
  EMBEDDING_PREPROCESSING_VERSION,
  normalizedVector,
  rows,
  type SqliteContext,
  vectorOf,
} from "./core";

const RRF_K = 60;

export class SqliteRetrieval {
  constructor(
    private readonly context: SqliteContext,
    private readonly onPhase?: (
      phase: "semanticCandidates" | "lexicalCandidates" | "fusion" | "centroid",
      durationMs: number,
      itemCount: number
    ) => void,
    private readonly phaseEnabled?: () => boolean
  ) {}

  private startPhase(): (() => number) | undefined {
    if (!this.phaseEnabled?.()) return undefined;
    const started = performance.now();
    return () => Math.max(0, performance.now() - started);
  }

  private finishPhase(
    phase: "semanticCandidates" | "lexicalCandidates" | "fusion" | "centroid",
    timer: (() => number) | undefined,
    itemCount: number
  ): void {
    if (!timer) return;
    try {
      this.onPhase?.(phase, timer(), itemCount);
    } catch {
      /* Observation only. */
    }
  }

  /** Revision-head retrieval. Vectors are read only for active semantic heads.
   * This deliberately uses a scalar cosine pass: vector_full_scan applies its
   * LIMIT before a join can exclude inactive cache rows on some packaged builds.
   */
  private retrieveRevisionHeads(
    query: string | undefined,
    vector: Float32Array | undefined,
    limit: number,
    currentPath: string | undefined,
    options: {
      readonly semanticCandidateLimit?: number;
      readonly lexicalCandidateLimit?: number;
      readonly lexicalProfile?: "voce" | "lente";
      readonly resultShape?: "chunks" | "notes";
    }
  ): readonly SqliteHit[] {
    const noteShape = options.resultShape === "notes" || options.lexicalProfile === "lente";
    const semanticLimit = Math.min(
      SQLITE_MAX_RESULTS,
      Math.max(0, options.semanticCandidateLimit ?? limit)
    );
    const lexicalLimit = Math.min(
      SQLITE_MAX_RESULTS,
      Math.max(0, options.lexicalCandidateLimit ?? limit)
    );
    const semantic: SqliteHit[] = [];
    const semanticTimer = this.startPhase();
    if (vector && semanticLimit) {
      const q = normalizedVector(vector, this.context.dimensions);
      const current = currentPath
        ? rows(this.context.db, "SELECT note_id FROM notes WHERE path=?", [currentPath])[0]
        : undefined;
      const bind: unknown[] = [];
      let sql = `SELECT o.occurrence_id AS occurrenceId,o.chunk_id AS id,o.ordinal,o.start_line AS startLine,o.end_line AS endLine,
                        o.display_text AS text,r.content_id AS contentId,n.note_id AS noteId,n.path,ec.vector
                 FROM chunk_occurrences o JOIN notes n ON n.note_id=o.note_id AND n.semantic_revision_id=o.revision_id
                 JOIN note_revisions r ON r.revision_id=o.revision_id
                 JOIN embedding_inputs ei ON ei.action_key=o.embedding_input_digest
                 JOIN embedding_cache ec ON ec.input_digest=ei.action_key
                    AND ec.embedding_fingerprint=? AND ec.preprocessing=?`;
      bind.push(this.context.embeddingFingerprint, EMBEDDING_PREPROCESSING_VERSION);
      if (current) {
        sql += " WHERE n.note_id<>?";
        bind.push(Number(current.note_id));
      }
      const candidates = rows(this.context.db, sql, bind).map((row) => {
        const x = vectorOf(row.vector);
        let score = 0;
        for (let i = 0; i < q.length; i++) score += q[i] * x[i];
        return { row, score };
      });
      candidates.sort(
        (a, b) =>
          b.score - a.score ||
          compareCodeUnits(String(a.row.path), String(b.row.path)) ||
          Number(a.row.ordinal) - Number(b.row.ordinal) ||
          compareCodeUnits(String(a.row.id), String(b.row.id))
      );
      const seen = new Set<string>();
      for (const item of candidates) {
        const path = String(item.row.path);
        if (noteShape && seen.has(path)) continue;
        seen.add(path);
        semantic.push({
          id: String(item.row.id),
          path,
          contentId: String(item.row.contentId),
          ordinal: Number(item.row.ordinal),
          score: item.score,
          semanticScore: item.score,
          text: String(item.row.text),
          startLine: Number(item.row.startLine),
          endLine: Number(item.row.endLine),
        });
        if (semantic.length >= semanticLimit) break;
      }
    }
    this.finishPhase("semanticCandidates", semanticTimer, semantic.length);
    const lexical: SqliteHit[] = [];
    const lexicalTimer = this.startPhase();
    const expression = query
      ? [...new Set(literalTerms(query))]
          .slice(0, 64)
          .map((term) => `"${term.replace(/"/g, '""')}"`)
          .join(" OR ")
      : "";
    if (expression && lexicalLimit) {
      const scoped = options.lexicalProfile === "voce" ? `body:(${expression})` : expression;
      const bind: unknown[] = [scoped];
      let sql = `SELECT o.chunk_id AS id,o.ordinal,o.start_line AS startLine,o.end_line AS endLine,o.display_text AS text,
                        r.content_id AS contentId,n.path,n.note_id,bm25(active_lexical_fts,1,2,3) AS rank
                 FROM active_lexical_fts f JOIN active_lexical a ON a.occurrence_id=f.rowid
                 JOIN chunk_occurrences o ON o.occurrence_id=a.occurrence_id JOIN notes n ON n.note_id=a.note_id
                 JOIN note_revisions r ON r.revision_id=a.revision_id
                 WHERE active_lexical_fts MATCH ?`;
      if (currentPath) {
        sql += " AND n.path<>?";
        bind.push(currentPath);
      }
      const raw = rows(this.context.db, sql, bind);
      raw.sort(
        (a, b) =>
          Number(a.rank) - Number(b.rank) ||
          compareCodeUnits(String(a.path), String(b.path)) ||
          Number(a.ordinal) - Number(b.ordinal) ||
          compareCodeUnits(String(a.id), String(b.id))
      );
      const minRank = Number(raw[0]?.rank ?? 0);
      const seen = new Set<string>();
      for (const row of raw) {
        const path = String(row.path);
        if (noteShape && seen.has(path)) continue;
        seen.add(path);
        const rank = Number(row.rank);
        const score = minRank < 0 ? rank / minRank : (1 + minRank) / (1 + rank);
        lexical.push({
          id: String(row.id),
          path,
          contentId: String(row.contentId),
          ordinal: Number(row.ordinal),
          score,
          lexicalScore: score,
          text: String(row.text),
          startLine: Number(row.startLine),
          endLine: Number(row.endLine),
        });
        if (lexical.length >= lexicalLimit) break;
      }
    }
    this.finishPhase("lexicalCandidates", lexicalTimer, lexical.length);
    if (!semantic.length) return lexical.slice(0, limit);
    if (!lexical.length) return semantic.slice(0, limit);
    const fusionTimer = this.startPhase();
    const fused = new Map<string, SqliteHit & { fused: number; rank: number }>();
    semantic.forEach((h, i) => {
      const fusedScore = 1 / (RRF_K + i + 1);
      fused.set(noteShape ? h.path : h.id, { ...h, fused: fusedScore, fusedScore, rank: i });
    });
    lexical.forEach((h, i) => {
      const key = noteShape ? h.path : h.id;
      const prior = fused.get(key);
      const add = 1 / (RRF_K + i + 1);
      if (prior)
        fused.set(key, {
          ...prior,
          fused: prior.fused + add,
          fusedScore: prior.fused + add,
          lexicalScore: h.lexicalScore,
        });
      else fused.set(key, { ...h, fused: add, rank: i, fusedScore: add });
    });
    const result = [...fused.values()]
      .sort(
        (a, b) =>
          b.fused - a.fused ||
          compareCodeUnits(a.path, b.path) ||
          a.ordinal - b.ordinal ||
          compareCodeUnits(a.id, b.id)
      )
      .slice(0, limit);
    this.finishPhase("fusion", fusionTimer, result.length);
    return result;
  }

  retrieve(
    query: string | undefined,
    vector: Float32Array | undefined,
    limit: number,
    currentPath?: string,
    options: {
      readonly semanticCandidateLimit?: number;
      readonly lexicalCandidateLimit?: number;
      readonly lexicalProfile?: "voce" | "lente";
      readonly resultShape?: "chunks" | "notes";
    } = {}
  ): readonly SqliteHit[] {
    this.context.ensureOpen();
    const resultLimit = Math.min(SQLITE_MAX_RESULTS, Math.max(0, limit));
    if (!resultLimit) return [];
    return this.retrieveRevisionHeads(query, vector, resultLimit, currentPath, options);
  }
  findRelated(path: string, vector: Float32Array | undefined, limit: number): readonly SqliteHit[] {
    let q = vector;
    if (!q) {
      const centroidTimer = this.startPhase();
      const sum = new Float64Array(this.context.dimensions);
      let count = 0;
      this.context.db.exec({
        sql: `SELECT ec.vector FROM chunk_occurrences o JOIN notes n ON n.note_id=o.note_id AND n.semantic_revision_id=o.revision_id
              JOIN embedding_inputs ei ON ei.action_key=o.embedding_input_digest
              JOIN embedding_cache ec ON ec.input_digest=ei.action_key AND ec.embedding_fingerprint=? AND ec.preprocessing=?
              WHERE n.path=? ORDER BY o.ordinal,o.occurrence_id`,
        bind: [this.context.embeddingFingerprint, EMBEDDING_PREPROCESSING_VERSION, path],
        rowMode: "object",
        callback: (row) => {
          const x = vectorOf(row.vector);
          if (x.length !== sum.length)
            throw sqliteError("integrity_failed", "Stored vector dimensions mismatch");
          for (let i = 0; i < x.length; i++) sum[i] += x[i];
          count++;
        },
      });
      if (!count) return [];
      let norm = 0;
      for (const x of sum) norm += x * x;
      if (!(norm > 0)) return [];
      q = new Float32Array(sum.length);
      for (let i = 0; i < q.length; i++) q[i] = sum[i] / Math.sqrt(norm);
      this.finishPhase("centroid", centroidTimer, count);
    }
    return this.retrieve(undefined, q, limit, path, {
      semanticCandidateLimit: Math.min(128, Math.max(limit, 1)),
      resultShape: "notes",
    });
  }
}

export function literalTerms(query: string): readonly string[] {
  return (
    query
      .normalize("NFKC")
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}_-]+/gu)
      ?.slice(0, 64) ?? []
  );
}

function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
