import Database, { type Database as DB } from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

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

const MIGRATIONS: { version: number; sql: string }[] = [
  { version: 1, sql: MIGRATION_001_INIT },
  { version: 2, sql: MIGRATION_002_SDK_SESSION_ID },
];

export function openDatabase(dbPath: string): DB {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
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
