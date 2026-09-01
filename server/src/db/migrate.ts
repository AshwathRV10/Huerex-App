import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));

// Migrations live next to the compiled JS in dist as well — copied by the build.
function migrationsDir(): string {
  return join(here, 'migrations');
}

export function migrate(log: (m: string) => void = console.log): number {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const applied = new Set(
    (db.prepare('SELECT name FROM _migrations').all() as { name: string }[]).map((r) => r.name),
  );

  const files = readdirSync(migrationsDir())
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir(), file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
    })();
    log(`  applied ${file}`);
    count += 1;
  }
  if (count === 0) log('  schema already up to date');
  return count;
}

if (process.argv[1] && process.argv[1].endsWith('migrate.ts')) {
  console.log('Running migrations…');
  migrate();
  console.log('Done.');
}
