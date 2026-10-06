export const SQLITE_APPLICATION_ID = 0x54524d41;
export const SQLITE_SCHEMA_VERSION = 15;
export const SQLITE_PROTOCOL_VERSION = 13;
export { SQLITE_BUILD_IDENTITY } from "../../build/identity";

export function schemaSql(dimensions: number): string {
  if (!Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > 4096)
    throw new Error("Invalid SQLite vector dimensions");
  return `
PRAGMA journal_mode=DELETE;
PRAGMA synchronous=FULL;
PRAGMA foreign_keys=ON;
PRAGMA temp_store=MEMORY;
PRAGMA application_id=${SQLITE_APPLICATION_ID};
PRAGMA user_version=${SQLITE_SCHEMA_VERSION};
CREATE TABLE IF NOT EXISTS index_state (
  id INTEGER PRIMARY KEY CHECK (id=1),
  app_version TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  protocol_version INTEGER NOT NULL,
  build_identity TEXT NOT NULL,
  extraction_version INTEGER NOT NULL,
  chunk_algorithm_version INTEGER NOT NULL,
  embedding_input_version INTEGER NOT NULL DEFAULT 1,
  dimensions INTEGER NOT NULL CHECK (dimensions > 0),
  corpus_fingerprint TEXT NOT NULL,
  embedding_fingerprint TEXT NOT NULL,
  incomplete INTEGER NOT NULL CHECK (incomplete IN (0,1)),
  change_counter INTEGER NOT NULL CHECK (change_counter >= 0),
  lexical_generation INTEGER NOT NULL DEFAULT 0 CHECK (lexical_generation >= 0),
  semantic_generation INTEGER NOT NULL DEFAULT 0 CHECK (semantic_generation >= 0),
  reconciliation_summary TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE TABLE IF NOT EXISTS notes (
  note_pk INTEGER PRIMARY KEY,
  note_id INTEGER NOT NULL UNIQUE,
  path TEXT COLLATE BINARY NOT NULL UNIQUE,
  content_id TEXT COLLATE BINARY NOT NULL,
  lexical_revision_id INTEGER REFERENCES note_revisions(revision_id) DEFERRABLE INITIALLY DEFERRED,
  semantic_revision_id INTEGER REFERENCES note_revisions(revision_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX IF NOT EXISTS notes_content_id ON notes(content_id);
-- Revisions and embedding inputs are immutable; notes owns the active lexical
-- and semantic heads.
CREATE TABLE IF NOT EXISTS note_revisions (
  revision_id INTEGER PRIMARY KEY,
  note_id INTEGER NOT NULL REFERENCES notes(note_id) ON DELETE CASCADE,
  content_id TEXT COLLATE BINARY NOT NULL,
  extraction_version INTEGER NOT NULL,
  chunk_algorithm_version INTEGER NOT NULL,
  created_change_counter INTEGER NOT NULL CHECK (created_change_counter >= 0),
  UNIQUE(note_id, content_id, extraction_version, chunk_algorithm_version)
) STRICT;
CREATE INDEX IF NOT EXISTS note_revisions_note ON note_revisions(note_id, revision_id);
CREATE TABLE IF NOT EXISTS chunk_occurrences (
  occurrence_id INTEGER PRIMARY KEY,
  revision_id INTEGER NOT NULL REFERENCES note_revisions(revision_id) ON DELETE CASCADE,
  note_id INTEGER NOT NULL REFERENCES notes(note_id) ON DELETE CASCADE,
  chunk_id TEXT COLLATE BINARY NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  kind TEXT NOT NULL,
  start_line INTEGER NOT NULL CHECK (start_line >= 1),
  end_line INTEGER NOT NULL CHECK (end_line >= start_line),
  display_text TEXT NOT NULL,
  embedding_input_digest TEXT COLLATE BINARY NOT NULL,
  UNIQUE(revision_id, ordinal),
  UNIQUE(revision_id, chunk_id)
) STRICT;
CREATE INDEX IF NOT EXISTS chunk_occurrences_note ON chunk_occurrences(note_id, revision_id, ordinal);
CREATE INDEX IF NOT EXISTS chunk_occurrences_embedding_input ON chunk_occurrences(embedding_input_digest, note_id, revision_id);
CREATE TABLE IF NOT EXISTS embedding_inputs (
  input_id INTEGER PRIMARY KEY,
  embedding_fingerprint TEXT COLLATE BINARY NOT NULL,
  serialized_input TEXT NOT NULL,
  preprocessing TEXT NOT NULL,
  action_key TEXT COLLATE BINARY NOT NULL UNIQUE
) STRICT;
CREATE INDEX IF NOT EXISTS embedding_inputs_fingerprint ON embedding_inputs(embedding_fingerprint);
CREATE TABLE IF NOT EXISTS embedding_cache (
  cache_id INTEGER PRIMARY KEY,
  input_digest TEXT COLLATE BINARY NOT NULL,
  action_key TEXT COLLATE BINARY NOT NULL UNIQUE,
  embedding_fingerprint TEXT COLLATE BINARY NOT NULL,
  preprocessing TEXT NOT NULL,
  vector BLOB NOT NULL,
  task_kind TEXT NOT NULL DEFAULT 'document' CHECK (task_kind IN ('document','query')),
  unused_since INTEGER,
  created_at INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE IF NOT EXISTS cache_artifact_receipts (
  digest TEXT PRIMARY KEY COLLATE BINARY,
  profile TEXT COLLATE BINARY NOT NULL,
  received_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS cache_shard_membership (
  digest TEXT NOT NULL COLLATE BINARY,
  action_key TEXT NOT NULL COLLATE BINARY,
  task_kind TEXT NOT NULL CHECK(task_kind IN ('document','query')),
  profile TEXT NOT NULL COLLATE BINARY,
  PRIMARY KEY(digest,action_key,task_kind)
) STRICT;
CREATE INDEX IF NOT EXISTS cache_shard_membership_key ON cache_shard_membership(action_key,task_kind);
CREATE TABLE IF NOT EXISTS cache_compaction_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  last_completed_at INTEGER NOT NULL DEFAULT 0
) STRICT;
INSERT OR IGNORE INTO cache_compaction_state(id,last_completed_at) VALUES(1,0);
CREATE TABLE IF NOT EXISTS cache_compaction_retirements (
  source_digest TEXT PRIMARY KEY COLLATE BINARY,
  replacement_set_id TEXT NOT NULL COLLATE BINARY,
  retire_after INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS cache_compaction_replacements (
  replacement_set_id TEXT NOT NULL COLLATE BINARY,
  digest TEXT NOT NULL COLLATE BINARY,
  PRIMARY KEY(replacement_set_id,digest)
) STRICT;
CREATE INDEX IF NOT EXISTS embedding_cache_fingerprint ON embedding_cache(embedding_fingerprint);
CREATE INDEX IF NOT EXISTS embedding_cache_lookup ON embedding_cache(input_digest, embedding_fingerprint, preprocessing, task_kind);
CREATE TABLE IF NOT EXISTS embedding_profiles (
  fingerprint TEXT PRIMARY KEY COLLATE BINARY,
  dimensions INTEGER NOT NULL CHECK(dimensions > 0),
  model_id TEXT NOT NULL DEFAULT '',
  endpoint_origin TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE TABLE IF NOT EXISTS lexical_notes (
  note_id INTEGER PRIMARY KEY REFERENCES notes(note_id) ON DELETE CASCADE,
  revision_id INTEGER NOT NULL REFERENCES note_revisions(revision_id) ON DELETE CASCADE,
  path_text TEXT COLLATE BINARY NOT NULL,
  filename TEXT COLLATE BINARY NOT NULL,
  title TEXT NOT NULL,
  headings TEXT NOT NULL,
  body TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS lexical_notes_revision ON lexical_notes(revision_id);
CREATE VIRTUAL TABLE IF NOT EXISTS lexical_notes_fts USING fts5(
  body, path_text, filename, title, headings,
  content='lexical_notes', content_rowid='note_id',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS lexical_notes_ai AFTER INSERT ON lexical_notes BEGIN
  INSERT INTO lexical_notes_fts(rowid,body,path_text,filename,title,headings)
  VALUES(new.note_id,new.body,new.path_text,new.filename,new.title,new.headings);
END;
CREATE TRIGGER IF NOT EXISTS lexical_notes_ad AFTER DELETE ON lexical_notes BEGIN
  INSERT INTO lexical_notes_fts(lexical_notes_fts,rowid,body,path_text,filename,title,headings)
  VALUES('delete',old.note_id,old.body,old.path_text,old.filename,old.title,old.headings);
END;
CREATE TRIGGER IF NOT EXISTS lexical_notes_au AFTER UPDATE ON lexical_notes BEGIN
  INSERT INTO lexical_notes_fts(lexical_notes_fts,rowid,body,path_text,filename,title,headings)
  VALUES('delete',old.note_id,old.body,old.path_text,old.filename,old.title,old.headings);
  INSERT INTO lexical_notes_fts(rowid,body,path_text,filename,title,headings)
  VALUES(new.note_id,new.body,new.path_text,new.filename,new.title,new.headings);
END;
`;
}
