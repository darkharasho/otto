import Database, { type Database as DB } from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import * as sqliteVec from 'sqlite-vec';

// Migrations are inlined as TypeScript strings so they survive bundling by
// electron-vite. Previously this loaded a .sql file from disk, which failed
// in the bundled main process because the file wasn't copied to out/main/.
const MIGRATION_001_INIT = `
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  title        TEXT,
  created_at   INTEGER NOT NULL,
  last_active  INTEGER NOT NULL,
  model        TEXT NOT NULL,
  status       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  role         TEXT NOT NULL,
  content      TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);
`;

const MIGRATION_002_SDK_SESSION_ID = `
ALTER TABLE sessions ADD COLUMN sdk_session_id TEXT;
`;

const MIGRATION_003_ARTIFACTS = `
CREATE TABLE IF NOT EXISTS artifact (
  id                 TEXT PRIMARY KEY,
  kind               TEXT NOT NULL,
  title              TEXT NOT NULL,
  body               TEXT NOT NULL,
  tags               TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  source_session_id  TEXT,
  use_count          INTEGER NOT NULL DEFAULT 0,
  last_used_at       INTEGER,
  archived           INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS artifact_kind_idx ON artifact(kind);
CREATE INDEX IF NOT EXISTS artifact_archived_idx ON artifact(archived);

CREATE VIRTUAL TABLE IF NOT EXISTS artifact_fts USING fts5(
  title, body, tags,
  content='artifact',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS artifact_ai AFTER INSERT ON artifact BEGIN
  INSERT INTO artifact_fts(rowid, title, body, tags)
  VALUES (new.rowid, new.title, new.body, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS artifact_ad AFTER DELETE ON artifact BEGIN
  INSERT INTO artifact_fts(artifact_fts, rowid, title, body, tags)
  VALUES ('delete', old.rowid, old.title, old.body, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS artifact_au AFTER UPDATE ON artifact BEGIN
  INSERT INTO artifact_fts(artifact_fts, rowid, title, body, tags)
  VALUES ('delete', old.rowid, old.title, old.body, old.tags);
  INSERT INTO artifact_fts(rowid, title, body, tags)
  VALUES (new.rowid, new.title, new.body, new.tags);
END;
`;

const MIGRATION_004_FACTS = `
CREATE TABLE IF NOT EXISTS fact (
  id                 TEXT PRIMARY KEY,
  body               TEXT NOT NULL,
  body_norm          TEXT NOT NULL,
  pinned             INTEGER NOT NULL DEFAULT 0,
  use_count          INTEGER NOT NULL DEFAULT 0,
  distinct_sessions  INTEGER NOT NULL DEFAULT 0,
  score              REAL NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  last_used_at       INTEGER,
  source_session_id  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS fact_body_norm_idx ON fact(body_norm);
CREATE INDEX IF NOT EXISTS fact_pinned_idx ON fact(pinned);

CREATE TABLE IF NOT EXISTS fact_session (
  fact_id    TEXT NOT NULL REFERENCES fact(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  PRIMARY KEY (fact_id, session_id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS fact_fts USING fts5(
  body,
  content='fact',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS fact_ai AFTER INSERT ON fact BEGIN
  INSERT INTO fact_fts(rowid, body) VALUES (new.rowid, new.body);
END;

CREATE TRIGGER IF NOT EXISTS fact_ad AFTER DELETE ON fact BEGIN
  INSERT INTO fact_fts(fact_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
END;

CREATE TRIGGER IF NOT EXISTS fact_au AFTER UPDATE ON fact BEGIN
  INSERT INTO fact_fts(fact_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
  INSERT INTO fact_fts(rowid, body) VALUES (new.rowid, new.body);
END;
`;

const MIGRATION_005_VEC = `
CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(
  embedding float[384],
  +kind text,
  +ref_id text
);
`;

const MIGRATIONS: { version: number; sql: string }[] = [
  { version: 1, sql: MIGRATION_001_INIT },
  { version: 2, sql: MIGRATION_002_SDK_SESSION_ID },
  { version: 3, sql: MIGRATION_003_ARTIFACTS },
  { version: 4, sql: MIGRATION_004_FACTS },
  { version: 5, sql: MIGRATION_005_VEC },
];

export function openDatabase(dbPath: string): DB {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  // sqlite-vec ships per-platform loadable extensions. Load before migrations so
  // migration 005 can use the vec0 virtual table.
  db.loadExtension(sqliteVec.getLoadablePath());
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function runMigrations(db: DB): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)');
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as {
    v: number | null;
  };
  const current = row.v ?? 0;
  const insert = db.prepare('INSERT INTO schema_version(version) VALUES (?)');
  const txn = db.transaction(() => {
    for (const m of MIGRATIONS) {
      if (m.version > current) {
        db.exec(m.sql);
        insert.run(m.version);
      }
    }
  });
  txn();
}
