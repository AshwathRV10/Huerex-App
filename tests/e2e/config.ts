import { resolve } from 'node:path';

/**
 * Everything the browser tests need to agree on, in one place.
 *
 * The database below is created from scratch on every run and thrown away, so
 * the tests can assert on exact seeded state — an order that has never been
 * costed, a rate library holding starting points — instead of writing around
 * whatever a previous run left behind.
 */

/**
 * The repository root. Playwright loads this file as CommonJS (the root
 * package is not ESM), so `import.meta` is not available — and both the
 * npm script and Playwright's own config resolution run from the root, so
 * the working directory is it.
 */
const root = process.cwd();

export const PORT = Number(process.env.E2E_PORT ?? 4124);
export const BASE = process.env.E2E_BASE ?? `http://127.0.0.1:${PORT}`;

/** Wiped and re-seeded before every run. Never point this at real data. */
export const DB_PATH = process.env.E2E_DB_PATH ?? resolve(root, 'data', 'e2e.sqlite');

/** Not a secret: it unlocks a database that exists only for the length of a run. */
export const ADMIN_PW = process.env.E2E_ADMIN_PW ?? 'Runner#2026ci';

export const AUTH_DIR = resolve(root, 'tests', 'e2e', '.auth');

/**
 * The people the tests sign in as. Each one exists to prove a different half
 * of the access model: what a role can reach, and what it must not see even
 * when it can reach the screen.
 */
export const USERS = {
  manager: {
    username: 'e2e.manager', full_name: 'E2E Manager', role: 'management',
    password: 'Testing#2026aa', state: `${AUTH_DIR}/manager.json`,
  },
  merch: {
    username: 'e2e.merch', full_name: 'E2E Merchandiser', role: 'merchandiser',
    password: 'Testing#2026aa', state: `${AUTH_DIR}/merch.json`,
  },
  store: {
    username: 'e2e.store', full_name: 'E2E Store Keeper', role: 'store',
    password: 'Testing#2026aa', state: `${AUTH_DIR}/store.json`,
  },
} as const;

/**
 * Two orders the workbook seeds and never costs. Each spec gets its own, so
 * neither depends on whether the other has run.
 */
export const COSTED_ORDER = 'HR-002';
export const PROPOSAL_ORDER = 'HR-003';
