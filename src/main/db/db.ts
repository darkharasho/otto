import Database, { type Database as DB } from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve directory of this source file in a way that works in both ESM (Vitest)
// and CJS (Electron main bundle) contexts. `__dirname` is not available under
// ESNext modules used by Vitest, so we fall back to `import.meta.url`.
const here = (() => {
  try {
    if (typeof __dirname !== 'undefined') return __dirname;
  } catch {
    /* not in CJS */
  }
  return path.dirname(fileURLToPath(import.meta.url));
})();

const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: fs.readFileSync(path.join(here, 'migrations', '001_init.sql'), 'utf8'),
  },
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
