import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined) return dflt;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function int(v: string | undefined, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/**
 * Paths are anchored to the installation, not to the working directory.
 *
 * This file lives at <root>/server/src/env.ts in development and
 * <root>/server/dist/env.js once built, so two levels up is always the
 * repository root. Deriving it from process.cwd() instead would mean
 * `npm run seed` (which runs inside server/) and a direct `node dist/index.js`
 * quietly opened two different database files.
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

/**
 * Settings come from a `.env` file beside the installation, if there is one.
 *
 * .env.example has always told the reader to copy it to .env and set DB_PATH
 * so the database lives somewhere the app folder being replaced cannot touch.
 * Nothing read that file, so following the instruction did nothing at all —
 * and silently: the server started, worked, and kept writing the database
 * inside the installation, where the next upgrade deletes it.
 *
 * A real environment variable always wins over the file. Docker Compose, the
 * CI workflow and the test harness all pass their settings that way, and a
 * stale .env left in a checkout must never override what the operator set on
 * the command line.
 */
export function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
    if (!key || key in process.env) continue;
    let value = line.slice(eq + 1).trim();
    // Quotes let a value keep spaces or a trailing #; unquoted values stop at
    // the first comment marker, so `PORT=4000  # the LAN port` is still 4000.
    if ((value.startsWith('"') && value.endsWith('"') && value.length > 1)
      || (value.startsWith("'") && value.endsWith("'") && value.length > 1)) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    process.env[key] = value;
  }
}

loadEnvFile(process.env.ENV_FILE ?? `${root}/.env`);

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProd: process.env.NODE_ENV === 'production',

  host: process.env.HOST ?? '0.0.0.0',
  port: int(process.env.PORT, 4000),

  /** Absolute path to the SQLite file. Lives outside the repo in production. */
  dbPath: resolve(process.env.DB_PATH ?? `${root}/data/huerex.sqlite`),

  /** Nightly backup destination. Point this at a NAS mount or a synced folder. */
  backupDir: resolve(process.env.BACKUP_DIR ?? `${root}/backups`),
  backupCron: process.env.BACKUP_CRON ?? '02:30',
  backupKeepDaily: int(process.env.BACKUP_KEEP_DAILY, 14),
  backupKeepWeekly: int(process.env.BACKUP_KEEP_WEEKLY, 8),
  backupKeepMonthly: int(process.env.BACKUP_KEEP_MONTHLY, 12),
  backupEnabled: bool(process.env.BACKUP_ENABLED, true),

  sessionCookie: process.env.SESSION_COOKIE ?? 'huerex_sid',
  sessionTtlHours: int(process.env.SESSION_TTL_HOURS, 12),
  sessionIdleMinutes: int(process.env.SESSION_IDLE_MINUTES, 240),
  /** Set COOKIE_SECURE=false for plain-HTTP LAN use; true behind TLS/Tailscale. */
  cookieSecure: bool(process.env.COOKIE_SECURE, process.env.NODE_ENV === 'production'),

  maxLoginAttempts: int(process.env.MAX_LOGIN_ATTEMPTS, 8),
  lockoutMinutes: int(process.env.LOCKOUT_MINUTES, 15),

  /** Serve the built SPA from the same origin — one port on the LAN. */
  serveWeb: bool(process.env.SERVE_WEB, true),
  webDist: resolve(process.env.WEB_DIST ?? `${root}/web/dist`),

  trustProxy: bool(process.env.TRUST_PROXY, false),
  logLevel: process.env.LOG_LEVEL ?? 'info',

  seedPassword: process.env.SEED_ADMIN_PASSWORD ?? '',
};

export function ensureDirs(): void {
  for (const dir of [dirname(env.dbPath), env.backupDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}
