import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../rbac/guard.js';

export { HttpError };

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first.path.join('.');
    throw new HttpError(400, path ? `${path}: ${first.message}` : first.message, 'invalid_input');
  }
  return result.data;
}

/** ISO date (YYYY-MM-DD). The whole app stores dates as text in this shape. */
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date (YYYY-MM-DD)');
export const zOptDate = z.union([zDate, z.literal(''), z.null()]).optional()
  .transform((v) => (v === '' ? null : v ?? null));
export const zText = (max = 240) => z.string().trim().max(max);
export const zQty = z.coerce.number().int().min(0);
export const zNum = z.coerce.number();
export const zBool = z.union([z.boolean(), z.literal(0), z.literal(1), z.literal('true'), z.literal('false')])
  .transform((v) => v === true || v === 1 || v === 'true');

export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  if (rows.length === 0) return '';
  const cols = columns ?? Object.keys(rows[0]);
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    // A leading =, +, - or @ turns a CSV cell into a formula in Excel.
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}

export function sendCsv(reply: FastifyReply, filename: string, rows: Record<string, unknown>[], columns?: string[]): void {
  reply
    .header('Content-Type', 'text/csv; charset=utf-8')
    .header('Content-Disposition', `attachment; filename="${filename.replace(/[^\w.\-]/g, '_')}"`)
    .send(`﻿${toCsv(rows, columns)}`);
}

export function clientIp(req: FastifyRequest): string {
  return (req.headers['x-forwarded-for'] as string ?? req.ip ?? '').split(',')[0].trim();
}

export const nowIso = (): string => new Date().toISOString().replace('T', ' ').slice(0, 19);
export const todayIso = (): string => new Date().toISOString().slice(0, 10);
