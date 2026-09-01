import Database from 'better-sqlite3';
import { env, ensureDirs } from '../env.js';

ensureDirs();

export const db: Database.Database = new Database(env.dbPath);

// WAL keeps readers off the writer's back — important when the floor is
// hammering entry screens while management runs a report.
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

export type Row = Record<string, unknown>;

/** Run a function inside a transaction; nested calls join the outer one. */
export function tx<T>(fn: () => T): T {
  if (db.inTransaction) return fn();
  return db.transaction(fn)();
}

export function one<T = Row>(sql: string, params: unknown[] = []): T | undefined {
  return db.prepare(sql).get(...(params as never[])) as T | undefined;
}

export function all<T = Row>(sql: string, params: unknown[] = []): T[] {
  return db.prepare(sql).all(...(params as never[])) as T[];
}

export function run(sql: string, params: unknown[] = []): Database.RunResult {
  return db.prepare(sql).run(...(params as never[]));
}

export function scalar<T = number>(sql: string, params: unknown[] = []): T {
  const row = db.prepare(sql).get(...(params as never[])) as Record<string, T> | undefined;
  if (!row) return 0 as unknown as T;
  return Object.values(row)[0] as T;
}
