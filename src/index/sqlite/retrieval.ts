import { SQLITE_MAX_RESULTS, type SqliteHit } from "./protocol";
import { sqliteError } from "./protocol";
import {
  EMBEDDING_PREPROCESSING_VERSION,
  normalizedVector,
  rows,
  type SqliteContext,
  vectorBytes,
} from "./core";

const RRF_K = 60;
const RELATED_PROBE_COUNT = 3;
const RELATED_NOTES_PER_PROBE = 32;
const RELATED_SOURCE_TILE_SIZE = 16;
const RELATED_TARGET_TILE_SIZE = 128;

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
      const top = rows(
        this.context.db,
        `WITH scored AS MATERIALIZED (
           SELECT occurrenceId,id,ordinal,path,trama_vector_dot(vector,?) AS score FROM (${sql})
         ), ranked AS (
           SELECT *,row_number() OVER (PARTITION BY path ORDER BY score DESC,ordinal,id COLLATE BINARY) AS position FROM scored
         ) SELECT * FROM ranked WHERE position=1
           ORDER BY score DESC,path COLLATE trama_code_units,ordinal,id COLLATE BINARY LIMIT ?`,
        [vectorBytes(q), ...bind, semanticLimit]
      ).map((row) => ({
        occurrenceId: Number(row.occurrenceId),
        id: String(row.id),
        ordinal: Number(row.ordinal),
        path: String(row.path),
        score: Number(row.score),
      }));
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
        `WITH scored AS MATERIALIZED (${scored}), ${candidateSource},
         normalized AS (SELECT *,min(rank) OVER () AS minRank FROM winners)
         SELECT occurrenceId,id,ordinal,path,rank,
           CASE WHEN minRank<0 THEN rank/minRank ELSE (1+minRank)/(1+rank) END AS score FROM normalized
         ORDER BY rank ASC,path COLLATE trama_code_units,ordinal,id COLLATE BINARY LIMIT ?`,
        [scoped, ...filterBind, lexicalLimit]
      );
      const details = candidates.length
        ? (() => {
            const paths = candidates.map(({ path }) => String(path));
            const passageRows = rows(
              this.context.db,
              `WITH stats AS MATERIALIZED (
                 SELECT p.note_id,count(*) AS documents,sum(p.token_count) AS tokens
                 FROM lexical_passages p JOIN notes n ON n.note_id=p.note_id
                 WHERE n.path IN (${paths.map(() => "?").join(",")}) GROUP BY p.note_id
               ), scored AS MATERIALIZED (
                 SELECT f.rowid AS occurrenceId,
                        trama_passage_bm25(lexical_passages_fts,s.note_id,s.documents,s.tokens) AS passageRank
                 FROM lexical_passages_fts f JOIN lexical_passages p ON p.occurrence_id=f.rowid
                 JOIN stats s ON s.note_id=p.note_id WHERE lexical_passages_fts MATCH ?
               ), ranked AS (
                 SELECT o.occurrence_id AS occurrenceId,o.chunk_id AS id,o.ordinal,n.path,
                        r.content_id AS contentId,o.display_text AS text,
                        o.start_line AS startLine,o.end_line AS endLine,
                        row_number() OVER (PARTITION BY n.note_id
                          ORDER BY s.passageRank,o.ordinal,o.chunk_id COLLATE BINARY) AS position
                 FROM scored s JOIN chunk_occurrences o ON o.occurrence_id=s.occurrenceId
                 JOIN notes n ON n.note_id=o.note_id AND n.lexical_revision_id=o.revision_id
                 JOIN note_revisions r ON r.revision_id=o.revision_id
               ) SELECT * FROM ranked WHERE position=1`,
              [...paths, expression]
            );
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
        : [];
      const detailsById = new Map(details.map((row) => [String(row.path), row]));
      for (const candidate of candidates) {
        const row = detailsById.get(String(candidate.path));
        if (!row) continue;
        const score = Number(candidate.score);
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
    const key = noteShape ? "path" : "id";
    const result = rows(
      this.context.db,
      `WITH s AS MATERIALIZED (SELECT value AS hit,CAST(key AS INTEGER) AS rank,json_extract(value,'$.${key}') AS identity FROM json_each(?)),
            l AS MATERIALIZED (SELECT value AS hit,CAST(key AS INTEGER) AS rank,json_extract(value,'$.${key}') AS identity FROM json_each(?)),
            identities AS (SELECT identity FROM s UNION SELECT identity FROM l),
            fused AS (
              SELECT coalesce(s.hit,l.hit) AS hit,coalesce(s.rank,l.rank) AS rank,
                json_extract(l.hit,'$.lexicalScore') AS lexicalScore,
                coalesce(1.0/(${RRF_K}+s.rank+1),0)+coalesce(1.0/(${RRF_K}+l.rank+1),0) AS score
              FROM identities k LEFT JOIN s ON s.identity=k.identity LEFT JOIN l ON l.identity=k.identity
            ) SELECT * FROM fused ORDER BY score DESC,json_extract(hit,'$.path') COLLATE trama_code_units,
              json_extract(hit,'$.ordinal'),json_extract(hit,'$.id') COLLATE trama_code_units LIMIT ?`,
      [JSON.stringify(semantic), JSON.stringify(lexical), limit]
    ).map((row) => ({
      ...JSON.parse(String(row.hit)),
      fused: Number(row.score),
      fusedScore: Number(row.score),
      rank: Number(row.rank),
      ...(row.lexicalScore == null ? {} : { lexicalScore: Number(row.lexicalScore) }),
    }));
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
  async findRelated(
    path: string,
    _vector: Float32Array | undefined,
    limit: number,
    signal?: AbortSignal
  ): Promise<readonly SqliteHit[]> {
    this.context.ensureOpen();
    const resultLimit = Math.min(SQLITE_MAX_RESULTS, Math.max(0, limit));
    if (!resultLimit || !this.context.embeddingFingerprint) return [];
    let yieldAt = performance.now() + 8;
    const checkpoint = async () => {
      if (signal?.aborted) throw sqliteError("cancelled", "Related search cancelled", true);
      if (performance.now() >= yieldAt) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (signal?.aborted) throw sqliteError("cancelled", "Related search cancelled", true);
        yieldAt = performance.now() + 8;
      }
    };
    await checkpoint();
    try {
      const sourceTimer = this.startPhase();
      const cte = this.relatedPassageCte(path);
      this.context.db.exec({
        sql: `CREATE TEMP TABLE related_source AS ${cte.sql}
          SELECT p.*,ec.vector,row_number() OVER (ORDER BY p.ordinal,p.id COLLATE BINARY)-1 AS position
          FROM related_passages p CROSS JOIN embedding_cache ec INDEXED BY embedding_cache_lookup
            ON ec.input_digest=p.inputDigest AND ec.embedding_fingerprint=?
            AND ec.preprocessing=? AND ec.task_kind='document'`,
        bind: [...cte.bind, this.context.embeddingFingerprint, EMBEDDING_PREPROCESSING_VERSION],
      });
      const source = rows(
        this.context.db,
        `SELECT count(*) AS count,trama_vector_centroid(vector) AS vector
        FROM (SELECT vector FROM related_source ORDER BY position)`
      )[0];
      const sourceCount = Number(source.count);
      if (!sourceCount) return [];
      const probes: { occurrenceId: number; vector: unknown }[] = [];
      for (let index = 0; index < Math.min(RELATED_PROBE_COUNT, sourceCount); index++) {
        await checkpoint();
        const probe = rows(
          this.context.db,
          `SELECT occurrenceId,vector FROM related_source
           ${probes.length ? `WHERE occurrenceId NOT IN (${probes.map(() => "?").join(",")})` : ""}
           ORDER BY ${probes.length ? probes.map(() => "trama_vector_dot(vector,?)").reduce((a, b) => `max(${a},${b})`) : source.vector ? "trama_vector_dot(vector,?) DESC" : "0+0"}
             ${probes.length ? "ASC," : ","} ordinal,id COLLATE BINARY LIMIT 1`,
          probes.length
            ? [...probes.map((p) => p.occurrenceId), ...probes.map((p) => p.vector)]
            : source.vector
              ? [source.vector]
              : []
        )[0];
        if (!probe) break;
        probes.push({ occurrenceId: Number(probe.occurrenceId), vector: probe.vector });
      }
      this.finishPhase("centroid", sourceTimer, sourceCount);
      await checkpoint();
      const candidateTimer = this.startPhase();
      const queries = [...(source.vector ? [source.vector] : []), ...probes.map((p) => p.vector)];
      const corpus = this.relatedPassageCte(undefined, path);
      const candidates = rows(
        this.context.db,
        `${corpus.sql},
        probes(probe,vector) AS (VALUES ${queries.map((_, i) => `(${i},?)`).join(",")}),
        scored AS MATERIALIZED (
          SELECT p.*,q.probe,trama_vector_dot(ec.vector,q.vector) AS score
          FROM related_passages p CROSS JOIN embedding_cache ec INDEXED BY embedding_cache_lookup
            ON ec.input_digest=p.inputDigest AND ec.embedding_fingerprint=?
            AND ec.preprocessing=? AND ec.task_kind='document' CROSS JOIN probes q
        ), passages AS (
          SELECT *,row_number() OVER (PARTITION BY probe,path ORDER BY score DESC,ordinal,id COLLATE BINARY) AS passageRank FROM scored
        ), ranked AS (
          SELECT *,row_number() OVER (PARTITION BY probe ORDER BY score DESC,path COLLATE trama_code_units,ordinal,id COLLATE BINARY) AS noteRank
          FROM passages WHERE passageRank=1
        ) SELECT DISTINCT path FROM ranked WHERE noteRank<=? ORDER BY path COLLATE trama_code_units`,
        [
          ...corpus.bind,
          ...queries,
          this.context.embeddingFingerprint,
          EMBEDDING_PREPROCESSING_VERSION,
          RELATED_NOTES_PER_PROBE,
        ]
      );
      this.finishPhase("relatedCandidates", candidateTimer, candidates.length);
      await checkpoint();
      const rerankTimer = this.startPhase();
      this.context.db.exec(
        "CREATE TEMP TABLE related_maxima(direction INTEGER,id INTEGER,score REAL,PRIMARY KEY(direction,id)) WITHOUT ROWID"
      );
      this.context.db.exec(
        "CREATE TEMP TABLE related_results(occurrenceId INTEGER PRIMARY KEY,score REAL)"
      );
      for (const candidate of candidates) {
        await checkpoint();
        const targetCte = this.relatedPassageCte(String(candidate.path));
        this.context.db.exec({
          sql: `CREATE TEMP TABLE related_target AS ${targetCte.sql}
          SELECT p.*,ec.vector,row_number() OVER (ORDER BY p.ordinal,p.id COLLATE BINARY)-1 AS position
          FROM related_passages p CROSS JOIN embedding_cache ec INDEXED BY embedding_cache_lookup
            ON ec.input_digest=p.inputDigest AND ec.embedding_fingerprint=?
            AND ec.preprocessing=? AND ec.task_kind='document'`,
          bind: [
            ...targetCte.bind,
            this.context.embeddingFingerprint,
            EMBEDDING_PREPROCESSING_VERSION,
          ],
        });
        const targetCount = Number(
          rows(this.context.db, "SELECT count(*) AS count FROM related_target")[0].count
        );
        this.context.db.exec("DELETE FROM related_maxima");
        for (
          let sourceOffset = 0;
          sourceOffset < sourceCount;
          sourceOffset += RELATED_SOURCE_TILE_SIZE
        ) {
          for (
            let targetOffset = 0;
            targetOffset < targetCount;
            targetOffset += RELATED_TARGET_TILE_SIZE
          ) {
            await checkpoint();
            this.context.db.exec({
              sql: `WITH scores AS MATERIALIZED (
              SELECT s.occurrenceId AS sourceId,t.occurrenceId AS targetId,trama_vector_dot(s.vector,t.vector) AS score
              FROM related_source s CROSS JOIN related_target t
              WHERE s.position>=? AND s.position<? AND t.position>=? AND t.position<?
            ), maxima AS (
              SELECT 0 AS direction,sourceId AS id,max(score) AS score FROM scores GROUP BY sourceId
              UNION ALL SELECT 1,targetId,max(score) FROM scores GROUP BY targetId
            ) INSERT INTO related_maxima SELECT * FROM maxima WHERE 1
              ON CONFLICT(direction,id) DO UPDATE SET score=max(related_maxima.score,excluded.score)`,
              bind: [
                sourceOffset,
                sourceOffset + RELATED_SOURCE_TILE_SIZE,
                targetOffset,
                targetOffset + RELATED_TARGET_TILE_SIZE,
              ],
            });
          }
        }
        this.context.db.exec(
          `WITH ranked AS (
          SELECT *,row_number() OVER (PARTITION BY direction ORDER BY score DESC) AS position FROM related_maxima
        ), means AS (SELECT direction,avg(score) AS mean FROM ranked WHERE position<=2 GROUP BY direction),
        evidence AS (
          SELECT t.occurrenceId FROM related_target t JOIN related_maxima m ON m.direction=1 AND m.id=t.occurrenceId
          ORDER BY m.score DESC,t.ordinal,t.id COLLATE BINARY LIMIT 1
        ) INSERT INTO related_results SELECT occurrenceId,(SELECT avg(mean) FROM means) FROM evidence`
        );
        this.context.db.exec("DROP TABLE related_target");
      }
      const hits = rows(
        this.context.db,
        `SELECT o.chunk_id AS id,n.path,r.content_id AS contentId,o.ordinal,o.display_text AS text,
          o.start_line AS startLine,o.end_line AS endLine,s.score
          FROM related_results s JOIN chunk_occurrences o ON o.occurrence_id=s.occurrenceId
          JOIN notes n ON n.note_id=o.note_id AND n.semantic_revision_id=o.revision_id
          JOIN note_revisions r ON r.revision_id=o.revision_id
          ORDER BY s.score DESC,n.path COLLATE trama_code_units,o.ordinal,o.chunk_id COLLATE BINARY LIMIT ?`,
        [resultLimit]
      ).map((row) => ({
        id: String(row.id),
        path: String(row.path),
        contentId: String(row.contentId),
        ordinal: Number(row.ordinal),
        text: String(row.text),
        startLine: Number(row.startLine),
        endLine: Number(row.endLine),
        score: Number(row.score),
        semanticScore: Number(row.score),
      }));
      this.finishPhase("relatedRerank", rerankTimer, candidates.length);
      return hits;
    } finally {
      this.context.db.exec(
        "DROP TABLE IF EXISTS temp.related_source; DROP TABLE IF EXISTS temp.related_target; DROP TABLE IF EXISTS temp.related_maxima; DROP TABLE IF EXISTS temp.related_results"
      );
    }
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
