import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { all, one, run, scalar, tx } from '../db/index.js';
import { audit } from '../audit/index.js';
import { assertPermission } from '../rbac/guard.js';
import { redactMany, type RedactionSpec } from '../rbac/fieldPolicy.js';
import { HttpError, parse, sendCsv } from '../lib/http.js';
import { touchMasters } from './masters.js';

/**
 * Every transaction sheet in the factory behaves the same way: filter, add a
 * row, fix a row, remove a row, pull it out as CSV. Rather than write that
 * eleven times — and get the RBAC or the audit trail subtly wrong once — each
 * module declares its table, its schema and its permissions, and gets the rest.
 *
 * Bulk create is first-class, not an afterthought: the floor enters twenty
 * rows at a time and only a handful of fields change between them.
 */

export interface CrudConfig<S extends z.ZodTypeAny> {
  /** URL segment and permission module key, e.g. "cutting" */
  key: string;
  table: string;
  schema: S;
  /** columns accepted from the client, in table order */
  columns: string[];
  /** default ORDER BY */
  orderBy?: string;
  /** extra filters: query param -> SQL fragment using ? */
  filters?: Record<string, string>;
  /** master lists to keep fed from submitted values: column -> list_code */
  learns?: Record<string, string>;
  redaction?: RedactionSpec;
  /** hook run inside the write transaction, after the row is written */
  afterWrite?: (row: Record<string, unknown>, action: 'create' | 'update' | 'delete', req: FastifyRequest) => void;
  /** cross-field validation that needs the database */
  validate?: (row: Record<string, unknown>, id: number | null) => void;
  /** human label for one row, used in the audit summary */
  describe?: (row: Record<string, unknown>) => string;
  /** joins order_id -> orders for convenience columns */
  withOrder?: boolean;
}

const LIST_LIMIT = 500;

function orderIdFromNo(orderNo: string): number {
  const row = one<{ id: number }>('SELECT id FROM orders WHERE order_no = ?', [orderNo]);
  if (!row) throw new HttpError(400, `No order called "${orderNo}"`, 'unknown_order');
  return row.id;
}

/** Accepts either order_id or order_no so the UI can send whichever it has. */
export function normaliseOrder(body: Record<string, unknown>): Record<string, unknown> {
  if (body.order_no && !body.order_id) {
    return { ...body, order_id: orderIdFromNo(String(body.order_no)) };
  }
  return body;
}

export function registerCrud<S extends z.ZodTypeAny>(app: FastifyInstance, cfg: CrudConfig<S>): void {
  const base = `/api/${cfg.key}`;
  const cols = cfg.columns;
  const orderBy = cfg.orderBy ?? 'id DESC';
  const selectList = cfg.withOrder
    ? `SELECT t.*, o.order_no, o.buyer, o.style FROM ${cfg.table} t LEFT JOIN orders o ON o.id = t.order_id`
    : `SELECT t.* FROM ${cfg.table} t`;

  function buildWhere(q: Record<string, unknown>): { sql: string; params: unknown[] } {
    const where: string[] = ['1=1'];
    const params: unknown[] = [];
    if (q.order_no) { where.push('o.order_no = ?'); params.push(q.order_no); }
    if (q.order_id) { where.push('t.order_id = ?'); params.push(Number(q.order_id)); }
    if (q.from) { where.push('t.txn_date >= ?'); params.push(q.from); }
    if (q.to) { where.push('t.txn_date <= ?'); params.push(q.to); }
    for (const [param, frag] of Object.entries(cfg.filters ?? {})) {
      if (q[param] !== undefined && q[param] !== '') { where.push(frag); params.push(q[param]); }
    }
    return { sql: where.join(' AND '), params };
  }

  // ------------------------------------------------------------------ list
  app.get(base, async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, `${cfg.key}.view`);
    const q = req.query as Record<string, unknown>;
    const { sql, params } = buildWhere(q);
    const limit = Math.min(Number(q.limit) || LIST_LIMIT, 2000);
    const offset = Number(q.offset) || 0;
    const rows = all(`${selectList} WHERE ${sql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`, [...params, limit, offset]);
    const total = scalar<number>(
      `SELECT COUNT(*) AS c FROM ${cfg.table} t ${cfg.withOrder ? 'LEFT JOIN orders o ON o.id = t.order_id' : ''} WHERE ${sql}`,
      params,
    );
    const out = cfg.redaction ? redactMany(req, rows as Record<string, unknown>[], cfg.redaction) : rows;
    return reply.send({ rows: out, total, limit, offset });
  });

  // ---------------------------------------------------------------- export
  app.get(`${base}/export`, async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, `${cfg.key}.export`);
    const q = req.query as Record<string, unknown>;
    const { sql, params } = buildWhere(q);
    const rows = all(`${selectList} WHERE ${sql} ORDER BY ${orderBy}`, params) as Record<string, unknown>[];
    const out = cfg.redaction ? redactMany(req, rows, cfg.redaction) : rows;
    audit(req, { action: 'export', entity: cfg.table, summary: `Exported ${out.length} rows`, severity: 'notice' });
    return sendCsv(reply, `${cfg.key}-${new Date().toISOString().slice(0, 10)}.csv`, out);
  });

  // ---------------------------------------------------------------- create
  const createOne = (req: FastifyRequest, raw: unknown): Record<string, unknown> => {
    const body = parse(cfg.schema, normaliseOrder(raw as Record<string, unknown>)) as Record<string, unknown>;
    cfg.validate?.(body, null);
    const present = cols.filter((c) => body[c] !== undefined);
    const info = run(
      `INSERT INTO ${cfg.table} (${present.join(',')}${'created_by' in body ? '' : ', created_by'})
       VALUES (${present.map(() => '?').join(',')}${'created_by' in body ? '' : ', ?'})`,
      [...present.map((c) => body[c] as unknown), req.principal?.userId ?? null],
    );
    const row = one(`SELECT * FROM ${cfg.table} WHERE id = ?`, [info.lastInsertRowid]) as Record<string, unknown>;
    touchMasters(cfg.learns, body, req.principal?.userId);
    cfg.afterWrite?.(row, 'create', req);
    return row;
  };

  app.post(base, async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, `${cfg.key}.create`);
    const row = tx(() => createOne(req, req.body));
    audit(req, {
      action: 'create', entity: cfg.table, entityId: row.id as number,
      summary: cfg.describe?.(row) ?? `Added a ${cfg.key} row`, after: row,
    });
    return reply.code(201).send(row);
  });

  // Bulk create. The client sends the rows it wants; carry-forward happens in
  // the browser so the operator can see exactly what will be written.
  app.post(`${base}/bulk`, async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, `${cfg.key}.create`);
    const payload = parse(z.object({ rows: z.array(z.unknown()).min(1).max(500) }), req.body);
    const written = tx(() => payload.rows.map((r) => createOne(req, r)));
    audit(req, {
      action: 'bulk_create', entity: cfg.table,
      summary: `Added ${written.length} ${cfg.key} rows`,
      after: { count: written.length, ids: written.map((r) => r.id) },
    });
    return reply.code(201).send({ created: written.length, rows: written });
  });

  // ---------------------------------------------------------------- update
  app.patch(`${base}/:id`, async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, `${cfg.key}.edit`);
    const id = Number((req.params as { id: string }).id);
    const before = one(`SELECT * FROM ${cfg.table} WHERE id = ?`, [id]) as Record<string, unknown> | undefined;
    if (!before) throw new HttpError(404, 'That row is not there any more', 'not_found');

    const merged = normaliseOrder({ ...before, ...(req.body as Record<string, unknown>) });
    const body = parse(cfg.schema, merged) as Record<string, unknown>;
    cfg.validate?.(body, id);

    const after = tx(() => {
      const present = cols.filter((c) => body[c] !== undefined);
      run(
        `UPDATE ${cfg.table} SET ${present.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
        [...present.map((c) => body[c] as unknown), id],
      );
      const row = one(`SELECT * FROM ${cfg.table} WHERE id = ?`, [id]) as Record<string, unknown>;
      touchMasters(cfg.learns, body, req.principal?.userId);
      cfg.afterWrite?.(row, 'update', req);
      return row;
    });

    audit(req, {
      action: 'update', entity: cfg.table, entityId: id,
      summary: cfg.describe?.(after) ?? `Edited a ${cfg.key} row`,
      before, after,
    });
    return reply.send(after);
  });

  // ---------------------------------------------------------------- delete
  app.delete(`${base}/:id`, async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, `${cfg.key}.delete`);
    const id = Number((req.params as { id: string }).id);
    const before = one(`SELECT * FROM ${cfg.table} WHERE id = ?`, [id]) as Record<string, unknown> | undefined;
    if (!before) throw new HttpError(404, 'That row is not there any more', 'not_found');
    tx(() => {
      run(`DELETE FROM ${cfg.table} WHERE id = ?`, [id]);
      cfg.afterWrite?.(before, 'delete', req);
    });
    audit(req, {
      action: 'delete', entity: cfg.table, entityId: id,
      summary: cfg.describe?.(before) ?? `Deleted a ${cfg.key} row`,
      before, severity: 'warning',
    });
    return reply.send({ deleted: true });
  });
}
