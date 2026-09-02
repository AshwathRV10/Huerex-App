import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Build the world the browser tests run against: one database, seeded from
 * the workbook, with nothing left over from the last run.
 *
 * This runs as the first half of the web server's own launch command rather
 * than as a Playwright global setup, because Playwright starts the web server
 * first — a setup step that reseeds afterwards leaves the server holding a
 * file that no longer exists, and every sign-in fails for a reason that looks
 * nothing like the cause.
 */

const root = process.cwd();
const server = resolve(root, 'server', 'dist', 'index.js');
const seed = resolve(root, 'server', 'dist', 'db', 'seed.js');

const DB_PATH = process.env.E2E_DB_PATH ?? resolve(root, 'data', 'e2e.sqlite');
const ADMIN_PW = process.env.E2E_ADMIN_PW ?? 'Runner#2026ci';

if (!existsSync(server) || !existsSync(seed)) {
  console.error(
    'The server has not been built. The browser tests drive the real, built\n'
    + 'application rather than a dev server, so run `npm run build` first.',
  );
  process.exit(1);
}

// A fresh database every run. The specs assert on seeded state — an order that
// has never been costed, a rate library still holding starting points — and
// none of that survives a second run against the same file.
mkdirSync(dirname(DB_PATH), { recursive: true });
for (const suffix of ['', '-wal', '-shm']) rmSync(`${DB_PATH}${suffix}`, { force: true });
rmSync(resolve(root, 'tests', 'e2e', '.auth'), { recursive: true, force: true });

const res = spawnSync(process.execPath, [seed], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, DB_PATH, SEED_ADMIN_PASSWORD: ADMIN_PW, BACKUP_ENABLED: 'false' },
});

if (res.status !== 0) {
  console.error(`Seeding failed (exit ${res.status}):\n${res.stdout}\n${res.stderr}`);
  process.exit(1);
}

console.log(`e2e database seeded at ${DB_PATH}`);
