import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../db/index.js';
import { env } from '../env.js';

/**
 * Nightly backup.
 *
 * `VACUUM INTO` writes a complete, consistent copy of the database while the
 * app keeps running — no file copying, no torn WAL, no stopping the factory.
 * Files land in a plain folder so they can be picked up by whatever the site
 * already uses: a NAS mount, a synced folder, a USB disk someone takes home.
 *
 * Retention keeps every backup for two weeks, then one a week, then one a
 * month, so a mistake noticed in March can still be undone from January.
 */

export interface BackupResult { file: string; path: string; bytes: number; at: string; kind: string }

let lastRun: BackupResult | null = null;
let lastError: string | null = null;

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export function runBackup(kind: 'nightly' | 'manual' | 'startup' = 'nightly'): BackupResult {
  if (!existsSync(env.backupDir)) mkdirSync(env.backupDir, { recursive: true });
  const file = `huerex-${stamp()}-${kind}.sqlite`;
  const path = join(env.backupDir, file);

  try {
    // A quoted literal is required here; the path is ours, not user input.
    db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
    const bytes = statSync(path).size;
    lastRun = { file, path, bytes, at: new Date().toISOString(), kind };
    lastError = null;
    prune();
    return lastRun;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

export interface BackupFile { file: string; bytes: number; at: string }

export function listBackups(): BackupFile[] {
  if (!existsSync(env.backupDir)) return [];
  return readdirSync(env.backupDir)
    .filter((f) => f.startsWith('huerex-') && f.endsWith('.sqlite'))
    .map((f) => {
      const s = statSync(join(env.backupDir, f));
      return { file: f, bytes: s.size, at: s.mtime.toISOString() };
    })
    .sort((a, b) => (a.at < b.at ? 1 : -1));
}

/** Keep N daily, then one per week, then one per month. */
function prune(): void {
  const files = listBackups();
  if (files.length <= env.backupKeepDaily) return;

  const keep = new Set<string>();
  const weeks = new Set<string>();
  const months = new Set<string>();
  let dailyKept = 0;

  for (const f of files) {
    const d = new Date(f.at);
    if (dailyKept < env.backupKeepDaily) { keep.add(f.file); dailyKept += 1; continue; }

    const week = `${d.getUTCFullYear()}-W${Math.ceil(((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7)}`;
    if (weeks.size < env.backupKeepWeekly && !weeks.has(week)) { weeks.add(week); keep.add(f.file); continue; }

    const month = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    if (months.size < env.backupKeepMonthly && !months.has(month)) { months.add(month); keep.add(f.file); continue; }
  }

  for (const f of files) {
    if (!keep.has(f.file)) {
      try { unlinkSync(join(env.backupDir, f.file)); } catch { /* already gone */ }
    }
  }
}

export function backupStatus() {
  const files = listBackups();
  return {
    enabled: env.backupEnabled,
    directory: env.backupDir,
    scheduled_at: env.backupCron,
    retention: {
      daily: env.backupKeepDaily,
      weekly: env.backupKeepWeekly,
      monthly: env.backupKeepMonthly,
    },
    last_run: lastRun,
    last_error: lastError,
    count: files.length,
    newest: files[0] ?? null,
    total_bytes: files.reduce((s, f) => s + f.bytes, 0),
  };
}

/**
 * A plain interval timer rather than a cron dependency: it checks every minute
 * whether the wall clock has passed the configured HH:MM and it has not
 * already run today. Survives clock changes and restarts.
 */
export function scheduleBackups(log: (m: string) => void = console.log): NodeJS.Timeout | null {
  if (!env.backupEnabled) {
    log('  backups disabled (BACKUP_ENABLED=false)');
    return null;
  }
  const [hh, mm] = env.backupCron.split(':').map(Number);
  let lastDay = '';

  const timer = setInterval(() => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (day === lastDay) return;
    if (now.getHours() < hh || (now.getHours() === hh && now.getMinutes() < mm)) return;
    lastDay = day;
    try {
      const r = runBackup('nightly');
      log(`  nightly backup written: ${r.file} (${(r.bytes / 1_048_576).toFixed(1)} MB)`);
    } catch (err) {
      log(`  nightly backup FAILED: ${err instanceof Error ? err.message : err}`);
    }
  }, 60_000);

  timer.unref?.();
  log(`  nightly backup scheduled for ${env.backupCron} into ${env.backupDir}`);
  return timer;
}
