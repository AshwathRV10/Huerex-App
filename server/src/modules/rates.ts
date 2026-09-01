import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { all, one, run, tx } from '../db/index.js';
import { audit } from '../audit/index.js';
import { assertPermission } from '../rbac/guard.js';
import { HttpError, parse, sendCsv, zText } from '../lib/http.js';

/**
 * Rate memory.
 *
 * Order A does not cost the same as order B. Dyeing moves with the colour,
 * knitting with the fabric, printing with the style, and every vendor quotes
 * differently. So a single "standard rate" table would be wrong the day it was
 * written.
 *
 * Instead every rate that has ever been accepted is remembered against the
 * context it was used in, and when a new sheet is being built the app offers
 * the most specific thing it has seen, with its provenance attached: "₹186/kg
 * — dyeing, PINK, used on HR-014 three weeks ago". The costing team accepts it
 * with Enter or types over it. Typing over it teaches the next order.
 */

export const RATE_KINDS = [
  'fabric_component', 'fabric_flat', 'trim', 'jobwork', 'cmt', 'overhead',
  'selling_price', 'consumption',
] as const;
export type RateKind = (typeof RATE_KINDS)[number];

/** How much each matched dimension narrows the guess. */
const WEIGHTS: Record<string, number> = {
  style: 100, buyer: 50, colour: 40, vendor: 30,
  fabric_type: 25, trim_item: 25, process: 25,
  component: 20, operation: 20, category: 20, uom: 5,
};

const DIMENSIONS = Object.keys(WEIGHTS);

export interface RateContext {
  kind: RateKind;
  /** Every other field is one of the DIMENSIONS below. */
  [dimension: string]: string | undefined;
  buyer?: string; style?: string; fabric_type?: string; colour?: string;
  trim_item?: string; process?: string; vendor?: string; component?: string;
  operation?: string; category?: string; uom?: string;
}

export interface RateSuggestion {
  id: number;
  rate: number;
  currency: string;
  uom: string;
  score: number;
  use_count: number;
  last_used_at: string;
  last_order_no: string;
  /** plain-English reason the app is offering this number */
  because: string;
  exact: boolean;
  matched: Record<string, string>;
}

interface RateRow {
  id: number; kind: string; buyer: string; style: string; fabric_type: string;
  colour: string; trim_item: string; process: string; vendor: string;
  component: string; operation: string; category: string; uom: string;
  rate: number; currency: string; use_count: number; last_used_at: string;
  last_order_no: string; first_seen_at: string;
}

function ago(iso: string): string {
  const days = Math.floor((Date.now() - new Date(`${iso.replace(' ', 'T')}Z`).getTime()) / 86_400_000);
  if (!Number.isFinite(days)) return 'previously';
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}

function describeMatch(row: RateRow, matched: Record<string, string>): string {
  const parts: string[] = [];
  if (matched.style) parts.push(`style ${matched.style}`);
  else if (matched.buyer) parts.push(matched.buyer);
  if (matched.colour) parts.push(matched.colour);
  if (matched.vendor) parts.push(`at ${matched.vendor}`);
  const where = parts.length ? parts.join(' · ') : 'any order';
  const when = row.last_order_no ? `on ${row.last_order_no}, ${ago(row.last_used_at)}` : ago(row.last_used_at);
  return `${where} — used ${when}`;
}

/**
 * Rank remembered rates against a context. A memory with a value in a field
 * matches only when the context agrees; a memory that leaves a field blank is
 * a wildcard and still matches, just with a lower score.
 */
export function suggestRates(ctx: RateContext, limit = 5): RateSuggestion[] {
  const where: string[] = ['kind = ?'];
  const params: unknown[] = [ctx.kind];
  for (const dim of DIMENSIONS) {
    const val = (ctx as Record<string, string | undefined>)[dim];
    // Either the memory is a wildcard for this dimension, or it agrees with us.
    if (val) { where.push(`(${dim} = '' OR ${dim} = ?)`); params.push(val); }
    else where.push(`${dim} = ''`);
  }

  const rows = all<RateRow>(
    `SELECT * FROM rate_memory WHERE ${where.join(' AND ')} ORDER BY last_used_at DESC LIMIT 200`,
    params,
  );

  return rows
    .map((row) => {
      let score = 0;
      const matched: Record<string, string> = {};
      for (const dim of DIMENSIONS) {
        const v = (row as unknown as Record<string, string>)[dim];
        if (v) { score += WEIGHTS[dim]; matched[dim] = v; }
      }
      // A rate used ten times is a better bet than one typed once, but never
      // enough to beat a genuinely more specific match.
      score += Math.min(row.use_count, 10);
      return {
        id: row.id, rate: row.rate, currency: row.currency, uom: row.uom,
        score, use_count: row.use_count, last_used_at: row.last_used_at,
        last_order_no: row.last_order_no,
        because: describeMatch(row, matched),
        exact: DIMENSIONS.every((d) => {
          const ctxVal = (ctx as Record<string, string | undefined>)[d] ?? '';
          return (row as unknown as Record<string, string>)[d] === ctxVal;
        }),
        matched,
      };
    })
    .sort((a, b) => b.score - a.score || b.use_count - a.use_count || (a.last_used_at < b.last_used_at ? 1 : -1))
    .slice(0, limit);
}

export function bestRate(ctx: RateContext): RateSuggestion | undefined {
  return suggestRates(ctx, 1)[0];
}

/**
 * Write a rate back to memory at both the scope it was used at and one step
 * broader.
 *
 * Dyeing genuinely moves with the colour, but yarn and knitting do not — and a
 * memory recorded only against PINK is no use at all on the next order in
 * LIME. So each rate is stored twice: once bound to the colour (or vendor),
 * which wins whenever that colour comes round again, and once unbound, which
 * is offered as a starting point otherwise. The suggestion says which it is,
 * so nobody mistakes "last dyeing rate we paid, on another colour" for a quote.
 */
export function rememberRateWithFallback(
  ctx: RateContext,
  rate: number,
  broaden: (keyof RateContext)[],
  opts: Parameters<typeof rememberRate>[2] = {},
): void {
  rememberRate(ctx, rate, opts);
  const wider = { ...ctx };
  let changed = false;
  for (const key of broaden) {
    if (wider[key]) { wider[key] = ''; changed = true; }
  }
  if (changed) rememberRate(wider, rate, opts);
}

/** Write a rate back to memory. Called whenever a cost sheet line is saved. */
export function rememberRate(
  ctx: RateContext, rate: number, opts: { orderNo?: string; costSheetId?: number; userId?: number | null; currency?: string } = {},
): void {
  if (!Number.isFinite(rate) || rate <= 0) return;
  const vals = DIMENSIONS.map((d) => ((ctx as Record<string, string | undefined>)[d] ?? '').trim());
  const currency = opts.currency ?? 'INR';

  tx(() => {
    const existing = one<{ id: number; rate: number }>(
      `SELECT id, rate FROM rate_memory
        WHERE kind = ? AND buyer = ? AND style = ? AND fabric_type = ? AND colour = ?
          AND trim_item = ? AND process = ? AND vendor = ? AND component = ?
          AND operation = ? AND category = ? AND uom = ?`,
      [ctx.kind, ...reorder(vals)],
    );

    let id: number;
    let previous: number | null = null;
    if (existing) {
      previous = existing.rate;
      id = existing.id;
      run(
        `UPDATE rate_memory SET rate = ?, currency = ?, use_count = use_count + 1,
                last_used_at = datetime('now'), last_order_no = ? WHERE id = ?`,
        [rate, currency, opts.orderNo ?? '', id],
      );
    } else {
      const info = run(
        `INSERT INTO rate_memory (kind, buyer, style, fabric_type, colour, trim_item, process,
                                  vendor, component, operation, category, uom, rate, currency,
                                  last_order_no, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [ctx.kind, ...reorder(vals), rate, currency, opts.orderNo ?? '', opts.userId ?? null],
      );
      id = info.lastInsertRowid as number;
    }

    if (previous === null || Math.abs(previous - rate) > 1e-9) {
      run(
        `INSERT INTO rate_history (rate_memory_id, order_no, cost_sheet_id, rate, previous_rate, user_id)
         VALUES (?,?,?,?,?,?)`,
        [id, opts.orderNo ?? '', opts.costSheetId ?? null, rate, previous, opts.userId ?? null],
      );
    }
  });
}

/** DIMENSIONS is declaration order; the SQL above expects table column order. */
function reorder(vals: string[]): string[] {
  const map = Object.fromEntries(DIMENSIONS.map((d, i) => [d, vals[i]]));
  return ['buyer', 'style', 'fabric_type', 'colour', 'trim_item', 'process',
    'vendor', 'component', 'operation', 'category', 'uom'].map((d) => map[d] ?? '');
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const CtxSchema = z.object({
  kind: z.enum(RATE_KINDS),
  buyer: zText(160).optional(), style: zText(200).optional(),
  fabric_type: zText(120).optional(), colour: zText(120).optional(),
  trim_item: zText(120).optional(), process: zText(80).optional(),
  vendor: zText(160).optional(), component: zText(80).optional(),
  operation: zText(80).optional(), category: zText(80).optional(),
  uom: zText(20).optional(),
});

export function registerRates(app: FastifyInstance): void {
  app.get('/api/rates/suggest', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'rates.view');
    const ctx = parse(CtxSchema, req.query);
    return reply.send(suggestRates(ctx as RateContext, 6));
  });

  app.get('/api/rates', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'rates.view');
    const q = req.query as Record<string, string>;
    const where: string[] = ['1=1'];
    const params: unknown[] = [];
    if (q.kind) { where.push('kind = ?'); params.push(q.kind); }
    if (q.buyer) { where.push('buyer = ?'); params.push(q.buyer); }
    if (q.q) {
      where.push(`(fabric_type LIKE ? OR colour LIKE ? OR trim_item LIKE ? OR process LIKE ?
                   OR vendor LIKE ? OR component LIKE ? OR operation LIKE ? OR category LIKE ?
                   OR style LIKE ? OR buyer LIKE ?)`);
      for (let i = 0; i < 10; i += 1) params.push(`%${q.q}%`);
    }
    const rows = all<RateRow>(
      `SELECT * FROM rate_memory WHERE ${where.join(' AND ')}
        ORDER BY use_count DESC, last_used_at DESC LIMIT ?`,
      [...params, Math.min(Number(q.limit) || 300, 1000)],
    );
    return reply.send(rows);
  });

  app.get('/api/rates/:id/history', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'rates.view');
    const id = Number((req.params as { id: string }).id);
    const memory = one<RateRow>('SELECT * FROM rate_memory WHERE id = ?', [id]);
    if (!memory) throw new HttpError(404, 'No such rate', 'not_found');
    const history = all(
      `SELECT h.*, u.full_name AS changed_by FROM rate_history h
         LEFT JOIN users u ON u.id = h.user_id
        WHERE h.rate_memory_id = ? ORDER BY h.at DESC LIMIT 100`, [id],
    );
    return reply.send({ memory, history });
  });

  app.post('/api/rates', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'rates.create');
    const body = parse(CtxSchema.extend({
      rate: z.coerce.number().positive(),
      currency: zText(8).default('INR'),
    }), req.body);
    const { rate, currency, ...ctx } = body;
    rememberRate(ctx, rate, { userId: req.principal?.userId, currency });
    audit(req, { action: 'create', entity: 'rate_memory', summary: `Set ${body.kind} rate to ${rate}`, after: body });
    return reply.code(201).send({ ok: true });
  });

  app.patch('/api/rates/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'rates.edit');
    const id = Number((req.params as { id: string }).id);
    const before = one<RateRow>('SELECT * FROM rate_memory WHERE id = ?', [id]);
    if (!before) throw new HttpError(404, 'No such rate', 'not_found');
    const body = parse(z.object({ rate: z.coerce.number().positive() }), req.body);
    tx(() => {
      run(`UPDATE rate_memory SET rate = ?, last_used_at = datetime('now') WHERE id = ?`, [body.rate, id]);
      run(
        `INSERT INTO rate_history (rate_memory_id, rate, previous_rate, user_id) VALUES (?,?,?,?)`,
        [id, body.rate, before.rate, req.principal?.userId ?? null],
      );
    });
    const after = one<RateRow>('SELECT * FROM rate_memory WHERE id = ?', [id]);
    audit(req, { action: 'update', entity: 'rate_memory', entityId: id, summary: `Rate changed from ${before.rate} to ${body.rate}`, before, after });
    return reply.send(after);
  });

  app.delete('/api/rates/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'rates.delete');
    const id = Number((req.params as { id: string }).id);
    const before = one<RateRow>('SELECT * FROM rate_memory WHERE id = ?', [id]);
    if (!before) throw new HttpError(404, 'No such rate', 'not_found');
    run('DELETE FROM rate_memory WHERE id = ?', [id]);
    audit(req, { action: 'delete', entity: 'rate_memory', entityId: id, summary: 'Forgot a remembered rate', before, severity: 'warning' });
    return reply.send({ deleted: true });
  });

  app.get('/api/rates/export', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'rates.export');
    const rows = all('SELECT * FROM rate_memory ORDER BY kind, buyer, style') as Record<string, unknown>[];
    audit(req, { action: 'export', entity: 'rate_memory', summary: `Exported ${rows.length} rates`, severity: 'notice' });
    return sendCsv(reply, `rate-library-${new Date().toISOString().slice(0, 10)}.csv`, rows);
  });
}
