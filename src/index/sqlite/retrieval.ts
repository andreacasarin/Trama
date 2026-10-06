import { SQLITE_MAX_RESULTS, type SqliteHit } from "./protocol";
import { sqliteError } from "./protocol";
import {
  EMBEDDING_PREPROCESSING_VERSION,
  normalizedVector,
  rows,
  SQLITE_VECTOR_NORMALIZATION_TOLERANCE,
  type SqliteContext,
  vectorOf,
} from "./core";

const RRF_K = 60;
const RELATED_PROBE_COUNT = 3;
const RELATED_NOTES_PER_PROBE = 32;
const RELATED_VECTOR_TILE_SIZE = 16;

interface SemanticCandidate {
  readonly occurrenceId: number;
  readonly id: string;
  readonly path: string;
  readonly ordinal: number;
  readonly score: number;
}

interface RelatedPassageRef {
  readonly occurrenceId: number;
  readonly id: string;
  readonly path: string;
  readonly ordinal: number;
  readonly inputDigest: string;
}

interface RelatedPassage extends RelatedPassageRef {
  readonly vector: Float32Array;
}

function comparePassageRefs(left: RelatedPassageRef, right: RelatedPassageRef): number {
  return left.ordinal - right.ordinal || compareCodeUnits(left.id, right.id);
}

function normalizedDot(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length)
    throw sqliteError("integrity_failed", "Stored vector dimensions mismatch");
  let score = 0;
  for (let index = 0; index < left.length; index++) score += left[index] * right[index];
  return score;
}

function offerTopTwo(value: number, best: number[]): void {
  if (value > best[0]) {
    best[1] = best[0];
    best[0] = value;
  } else if (value > best[1]) best[1] = value;
}

function compareSemanticCandidates(left: SemanticCandidate, right: SemanticCandidate): number {
  return (
    right.score - left.score ||
    compareCodeUnits(left.path, right.path) ||
    left.ordinal - right.ordinal ||
    compareCodeUnits(left.id, right.id)
  );
}

/** Keep a bounded heap whose root is the worst retained candidate. */
function offerTopK<T>(
  heap: T[],
  candidate: T,
  limit: number,
  compare: (left: T, right: T) => number
): void {
  if (heap.length < limit) {
    let index = heap.length;
    heap.push(candidate);
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compare(heap[index], heap[parent]) <= 0) break;
      [heap[index], heap[parent]] = [heap[parent], heap[index]];
      index = parent;
    }
    return;
  }
  if (!limit || compare(candidate, heap[0]) >= 0) return;
  heap[0] = candidate;
  let index = 0;
  for (;;) {
    const left = index * 2 + 1;
    const right = left + 1;
    let worst = index;
    if (left < heap.length && compare(heap[left], heap[worst]) > 0) worst = left;
    if (right < heap.length && compare(heap[right], heap[worst]) > 0) worst = right;
    if (worst === index) return;
    [heap[index], heap[worst]] = [heap[worst], heap[index]];
    index = worst;
  }
}

export class SqliteRetrieval {
  constructor(
    private readonly context: SqliteContext,
    private readonly onPhase?: (
      phase:
        | "semanticCandidates"
        | "lexicalCandidates"
        | "fusion"
        | "centroid"
        | "relatedCandidates"
        | "relatedRerank",
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
    phase:
      | "semanticCandidates"
      | "lexicalCandidates"
      | "fusion"
      | "centroid"
      | "relatedCandidates"
      | "relatedRerank",
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

  private relatedPassageCte(
    path?: string,
    excludePath?: string
  ): {
    readonly sql: string;
    readonly bind: readonly unknown[];
  } {
    const pathFilter = path ? "AND n.path=?" : excludePath ? "AND n.path<>?" : "";
    // Keep note/occurrence filters ahead of cache lookups. SQLite otherwise starts
    // with every vector in the profile even for a single note or a 16-row tile.
    return {
      sql: `WITH compatible_occurrences AS (
        SELECT o.occurrence_id AS occurrenceId,o.note_id AS noteId,n.path,o.chunk_id AS id,o.ordinal,
               o.embedding_input_digest AS inputDigest,
               ROW_NUMBER() OVER (
                 PARTITION BY o.note_id,o.embedding_input_digest ORDER BY o.ordinal,o.chunk_id COLLATE BINARY
               ) AS duplicateRank
        FROM notes n
        CROSS JOIN chunk_occurrences o ON n.note_id=o.note_id AND n.semantic_revision_id=o.revision_id
        CROSS JOIN embedding_cache ec INDEXED BY embedding_cache_lookup ON ec.input_digest=o.embedding_input_digest
          AND ec.embedding_fingerprint=? AND ec.preprocessing=? AND ec.task_kind='document'
        WHERE 1=1 ${pathFilter}
      ), related_passages AS (
        SELECT occurrenceId,noteId,path,id,ordinal,inputDigest
        FROM compatible_occurrences WHERE duplicateRank=1
      )`,
      bind: [
        this.context.embeddingFingerprint,
        EMBEDDING_PREPROCESSING_VERSION,
        ...(path ? [path] : excludePath ? [excludePath] : []),
      ],
    };
  }

  private relatedPassageRefs(path: string): RelatedPassageRef[] {
    const query = this.relatedPassageCte(path);
    return rows(
      this.context.db,
      `${query.sql} SELECT occurrenceId,id,path,ordinal,inputDigest FROM related_passages
       ORDER BY ordinal,id COLLATE BINARY`,
      query.bind
    ).map((row) => ({
      occurrenceId: Number(row.occurrenceId),
      id: String(row.id),
      path: String(row.path),
      ordinal: Number(row.ordinal),
      inputDigest: String(row.inputDigest),
    }));
  }

  private relatedVectors(refs: readonly RelatedPassageRef[]): Float32Array[] {
    if (!refs.length) return [];
    const rowsById = rows(
      this.context.db,
      `SELECT o.occurrence_id AS occurrenceId,ec.vector
       FROM chunk_occurrences o CROSS JOIN notes n ON n.note_id=o.note_id AND n.semantic_revision_id=o.revision_id
       CROSS JOIN embedding_cache ec INDEXED BY embedding_cache_lookup ON ec.input_digest=o.embedding_input_digest
         AND ec.embedding_fingerprint=? AND ec.preprocessing=? AND ec.task_kind='document'
       WHERE o.occurrence_id IN (${refs.map(() => "?").join(",")})`,
      [
        this.context.embeddingFingerprint,
        EMBEDDING_PREPROCESSING_VERSION,
        ...refs.map(({ occurrenceId }) => occurrenceId),
      ]
    );
    const vectors = new Map(
      rowsById.map((row) => [Number(row.occurrenceId), this.relatedVector(row.vector)])
    );
    return refs.map(({ occurrenceId }) => {
      const vector = vectors.get(occurrenceId);
      if (!vector) throw sqliteError("integrity_failed", "Compatible semantic passage disappeared");
      return vector;
    });
  }

  private scanRelatedPassages(
    path: string | undefined,
    excludePath: string | undefined,
    callback: (passage: RelatedPassage) => void
  ): void {
    const query = this.relatedPassageCte(path, excludePath);
    this.context.db.exec({
      sql: `${query.sql}
        SELECT p.occurrenceId,p.id,p.path,p.ordinal,p.inputDigest,ec.vector
        FROM related_passages p
        CROSS JOIN embedding_cache ec INDEXED BY embedding_cache_lookup ON ec.input_digest=p.inputDigest
          AND ec.embedding_fingerprint=? AND ec.preprocessing=? AND ec.task_kind='document'
        ORDER BY p.path COLLATE BINARY,p.ordinal,p.id COLLATE BINARY`,
      bind: [...query.bind, this.context.embeddingFingerprint, EMBEDDING_PREPROCESSING_VERSION],
      rowMode: "object",
      callback: (row) => callback(this.relatedPassageFromRow(row)),
    });
  }

  private relatedPassageFromRow(row: Record<string, unknown>): RelatedPassage {
    return {
      occurrenceId: Number(row.occurrenceId),
      id: String(row.id),
      path: String(row.path),
      ordinal: Number(row.ordinal),
      inputDigest: String(row.inputDigest),
      vector: this.relatedVector(row.vector),
    };
  }

  private relatedVector(value: unknown): Float32Array {
    const vector = vectorOf(value);
    if (vector.length !== this.context.dimensions || !vector.every(Number.isFinite))
      throw sqliteError("integrity_failed", "Stored vector dimensions mismatch");
    let norm = 0;
    for (const item of vector) norm += item * item;
    if (Math.abs(norm - 1) > SQLITE_VECTOR_NORMALIZATION_TOLERANCE)
      throw sqliteError("integrity_failed", "Stored semantic vector is not normalized");
    return vector;
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
      const bind: unknown[] = [];
      let sql = `SELECT o.occurrence_id AS occurrenceId,o.chunk_id AS id,o.ordinal,n.path,ec.vector
                 FROM chunk_occurrences o JOIN notes n ON n.note_id=o.note_id AND n.semantic_revision_id=o.revision_id
                 JOIN embedding_inputs ei ON ei.action_key=o.embedding_input_digest
                 JOIN embedding_cache ec ON ec.input_digest=ei.action_key
                    AND ec.embedding_fingerprint=? AND ec.preprocessing=? AND ec.task_kind='document'`;
      bind.push(this.context.embeddingFingerprint, EMBEDDING_PREPROCESSING_VERSION);
      if (currentPath) {
        sql += " WHERE n.path<>?";
        bind.push(currentPath);
      }
      const top: SemanticCandidate[] = [];
      const bestByPath = new Map<string, SemanticCandidate>();
      this.context.db.exec({
        sql,
        bind,
        rowMode: "object",
        callback: (row) => {
          const x = vectorOf(row.vector);
          let score = 0;
          for (let i = 0; i < q.length; i++) score += q[i] * x[i];
          const candidate = {
            occurrenceId: Number(row.occurrenceId),
            id: String(row.id),
            path: String(row.path),
            ordinal: Number(row.ordinal),
            score,
          };
          const prior = bestByPath.get(candidate.path);
          if (!prior || compareSemanticCandidates(candidate, prior) < 0)
            bestByPath.set(candidate.path, candidate);
        },
      });
      for (const candidate of bestByPath.values())
        offerTopK(top, candidate, semanticLimit, compareSemanticCandidates);
      top.sort(compareSemanticCandidates);
      if (top.length) {
        const selected = rows(
          this.context.db,
          `SELECT o.occurrence_id AS occurrenceId,o.chunk_id AS id,o.ordinal,o.start_line AS startLine,
                  o.end_line AS endLine,o.display_text AS text,r.content_id AS contentId,n.path
           FROM chunk_occurrences o JOIN notes n
             ON n.note_id=o.note_id AND n.semantic_revision_id=o.revision_id
           JOIN note_revisions r ON r.revision_id=o.revision_id
           WHERE o.occurrence_id IN (${top.map(() => "?").join(",")})`,
          top.map(({ occurrenceId }) => occurrenceId)
        );
        const selectedById = new Map(selected.map((row) => [Number(row.occurrenceId), row]));
        for (const candidate of top) {
          const row = selectedById.get(candidate.occurrenceId);
          if (!row) continue;
          semantic.push({
            id: candidate.id,
            path: candidate.path,
            contentId: String(row.contentId),
            ordinal: candidate.ordinal,
            score: candidate.score,
            semanticScore: candidate.score,
            text: String(row.text),
            startLine: Number(row.startLine),
            endLine: Number(row.endLine),
          });
        }
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
      const scoped =
        options.lexicalProfile === "voce" ? `{body headings}:(${expression})` : expression;
      const filter = currentPath ? " AND n.path<>?" : "";
      const filterBind = currentPath ? [currentPath] : [];
      const scored = noteShape
        ? `SELECT o.occurrence_id AS occurrenceId,COALESCE(o.chunk_id,r.content_id || ':note') AS id,
                  COALESCE(o.ordinal,0) AS ordinal,n.path,
                  bm25(lexical_notes_fts,1,2,3,3,0.5) AS rank
           FROM lexical_notes_fts f JOIN lexical_notes l ON l.note_id=f.rowid
           JOIN notes n ON n.note_id=l.note_id AND n.lexical_revision_id=l.revision_id
           JOIN note_revisions r ON r.revision_id=l.revision_id
           LEFT JOIN chunk_occurrences o ON o.occurrence_id=(
             SELECT first.occurrence_id FROM chunk_occurrences first
             WHERE first.note_id=l.note_id AND first.revision_id=l.revision_id
             ORDER BY first.ordinal LIMIT 1
           )
           WHERE lexical_notes_fts MATCH ?${filter}`
        : `SELECT o.occurrence_id AS occurrenceId,o.chunk_id AS id,o.ordinal,n.path,
                  bm25(lexical_notes_fts,1,2,3) AS rank
           FROM lexical_notes_fts f JOIN lexical_notes l ON l.note_id=f.rowid
           JOIN notes n ON n.note_id=l.note_id AND n.lexical_revision_id=l.revision_id
           JOIN note_revisions r ON r.revision_id=l.revision_id
           LEFT JOIN chunk_occurrences o ON o.occurrence_id=(
             SELECT first.occurrence_id FROM chunk_occurrences first
             WHERE first.note_id=l.note_id AND first.revision_id=l.revision_id
             ORDER BY first.ordinal LIMIT 1
           )
           WHERE lexical_notes_fts MATCH ?${filter}`;
      const candidateSource = noteShape
        ? `winners AS (
             SELECT * FROM (
               SELECT *,row_number() OVER (
                 PARTITION BY path ORDER BY rank ASC,ordinal,id COLLATE BINARY
               ) AS noteRank
               FROM scored
             ) WHERE noteRank=1
           )`
        : "winners AS (SELECT * FROM scored)";
      const candidates = rows(
        this.context.db,
        `WITH scored AS MATERIALIZED (${scored}), ${candidateSource}, ranked AS (
           SELECT *,RANK() OVER (ORDER BY rank ASC) AS cutoffRank FROM winners
         )
         SELECT occurrenceId,id,ordinal,path,rank FROM ranked
         WHERE cutoffRank<=? ORDER BY rank ASC`,
        [scoped, ...filterBind, lexicalLimit]
      )
        .sort(
          (left, right) =>
            Number(left.rank) - Number(right.rank) ||
            compareCodeUnits(String(left.path), String(right.path)) ||
            Number(left.ordinal) - Number(right.ordinal) ||
            compareCodeUnits(String(left.id), String(right.id))
        )
        .slice(0, lexicalLimit);
      const minRank = Number(candidates[0]?.rank ?? 0);
      const details = candidates.length
        ? (() => {
            const paths = candidates.map(({ path }) => String(path));
            const passageRows: Record<string, unknown>[] = [];
            for (const path of paths) {
              this.context.db.exec(
                "CREATE VIRTUAL TABLE temp.note_passage_fts USING fts5(body,tokenize='unicode61 remove_diacritics 2')"
              );
              try {
                this.context.db.exec({
                  sql: `INSERT INTO temp.note_passage_fts(rowid,body)
                          SELECT o.occurrence_id,o.display_text FROM chunk_occurrences o
                          JOIN notes n ON n.note_id=o.note_id AND n.lexical_revision_id=o.revision_id
                          WHERE n.path=? ORDER BY o.ordinal,o.occurrence_id`,
                  bind: [path],
                });
                passageRows.push(
                  ...rows(
                    this.context.db,
                    `WITH scored AS MATERIALIZED (
                         SELECT rowid AS occurrenceId,bm25(note_passage_fts) AS passageRank
                         FROM note_passage_fts WHERE note_passage_fts MATCH ?
                       )
                       SELECT o.occurrence_id AS occurrenceId,o.chunk_id AS id,o.ordinal,n.path,
                              r.content_id AS contentId,o.display_text AS text,
                              o.start_line AS startLine,o.end_line AS endLine
                       FROM scored s JOIN chunk_occurrences o ON o.occurrence_id=s.occurrenceId
                       JOIN notes n ON n.note_id=o.note_id AND n.lexical_revision_id=o.revision_id
                       JOIN note_revisions r ON r.revision_id=o.revision_id
                       ORDER BY s.passageRank,o.ordinal,o.chunk_id COLLATE BINARY LIMIT 1`,
                    [expression]
                  )
                );
              } finally {
                this.context.db.exec("DROP TABLE IF EXISTS temp.note_passage_fts");
              }
            }
            const found = new Set(passageRows.map(({ path }) => String(path)));
            const fallbackRows = rows(
              this.context.db,
              `SELECT o.occurrence_id AS occurrenceId,COALESCE(o.chunk_id,r.content_id || ':note') AS id,
                        COALESCE(o.ordinal,0) AS ordinal,n.path,r.content_id AS contentId,
                        COALESCE(o.display_text,'') AS text,COALESCE(o.start_line,1) AS startLine,
                        COALESCE(o.end_line,1) AS endLine
                 FROM notes n JOIN note_revisions r ON r.revision_id=n.lexical_revision_id
                 LEFT JOIN chunk_occurrences o ON o.occurrence_id=(
                   SELECT first.occurrence_id FROM chunk_occurrences first
                   WHERE first.note_id=n.note_id AND first.revision_id=n.lexical_revision_id
                   ORDER BY first.ordinal LIMIT 1
                 )
                 WHERE n.path IN (${paths
                   .filter((path) => !found.has(path))
                   .map(() => "?")
                   .join(",")})`,
              paths.filter((path) => !found.has(path))
            );
            return [...passageRows, ...fallbackRows];
          })()
        : candidates.length
          ? rows(
              this.context.db,
              `SELECT o.occurrence_id AS occurrenceId,o.chunk_id AS id,o.ordinal,o.start_line AS startLine,
                    o.end_line AS endLine,o.display_text AS text,r.content_id AS contentId,n.path
             FROM chunk_occurrences o JOIN notes n ON n.note_id=o.note_id
             JOIN note_revisions r ON r.revision_id=o.revision_id
             WHERE o.occurrence_id IN (${candidates.map(() => "?").join(",")})`,
              candidates.map(({ occurrenceId }) => Number(occurrenceId))
            )
          : [];
      const detailsById = new Map(details.map((row) => [String(row.path), row]));
      for (const candidate of candidates) {
        const row = detailsById.get(String(candidate.path));
        if (!row) continue;
        const rank = Number(candidate.rank);
        const score = minRank < 0 ? rank / minRank : (1 + minRank) / (1 + rank);
        lexical.push({
          id: String(row.id ?? candidate.id),
          path: String(candidate.path),
          contentId: String(row.contentId),
          ordinal: Number(row.ordinal ?? candidate.ordinal),
          score,
          lexicalScore: score,
          text: String(row.text),
          startLine: Number(row.startLine),
          endLine: Number(row.endLine),
        });
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
  private relatedCentroid(path: string): {
    readonly vector?: Float32Array;
    readonly count: number;
  } {
    const sum = new Float64Array(this.context.dimensions);
    let count = 0;
    this.scanRelatedPassages(path, undefined, ({ vector }) => {
      for (let index = 0; index < sum.length; index++) sum[index] += vector[index];
      count++;
    });
    let norm = 0;
    for (const value of sum) norm += value * value;
    if (!count || !(norm > 0)) return { count };
    const scale = 1 / Math.sqrt(norm);
    return {
      count,
      vector: Float32Array.from(sum, (value) => value * scale),
    };
  }

  private relatedProbes(
    path: string,
    centroid: Float32Array | undefined,
    count: number
  ): RelatedPassage[] {
    if (!count) return [];
    let nearest: RelatedPassage | undefined;
    this.scanRelatedPassages(path, undefined, (passage) => {
      if (!nearest) {
        nearest = passage;
        return;
      }
      const score = centroid ? normalizedDot(passage.vector, centroid) : 0;
      const nearestScore = centroid ? normalizedDot(nearest.vector, centroid) : 0;
      if (
        score > nearestScore ||
        (score === nearestScore && comparePassageRefs(passage, nearest) < 0)
      )
        nearest = passage;
    });
    if (!nearest) return [];
    const probes = [nearest];
    while (probes.length < Math.min(RELATED_PROBE_COUNT, count)) {
      let farthest: RelatedPassage | undefined;
      let nearestSimilarity = Infinity;
      this.scanRelatedPassages(path, undefined, (passage) => {
        if (probes.some(({ inputDigest }) => inputDigest === passage.inputDigest)) return;
        let maximumSimilarity = -Infinity;
        for (const probe of probes)
          maximumSimilarity = Math.max(
            maximumSimilarity,
            normalizedDot(passage.vector, probe.vector)
          );
        if (
          maximumSimilarity < nearestSimilarity ||
          (maximumSimilarity === nearestSimilarity &&
            (!farthest || comparePassageRefs(passage, farthest) < 0))
        ) {
          nearestSimilarity = maximumSimilarity;
          farthest = passage;
        }
      });
      if (!farthest) break;
      probes.push(farthest);
    }
    return probes;
  }

  private relatedNoteCandidates(
    queries: readonly Float32Array[],
    sourcePath: string
  ): SemanticCandidate[] {
    const queryCte = this.relatedPassageCte(undefined, sourcePath);
    const top = queries.map(() => [] as SemanticCandidate[]);
    let currentPath = "";
    const best: (SemanticCandidate | undefined)[] = queries.map(() => undefined);
    const flush = () => {
      for (let index = 0; index < queries.length; index++) {
        const candidate = best[index];
        if (candidate)
          offerTopK(top[index], candidate, RELATED_NOTES_PER_PROBE, compareSemanticCandidates);
        best[index] = undefined;
      }
    };
    this.context.db.exec({
      sql: `${queryCte.sql}
        SELECT p.occurrenceId,p.id,p.path,p.ordinal,ec.vector
        FROM related_passages p
        CROSS JOIN embedding_cache ec INDEXED BY embedding_cache_lookup ON ec.input_digest=p.inputDigest
          AND ec.embedding_fingerprint=? AND ec.preprocessing=? AND ec.task_kind='document'
        ORDER BY p.path COLLATE BINARY,p.ordinal,p.id COLLATE BINARY`,
      bind: [...queryCte.bind, this.context.embeddingFingerprint, EMBEDDING_PREPROCESSING_VERSION],
      rowMode: "object",
      callback: (row) => {
        const passagePath = String(row.path);
        if (passagePath !== currentPath) {
          flush();
          currentPath = passagePath;
        }
        const vector = this.relatedVector(row.vector);
        for (let index = 0; index < queries.length; index++) {
          const candidate: SemanticCandidate = {
            occurrenceId: Number(row.occurrenceId),
            id: String(row.id),
            path: passagePath,
            ordinal: Number(row.ordinal),
            score: normalizedDot(queries[index], vector),
          };
          const previous = best[index];
          if (!previous || compareSemanticCandidates(candidate, previous) < 0)
            best[index] = candidate;
        }
      },
    });
    flush();
    return top.flatMap((candidates) => candidates.sort(compareSemanticCandidates));
  }

  private symmetricRelatedScore(
    source: readonly RelatedPassageRef[],
    target: readonly RelatedPassageRef[]
  ): { readonly score: number; readonly evidenceId: number } | undefined {
    const sourceCount = source.length;
    if (!sourceCount || !target.length) return undefined;
    const targetMax = new Float64Array(target.length).fill(-Infinity);
    const sourceTop = [-Infinity, -Infinity];
    for (
      let sourceOffset = 0;
      sourceOffset < sourceCount;
      sourceOffset += RELATED_VECTOR_TILE_SIZE
    ) {
      const sourceVectors = this.relatedVectors(
        source.slice(sourceOffset, sourceOffset + RELATED_VECTOR_TILE_SIZE)
      );
      const sourceMax = new Float64Array(sourceVectors.length).fill(-Infinity);
      for (
        let targetOffset = 0;
        targetOffset < target.length;
        targetOffset += RELATED_VECTOR_TILE_SIZE
      ) {
        const targetRefs = target.slice(targetOffset, targetOffset + RELATED_VECTOR_TILE_SIZE);
        const targetVectors = this.relatedVectors(targetRefs);
        for (let sourceIndex = 0; sourceIndex < sourceVectors.length; sourceIndex++) {
          for (let targetIndex = 0; targetIndex < targetVectors.length; targetIndex++) {
            const score = normalizedDot(sourceVectors[sourceIndex], targetVectors[targetIndex]);
            if (score > sourceMax[sourceIndex]) sourceMax[sourceIndex] = score;
            const targetIndexOverall = targetOffset + targetIndex;
            if (score > targetMax[targetIndexOverall]) targetMax[targetIndexOverall] = score;
          }
        }
      }
      for (const score of sourceMax) offerTopTwo(score, sourceTop);
    }
    const targetTop = [-Infinity, -Infinity];
    let evidenceIndex = 0;
    for (let index = 0; index < targetMax.length; index++) {
      offerTopTwo(targetMax[index], targetTop);
      if (
        targetMax[index] > targetMax[evidenceIndex] ||
        (targetMax[index] === targetMax[evidenceIndex] &&
          comparePassageRefs(target[index], target[evidenceIndex]) < 0)
      )
        evidenceIndex = index;
    }
    const sourceMean =
      (sourceTop[0] + (sourceCount > 1 ? sourceTop[1] : 0)) / Math.min(2, sourceCount);
    const targetMean =
      (targetTop[0] + (target.length > 1 ? targetTop[1] : 0)) / Math.min(2, target.length);
    return { score: (sourceMean + targetMean) / 2, evidenceId: target[evidenceIndex].occurrenceId };
  }

  findRelated(
    path: string,
    _vector: Float32Array | undefined,
    limit: number
  ): readonly SqliteHit[] {
    this.context.ensureOpen();
    const resultLimit = Math.min(SQLITE_MAX_RESULTS, Math.max(0, limit));
    if (!resultLimit || !this.context.embeddingFingerprint) return [];
    const sourceTimer = this.startPhase();
    const source = this.relatedCentroid(path);
    if (!source.count) return [];
    const probes = this.relatedProbes(path, source.vector, source.count);
    this.finishPhase("centroid", sourceTimer, source.count);
    const candidateQueries = [
      ...(source.vector ? [source.vector] : []),
      ...probes.map(({ vector }) => vector),
    ];
    const candidates = new Map<string, SemanticCandidate>();
    const candidateTimer = this.startPhase();
    for (const candidate of this.relatedNoteCandidates(candidateQueries, path))
      if (!candidates.has(candidate.path)) candidates.set(candidate.path, candidate);
    this.finishPhase("relatedCandidates", candidateTimer, candidates.size);
    const rerankTimer = this.startPhase();
    const sourceRefs = this.relatedPassageRefs(path);
    const hits: SqliteHit[] = [];
    for (const candidate of candidates.values()) {
      const target = this.relatedPassageRefs(candidate.path);
      const related = this.symmetricRelatedScore(sourceRefs, target);
      if (!related) continue;
      const evidence = rows(
        this.context.db,
        `SELECT o.chunk_id AS id,o.ordinal,n.path,r.content_id AS contentId,
                o.display_text AS text,o.start_line AS startLine,o.end_line AS endLine
         FROM chunk_occurrences o JOIN notes n
           ON n.note_id=o.note_id AND n.semantic_revision_id=o.revision_id
         JOIN note_revisions r ON r.revision_id=o.revision_id
         WHERE o.occurrence_id=? AND n.path=?`,
        [related.evidenceId, candidate.path]
      )[0];
      if (!evidence) continue;
      hits.push({
        id: String(evidence.id),
        path: String(evidence.path),
        contentId: String(evidence.contentId),
        ordinal: Number(evidence.ordinal),
        score: related.score,
        semanticScore: related.score,
        text: String(evidence.text),
        startLine: Number(evidence.startLine),
        endLine: Number(evidence.endLine),
      });
    }
    this.finishPhase("relatedRerank", rerankTimer, hits.length);
    return hits
      .sort(
        (left, right) =>
          right.score - left.score ||
          compareCodeUnits(left.path, right.path) ||
          left.ordinal - right.ordinal ||
          compareCodeUnits(left.id, right.id)
      )
      .slice(0, resultLimit);
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
