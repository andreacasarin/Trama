/** Production statements whose query plans are guarded by sqlite-query-plan.test.ts. */
export const SEMANTIC_MISSING_INPUTS_SQL = `WITH candidates AS MATERIALIZED (
  SELECT ei.input_id AS inputId,ei.serialized_input AS serialization,ei.action_key AS inputDigest
  FROM embedding_inputs ei
  WHERE EXISTS (
    SELECT 1
    FROM chunk_occurrences o
    JOIN notes n ON n.note_id=o.note_id AND n.lexical_revision_id=o.revision_id
    WHERE o.embedding_input_digest=ei.action_key
  )
    AND NOT EXISTS (
      SELECT 1
      FROM embedding_cache ec
      WHERE ec.input_digest=ei.action_key
        AND ec.embedding_fingerprint=?
        AND ec.preprocessing=?
    )
  ORDER BY ei.input_id
  LIMIT ?
), bounded AS (
  SELECT *,
    sum(length(CAST(serialization AS BLOB))) OVER (
      ORDER BY inputId ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS inputBytes,
    row_number() OVER (ORDER BY inputId) AS itemNumber
  FROM candidates
)
SELECT inputId,serialization,inputDigest,inputBytes
FROM bounded
WHERE itemNumber<=? AND (itemNumber=1 OR inputBytes<=?)
ORDER BY inputId`;

const semanticPromotion = (affected: string) => `UPDATE notes AS n
  SET semantic_revision_id=n.lexical_revision_id
  WHERE n.lexical_revision_id IS NOT NULL
    AND n.semantic_revision_id IS NOT n.lexical_revision_id
    ${affected}
    AND NOT EXISTS (
      SELECT 1
      FROM chunk_occurrences o
      JOIN embedding_inputs ei ON ei.action_key=o.embedding_input_digest
      LEFT JOIN embedding_cache ec
        ON ec.input_digest=ei.action_key
       AND ec.embedding_fingerprint=?
       AND ec.preprocessing=?
      WHERE o.note_id=n.note_id
        AND o.revision_id=n.lexical_revision_id
        AND ec.cache_id IS NULL
    )`;

export const SEMANTIC_PROMOTION_SQL = semanticPromotion("");
export const SEMANTIC_AFFECTED_PROMOTION_SQL = semanticPromotion(
  "AND EXISTS (SELECT 1 FROM semantic_affected_notes a WHERE a.note_id=n.note_id)"
);

export const LEXICAL_FINISH_EQUALITY_SQL = `SELECT count(*) AS count
  FROM reconciliation_expected e LEFT JOIN notes n ON n.path=e.path
  LEFT JOIN note_revisions r ON r.revision_id=n.lexical_revision_id
  WHERE n.note_pk IS NULL OR r.content_id<>e.content_id OR
        (e.chunk_count IS NOT NULL AND e.chunk_count<>(
          SELECT count(*) FROM chunk_occurrences c
          WHERE c.note_id=n.note_id AND c.revision_id=n.lexical_revision_id
        ))`;

export const LEXICAL_RENAME_LOOKUP_SQL =
  "SELECT note_id,semantic_revision_id FROM notes WHERE path=?";
export const LEXICAL_BOUNDED_DELETE_SQL =
  "DELETE FROM notes WHERE path IN (SELECT path FROM lexical_delete_paths)";
