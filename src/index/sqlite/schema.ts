export const SQLITE_APPLICATION_ID = 0x54524d41;
export const SQLITE_SCHEMA_VERSION = 4;

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
  extraction_version INTEGER NOT NULL,
  chunk_algorithm_version INTEGER NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions > 0),
  fingerprint TEXT NOT NULL,
  incomplete INTEGER NOT NULL CHECK (incomplete IN (0,1)),
  change_counter INTEGER NOT NULL CHECK (change_counter >= 0),
  reconciliation_summary TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE TABLE IF NOT EXISTS notes (
  note_pk INTEGER PRIMARY KEY,
  path TEXT COLLATE BINARY NOT NULL UNIQUE,
  content_id TEXT COLLATE BINARY NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS notes_content_id ON notes(content_id);
CREATE TABLE IF NOT EXISTS chunks (
  chunk_pk INTEGER PRIMARY KEY,
  note_pk INTEGER NOT NULL REFERENCES notes(note_pk) ON DELETE CASCADE,
  chunk_id TEXT COLLATE BINARY NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  start_line INTEGER NOT NULL CHECK (start_line >= 1),
  end_line INTEGER NOT NULL CHECK (end_line >= start_line),
  path_text TEXT COLLATE BINARY NOT NULL,
  filename TEXT COLLATE BINARY NOT NULL,
  body TEXT NOT NULL,
  embedding BLOB NOT NULL,
  UNIQUE(note_pk, ordinal),
  UNIQUE(note_pk, chunk_id)
) STRICT;
CREATE INDEX IF NOT EXISTS chunks_note_ordinal ON chunks(note_pk, ordinal);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  body, path_text, filename, content='chunks', content_rowid='chunk_pk', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, body, path_text, filename) VALUES (new.chunk_pk, new.body, new.path_text, new.filename);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, body, path_text, filename) VALUES ('delete', old.chunk_pk, old.body, old.path_text, old.filename);
END;
CREATE TRIGGER IF NOT EXISTS chunks_au_fts AFTER UPDATE OF body, path_text, filename ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, body, path_text, filename) VALUES ('delete', old.chunk_pk, old.body, old.path_text, old.filename);
  INSERT INTO chunks_fts(rowid, body, path_text, filename) VALUES (new.chunk_pk, new.body, new.path_text, new.filename);
END;
`;
}
