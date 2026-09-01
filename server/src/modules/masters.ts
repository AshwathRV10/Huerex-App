import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { all, one, run, tx } from '../db/index.js';
import { audit } from '../audit/index.js';
import { assertPermission, can } from '../rbac/guard.js';
import { HttpError, parse, zText } from '../lib/http.js';

/**
 * Master data behind every "type to search, type to add" box in the app.
 *
 * The point is that nobody should have to leave a half-filled entry screen to
 * go and register a new colour. Typing a value that has never been seen before
 * creates it, attributes it, and it is offered to everyone from then on.
 *
 * Ordering is by how often a value is actually used, so the colour this
 * factory cuts every week sits above the one it used once in 2024.
 */

export const LISTS = [
  { code: 'buyers', label: 'Buyers' },
  { code: 'colours', label: 'Colours' },
  { code: 'sizes', label: 'Sizes' },
  { code: 'lines', label: 'Lines' },
  { code: 'order_status', label: 'Order status' },
  { code: 'vendors', label: 'Vendors' },
  { code: 'processes', label: 'Processes' },
  { code: 'jobwork_processes', label: 'Job work processes' },
  { code: 'approval_types', label: 'Buyer approval types' },
  { code: 'approval_status', label: 'Approval status' },
  { code: 'recut_status', label: 'Recut decisions' },
  { code: 'delay_reasons', label: 'Delay reasons' },
  { code: 'inspection_results', label: 'Inspection results' },
  { code: 'fabric_types', label: 'Fabric types' },
  { code: 'trim_items', label: 'Trim items' },
  { code: 'trim_uoms', label: 'Trim units' },
  { code: 'team', label: 'Merchandisers & planners' },
  { code: 'set_roles', label: 'Set roles' },
  { code: 'fabric_components', label: 'Fabric rate components' },
  { code: 'cmt_operations', label: 'CMT operations' },
  { code: 'overhead_categories', label: 'Other cost categories' },
  { code: 'fabric_parts', label: 'Garment parts' },
  { code: 'suppliers', label: 'Suppliers' },
  { code: 'currencies', label: 'Currencies' },
  { code: 'price_basis', label: 'Price basis' },
  { code: 'defect_types', label: 'Defect types' },
] as const;

export const LIST_CODES = new Set(LISTS.map((l) => l.code as string));

export interface MasterValue {
  id: number; list_code: string; value: string; sort_order: number;
  meta_json: string; is_active: number; use_count: number; last_used_at: string | null;
}

function assertList(code: string): void {
  if (!LIST_CODES.has(code)) throw new HttpError(400, `There is no list called "${code}"`, 'unknown_list');
}

/**
 * Remember a value that arrived on a transaction row. Silent by design — an
 * operator typing a new vendor on a job-work row should not be interrupted.
 */
export function learnValue(listCode: string, value: unknown, userId?: number | null): void {
  if (!value || typeof value !== 'string') return;
  const v = value.trim();
  if (!v || !LIST_CODES.has(listCode)) return;
  const existing = one<{ id: number }>(
    'SELECT id FROM master_values WHERE list_code = ? AND value = ? COLLATE NOCASE', [listCode, v],
  );
  if (existing) {
    run(`UPDATE master_values SET use_count = use_count + 1, last_used_at = datetime('now') WHERE id = ?`, [existing.id]);
  } else {
    run(
      `INSERT INTO master_values (list_code, value, created_by, use_count, last_used_at)
       VALUES (?,?,?,1,datetime('now'))`,
      [listCode, v, userId ?? null],
    );
  }
}

export function touchMasters(
  learns: Record<string, string> | undefined,
  body: Record<string, unknown>,
  userId?: number | null,
): void {
  if (!learns) return;
  for (const [column, listCode] of Object.entries(learns)) learnValue(listCode, body[column], userId);
}

export interface SearchResult { value: string; use_count: number; is_new?: boolean; meta?: Record<string, unknown> }

export function searchList(listCode: string, q: string, limit = 30): SearchResult[] {
  assertList(listCode);
  const term = q.trim();
  if (!term) {
    return all<MasterValue>(
      `SELECT * FROM master_values WHERE list_code = ? AND is_active = 1
        ORDER BY use_count DESC, sort_order, value COLLATE NOCASE LIMIT ?`,
      [listCode, limit],
    ).map((r) => ({ value: r.value, use_count: r.use_count, meta: JSON.parse(r.meta_json || '{}') }));
  }
  // Prefix matches first, then anything containing the term — the ordering an
  // operator expects when they type three letters and reach for Enter.
  return all<MasterValue & { pri: number }>(
    `SELECT *, CASE WHEN value LIKE ? THEN 0 ELSE 1 END AS pri
       FROM master_values
      WHERE list_code = ? AND is_active = 1 AND value LIKE ?
      ORDER BY pri, use_count DESC, length(value), value COLLATE NOCASE LIMIT ?`,
    [`${term}%`, listCode, `%${term}%`, limit],
  ).map((r) => ({ value: r.value, use_count: r.use_count, meta: JSON.parse(r.meta_json || '{}') }));
}

const CreateValue = z.object({
  list_code: z.string(),
  value: zText(160).min(1, 'cannot be empty'),
  meta: z.record(z.unknown()).optional(),
});

export function registerMasters(app: FastifyInstance): void {
  app.get('/api/masters/lists', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'masters.view');
    const counts = all<{ list_code: string; c: number }>(
      'SELECT list_code, COUNT(*) AS c FROM master_values WHERE is_active = 1 GROUP BY list_code',
    );
    const byCode = new Map(counts.map((c) => [c.list_code, c.c]));
    return reply.send(LISTS.map((l) => ({ ...l, count: byCode.get(l.code) ?? 0 })));
  });

  // Type-to-search. Deliberately available to anyone signed in: an operator
  // needs the colour list to log a cut even though they cannot edit masters.
  app.get('/api/masters/:list', async (req: FastifyRequest, reply: FastifyReply) => {
    const { list } = req.params as { list: string };
    const { q = '', limit } = req.query as { q?: string; limit?: string };
    assertList(list);
    return reply.send(searchList(list, q, Math.min(Number(limit) || 30, 200)));
  });

  // Type-to-add. Anyone who can create rows in a module that feeds this list
  // can add to it; the audit trail records who introduced the value.
  app.post('/api/masters', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = parse(CreateValue, req.body);
    assertList(body.list_code);
    if (!can(req, 'masters.create')) throw new HttpError(403, 'You cannot add new master values', 'forbidden');

    const existing = one<MasterValue>(
      'SELECT * FROM master_values WHERE list_code = ? AND value = ? COLLATE NOCASE',
      [body.list_code, body.value],
    );
    if (existing) {
      if (!existing.is_active) run('UPDATE master_values SET is_active = 1 WHERE id = ?', [existing.id]);
      return reply.send({ value: existing.value, created: false });
    }

    const info = run(
      `INSERT INTO master_values (list_code, value, meta_json, created_by, use_count, last_used_at)
       VALUES (?,?,?,?,1,datetime('now'))`,
      [body.list_code, body.value, JSON.stringify(body.meta ?? {}), req.principal?.userId ?? null],
    );
    audit(req, {
      action: 'create', entity: 'master_values', entityId: info.lastInsertRowid as number,
      summary: `Added "${body.value}" to ${body.list_code}`, after: body,
    });
    return reply.code(201).send({ value: body.value, created: true });
  });

  app.patch('/api/masters/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'masters.edit');
    const id = Number((req.params as { id: string }).id);
    const before = one<MasterValue>('SELECT * FROM master_values WHERE id = ?', [id]);
    if (!before) throw new HttpError(404, 'That value is not there any more', 'not_found');
    const body = parse(z.object({
      value: zText(160).min(1).optional(),
      is_active: z.boolean().optional(),
      sort_order: z.number().optional(),
    }), req.body);

    tx(() => {
      if (body.value !== undefined) run('UPDATE master_values SET value = ? WHERE id = ?', [body.value, id]);
      if (body.is_active !== undefined) run('UPDATE master_values SET is_active = ? WHERE id = ?', [body.is_active ? 1 : 0, id]);
      if (body.sort_order !== undefined) run('UPDATE master_values SET sort_order = ? WHERE id = ?', [body.sort_order, id]);
    });
    const after = one<MasterValue>('SELECT * FROM master_values WHERE id = ?', [id]);
    audit(req, { action: 'update', entity: 'master_values', entityId: id, summary: `Edited ${before.list_code} value`, before, after });
    return reply.send(after);
  });

  // Values in use are retired, not deleted — deleting one would orphan history.
  app.delete('/api/masters/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'masters.delete');
    const id = Number((req.params as { id: string }).id);
    const before = one<MasterValue>('SELECT * FROM master_values WHERE id = ?', [id]);
    if (!before) throw new HttpError(404, 'That value is not there any more', 'not_found');
    run('UPDATE master_values SET is_active = 0 WHERE id = ?', [id]);
    audit(req, {
      action: 'delete', entity: 'master_values', entityId: id,
      summary: `Retired "${before.value}" from ${before.list_code}`, before, severity: 'warning',
    });
    return reply.send({ retired: true });
  });
}
