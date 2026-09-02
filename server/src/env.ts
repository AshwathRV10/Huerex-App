import { existsSync, mkdirSync } from 'node:fs';
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
