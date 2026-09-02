import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { all, one, run, tx } from '../db/index.js';
import { audit } from '../audit/index.js';
import { assertPermission, can } from '../rbac/guard.js';
import { redact, redactMany, ORDER_SPEC } from '../rbac/fieldPolicy.js';
import { HttpError, parse, sendCsv, zDate, zText } from '../lib/http.js';
import { learnValue } from './masters.js';
import { effectiveExcessPct, wipForOrder, type OrderRow } from '../engine/facts.js';
import { plannedCut } from '../engine/flow.js';

/**
 * Orders, their route and their colour × size matrix.
 *
 * These three together are the setup for everything else, so the API makes it
 * possible to create all three in one call — the "new order" wizard sends one
 * payload and gets a fully set-up order back rather than leaving a half-made
 * one behind if a later step fails.
 */

const OrderBody = z.object({
  order_no: zText(60).min(1, 'every order needs a number'),
  buyer: zText(160).min(1, 'which buyer?'),
  style: zText(300).default(''),
  style_ref: zText(120).default(''),
  description: zText(600).default(''),
  order_qty: z.coerce.number().int().min(0).default(0),
  order_date: z.union([zDate, z.literal(''), z.null()]).optional().transform((v) => (v ? v : null)),
  ex_factory_date: z.union([zDate, z.literal(''), z.null()]).optional().transform((v) => (v ? v : null)),
  sew_complete_by: z.union([zDate, z.literal(''), z.null()]).optional().transform((v) => (v ? v : null)),
  sam: z.coerce.number().min(0).default(0),
  buffer_pct: z.coerce.number().min(0).max(1).default(0.05),
  excess_pct: z.coerce.number().min(0).max(100).nullable().default(null),
  merchandiser: zText(120).default(''),
  planner: zText(120).default(''),
  status: zText(40).default('Active'),
  set_group: zText(80).default(''),
  set_role: zText(40).default(''),
  fabric_lead_days: z.coerce.number().int().min(0).nullable().default(null),
  currency: zText(8).default('INR'),
  fx_rate: z.coerce.number().positive().default(1),
});

const RouteBody = z.object({
  steps: z.array(z.object({
    step_no: z.coerce.number().int().positive(),
    process: zText(80).min(1),
    type: z.enum(['In-house', 'Outsourced']).optional(),
    notes: zText(240).default(''),
  })).min(1, 'a route needs at least one step'),
});

const MatrixBody = z.object({
  cells: z.array(z.object({
    colour: zText(120).min(1),
    size: zText(60).min(1),
    order_qty: z.coerce.number().int().min(0),
    recut_decision: zText(60).default('-'),
  })),
  /** when true, cells not in the payload are removed */
  replace: z.boolean().default(false),
});

const OUTSOURCED_BY_DEFAULT = new Set(['Print', 'Embroidery', 'Wash', 'Tie&Dye', 'Rotary AOP', 'Other']);

function findOrder(orderNo: string): OrderRow {
  const row = one<OrderRow>('SELECT * FROM orders WHERE order_no = ?', [orderNo]);
  if (!row) throw new HttpError(404, `No order called "${orderNo}"`, 'unknown_order');
  return row;
}

function writeRoute(orderId: number, steps: z.infer<typeof RouteBody>['steps'], userId?: number | null): void {
  const seen = new Set<number>();
  for (const s of steps) {
    if (seen.has(s.step_no)) throw new HttpError(400, `Step ${s.step_no} appears twice. Number the steps 1, 2, 3…`, 'duplicate_step');
    seen.add(s.step_no);
  }
  const sorted = [...steps].sort((a, b) => a.step_no - b.step_no);
  if (sorted[0].process !== 'Cutting') {
    // A warning, not a refusal: some orders genuinely start elsewhere.
    // The data audit will flag it.
  }
  run('DELETE FROM order_route WHERE order_id = ?', [orderId]);
  for (const s of sorted) {
    run(
      'INSERT INTO order_route (order_id, step_no, process, type, notes) VALUES (?,?,?,?,?)',
      [orderId, s.step_no, s.process, s.type ?? (OUTSOURCED_BY_DEFAULT.has(s.process) ? 'Outsourced' : 'In-house'), s.notes],
    );
    learnValue('processes', s.process, userId);
    if (OUTSOURCED_BY_DEFAULT.has(s.process)) learnValue('jobwork_processes', s.process, userId);
  }
}

function writeMatrix(orderId: number, body: z.infer<typeof MatrixBody>, userId?: number | null): void {
  if (body.replace) {
    const keep = new Set(body.cells.map((c) => `${c.colour}|${c.size}`));
    for (const existing of all<{ id: number; colour: string; size: string }>(
      'SELECT id, colour, size FROM order_matrix WHERE order_id = ?', [orderId],
    )) {
      if (!keep.has(`${existing.colour}|${existing.size}`)) {
        run('DELETE FROM order_matrix WHERE id = ?', [existing.id]);
      }
    }
  }
  body.cells.forEach((c, i) => {
    run(
      `INSERT INTO order_matrix (order_id, colour, size, order_qty, recut_decision, sort_order)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(order_id, colour, size)
       DO UPDATE SET order_qty = excluded.order_qty, recut_decision = excluded.recut_decision`,
      [orderId, c.colour, c.size, c.order_qty, c.recut_decision, i],
    );
    learnValue('colours', c.colour, userId);
    learnValue('sizes', c.size, userId);
  });
}

/** The setup checks that used to live in a column of green and red text. */
export function setupIssues(order: OrderRow): string[] {
  const issues: string[] = [];
  const matrixQty = one<{ q: number; c: number }>(
    'SELECT COALESCE(SUM(order_qty),0) AS q, COUNT(*) AS c FROM order_matrix WHERE order_id = ?', [order.id],
  )!;
  const steps = all<{ step_no: number; process: string }>(
    'SELECT step_no, process FROM order_route WHERE order_id = ? ORDER BY step_no', [order.id],
  );

  if (matrixQty.c === 0) issues.push('No colour × size breakdown yet — nothing can be counted against this order.');
  else if (matrixQty.q !== order.order_qty) {
    issues.push(`The matrix adds up to ${matrixQty.q} but the order is ${order.order_qty}. They have to agree.`);
  }
  if (steps.length === 0) issues.push('No route — list the steps this order actually travels.');
  else {
    if (steps[0].process !== 'Cutting') issues.push(`Step 1 is ${steps[0].process}, not Cutting. That is allowed, but check it is deliberate.`);
    const nums = steps.map((s) => s.step_no);
    for (let i = 0; i < nums.length; i += 1) {
      if (nums[i] !== i + 1) { issues.push('Step numbers have a gap in them — renumber 1, 2, 3…'); break; }
    }
  }
  if (!order.order_date) issues.push('No order date, so cycle time cannot be measured.');
  if (!order.ex_factory_date) issues.push('No ex-factory date, so nothing can be called late.');
  if (!order.sam) issues.push('No SAM, so efficiency and capacity cannot be worked out.');
  if (order.set_group && !order.set_role) issues.push('Set group is set but no role — mark this order Primary or Secondary.');
  return issues;
}

export function registerOrders(app: FastifyInstance): void {
  // ------------------------------------------------------------------- list
/**
 * Everything an order owns, in the order a person would want to read it.
 *
 * `history` marks the tables that record work that actually happened on the
 * floor, as opposed to setup a person typed in. Losing setup is an
 * inconvenience; losing history changes what the factory believes it made.
 */
const OWNED_BY_ORDER: { table: string; label: string; history: boolean }[] = [
  { table: 'cutting', label: 'cutting entries', history: true },
  { table: 'fusing', label: 'fusing entries', history: true },
  { table: 'job_work', label: 'job-work movements', history: true },
  { table: 'sewing', label: 'sewing entries', history: true },
  { table: 'checking', label: 'checking entries', history: true },
  { table: 'packing', label: 'packing entries', history: true },
  { table: 'inspection', label: 'inspections', history: true },
  { table: 'shipment', label: 'shipments', history: true },
  { table: 'trims', label: 'trim receipts', history: true },
  { table: 'fabric_manual_consumption', label: 'weighed consumption', history: true },
  { table: 'cost_sheets', label: 'cost sheets', history: false },
  { table: 'buyer_approvals', label: 'buyer approvals', history: false },
  { table: 'alert_waivers', label: 'alert waivers', history: false },
  { table: 'order_route', label: 'route steps', history: false },
  { table: 'order_matrix', label: 'colour \u00d7 size cells', history: false },
];

interface DeletionImpact {
  rows: { table: string; label: string; history: boolean; count: number }[];
  /** Issued fabric returns to free stock rather than being destroyed. */
  fabric_movements: number;
  total: number;
  has_history: boolean;
}

/** What deleting this order would take with it, counted before anything goes. */
function deletionImpact(orderId: number): DeletionImpact {
  const rows = OWNED_BY_ORDER
    .map((t) => ({
      ...t,
      count: one<{ c: number }>(`SELECT COUNT(*) AS c FROM ${t.table} WHERE order_id = ?`, [orderId])!.c,
    }))
    .filter((t) => t.count > 0);

  return {
    rows,
    fabric_movements: one<{ c: number }>(
      'SELECT COUNT(*) AS c FROM fabric_ledger WHERE order_id = ?', [orderId],
    )!.c,
    total: rows.reduce((n, t) => n + t.count, 0),
    has_history: rows.some((t) => t.history),
  };
}

/** The impact as one readable clause, for the refusal message. */
function describe(impact: DeletionImpact): string {
  return impact.rows
    .filter((r) => r.history)
    .map((r) => `${r.count} ${r.label}`)
    .join(', ');
}

  app.get('/api/orders', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'orders.view');
    const q = req.query as Record<string, string>;
    const where = ['1=1'];
    const params: unknown[] = [];
    if (q.status) { where.push('status = ?'); params.push(q.status); }
    if (q.buyer) { where.push('buyer = ?'); params.push(q.buyer); }
    if (q.q) { where.push('(order_no LIKE ? OR style LIKE ? OR buyer LIKE ?)'); params.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`); }

    const rows = all<OrderRow>(
      `SELECT * FROM orders WHERE ${where.join(' AND ')}
        ORDER BY CASE status WHEN 'Active' THEN 0 ELSE 1 END, ex_factory_date, order_no
        LIMIT ?`, [...params, Math.min(Number(q.limit) || 300, 1000)],
    );

    const withProgress = rows.map((o) => {
      const matrix = one<{ q: number; c: number }>(
        'SELECT COALESCE(SUM(order_qty),0) AS q, COUNT(*) AS c FROM order_matrix WHERE order_id = ?', [o.id],
      )!;
      const cut = one<{ q: number }>('SELECT COALESCE(SUM(cut_qty),0) AS q FROM cutting WHERE order_id = ? AND counts_as_garment = 1', [o.id])!.q;
      const shipped = one<{ q: number }>('SELECT COALESCE(SUM(ship_qty),0) AS q FROM shipment WHERE order_id = ?', [o.id])!.q;
      const steps = one<{ c: number }>('SELECT COUNT(*) AS c FROM order_route WHERE order_id = ?', [o.id])!.c;
      const days = o.ex_factory_date
        ? Math.ceil((new Date(`${o.ex_factory_date}T00:00:00Z`).getTime() - Date.now()) / 86_400_000)
        : null;
      return {
        ...o,
        matrix_qty: matrix.q, matrix_cells: matrix.c, steps,
        cut, shipped,
        progress_pct: o.order_qty ? Math.min(100, Math.round((shipped / o.order_qty) * 100)) : 0,
        days_to_ex_factory: days,
        setup_ok: matrix.c > 0 && matrix.q === o.order_qty && steps > 0,
      };
    });

    return reply.send({ rows: redactMany(req, withProgress as unknown as Record<string, unknown>[], ORDER_SPEC) });
  });

  // -------------------------------------------------------------- one order
  app.get('/api/orders/:orderNo', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'orders.view');
    const order = findOrder((req.params as { orderNo: string }).orderNo);
    const route = all('SELECT * FROM order_route WHERE order_id = ? ORDER BY step_no', [order.id]);
    const excess = effectiveExcessPct(order);
    const matrix = all<Record<string, unknown>>(
      'SELECT * FROM order_matrix WHERE order_id = ? ORDER BY sort_order, colour, size', [order.id],
    ).map((m) => ({ ...m, planned_cut: plannedCut(Number(m.order_qty), excess, order.buffer_pct) }));
    const wip = can(req, 'wip.view') ? wipForOrder(order) : null;

    return reply.send({
      order: redact(req, order as unknown as Record<string, unknown>, ORDER_SPEC),
      route, matrix,
      excess_pct: excess,
      issues: setupIssues(order),
      wip: wip ? { cells: wip.cells, totals: wip.totals } : null,
    });
  });

  // ------------------------------------------------------------------ create
  app.post('/api/orders', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'orders.create');
    const body = parse(OrderBody.extend({
      route: RouteBody.shape.steps.optional(),
      matrix: MatrixBody.shape.cells.optional(),
    }), req.body);

    if (one('SELECT id FROM orders WHERE order_no = ?', [body.order_no])) {
      throw new HttpError(409, `Order ${body.order_no} already exists`, 'duplicate_order');
    }
    const userId = req.principal?.userId ?? null;

    const order = tx(() => {
      const cols = Object.keys(OrderBody.shape) as (keyof z.infer<typeof OrderBody>)[];
      const info = run(
        `INSERT INTO orders (${cols.join(',')}, created_by) VALUES (${cols.map(() => '?').join(',')}, ?)`,
        [...cols.map((c) => body[c] as unknown), userId],
      );
      const id = info.lastInsertRowid as number;
      learnValue('buyers', body.buyer, userId);
      if (body.merchandiser) learnValue('team', body.merchandiser, userId);
      if (body.planner) learnValue('team', body.planner, userId);
      if (body.route) writeRoute(id, body.route, userId);
      if (body.matrix) writeMatrix(id, { cells: body.matrix, replace: true }, userId);

      // Keep the buyer master in step, so a new buyer is immediately usable
      // with its own excess rule rather than silently defaulting to zero.
      run(
        `INSERT INTO buyers (name) VALUES (?) ON CONFLICT(name) DO NOTHING`, [body.buyer],
      );
      return one<OrderRow>('SELECT * FROM orders WHERE id = ?', [id])!;
    });

    audit(req, {
      action: 'create', entity: 'orders', entityId: order.id,
      summary: `Created order ${order.order_no} for ${order.buyer}`, after: order,
    });
    return reply.code(201).send(order);
  });

  // ------------------------------------------------------------------ update
  app.patch('/api/orders/:orderNo', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'orders.edit');
    const before = findOrder((req.params as { orderNo: string }).orderNo);
    const incoming = req.body as Record<string, unknown>;
    // A field the caller cannot edit is ignored rather than rejected, so a
    // merchandiser saving the whole form does not fail on a locked field.
    if (!can(req, 'orders.excess_pct.edit')) delete incoming.excess_pct;
    if (!can(req, 'orders.fx_rate.edit')) delete incoming.fx_rate;

    const body = parse(OrderBody, { ...before, ...incoming });
    const after = tx(() => {
      const cols = Object.keys(OrderBody.shape) as (keyof z.infer<typeof OrderBody>)[];
      run(
        `UPDATE orders SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
        [...cols.map((c) => body[c] as unknown), before.id],
      );
      learnValue('buyers', body.buyer, req.principal?.userId);
      return one<OrderRow>('SELECT * FROM orders WHERE id = ?', [before.id])!;
    });
    audit(req, {
      action: 'update', entity: 'orders', entityId: before.id,
      summary: `Edited order ${after.order_no}`, before, after,
    });
    return reply.send(redact(req, after as unknown as Record<string, unknown>, ORDER_SPEC));
  });

  app.get('/api/orders/:orderNo/delete-preview', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'orders.delete');
    const order = findOrder((req.params as { orderNo: string }).orderNo);
    return reply.send(deletionImpact(order.id));
  });

  app.delete('/api/orders/:orderNo', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'orders.delete');
    const before = findOrder((req.params as { orderNo: string }).orderNo);
    const impact = deletionImpact(before.id);
    const confirmed = (req.query as { confirm?: string }).confirm === before.order_no;

    /**
     * An order nobody has worked on goes quietly. One with production against
     * it takes the order number typed back, because deleting it silently
     * rewrites WIP, reconciliation and the buyer's book — every report the
     * order appears in changes, and there is no undo short of last night's
     * backup.
     */
    if (impact.has_history && !confirmed) {
      throw new HttpError(
        409,
        `${before.order_no} has work logged against it: ${describe(impact)}. `
        + 'Deleting it removes all of that permanently and changes every report it appears in. '
        + 'Setting the status to Cancelled keeps the history. To delete it anyway, confirm with the order number.',
        'needs_confirmation',
      );
    }

    // One transaction: every child table cascades from this single statement,
    // so the order and its history go together or not at all.
    tx(() => run('DELETE FROM orders WHERE id = ?', [before.id]));

    audit(req, {
      action: 'delete', entity: 'orders', entityId: before.id,
      summary: impact.total > 0
        ? `Deleted order ${before.order_no} and ${impact.total} attached records`
        : `Deleted order ${before.order_no}`,
      // The impact travels with the order in the audit row, because once this
      // returns the counts cannot be recovered from anywhere but a backup.
      before: { ...before, deleted_with: impact.rows, fabric_movements_released: impact.fabric_movements },
      severity: impact.has_history ? 'critical' : 'warning',
    });
    return reply.send({ deleted: true, removed: impact });
  });

  // ------------------------------------------------------------------- route
  app.get('/api/orders/:orderNo/route', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'route.view');
    const order = findOrder((req.params as { orderNo: string }).orderNo);
    return reply.send({ steps: all('SELECT * FROM order_route WHERE order_id = ? ORDER BY step_no', [order.id]) });
  });

  app.put('/api/orders/:orderNo/route', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'route.edit');
    const order = findOrder((req.params as { orderNo: string }).orderNo);
    const before = all('SELECT * FROM order_route WHERE order_id = ? ORDER BY step_no', [order.id]);
    const body = parse(RouteBody, req.body);
    tx(() => writeRoute(order.id, body.steps, req.principal?.userId));
    const after = all('SELECT * FROM order_route WHERE order_id = ? ORDER BY step_no', [order.id]);
    audit(req, {
      action: 'update', entity: 'order_route', entityId: order.id,
      summary: `Set the route for ${order.order_no}: ${body.steps.map((s) => s.process).join(' → ')}`,
      before, after,
    });
    return reply.send({ steps: after });
  });

  /** Copy a route from another order — most orders for a buyer travel alike. */
  app.post('/api/orders/:orderNo/route/copy', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'route.create');
    const order = findOrder((req.params as { orderNo: string }).orderNo);
    const { from } = parse(z.object({ from: zText(60).min(1) }), req.body);
    const source = findOrder(from);
    const steps = all<{ step_no: number; process: string; type: 'In-house' | 'Outsourced'; notes: string }>(
      'SELECT step_no, process, type, notes FROM order_route WHERE order_id = ? ORDER BY step_no', [source.id],
    );
    if (steps.length === 0) throw new HttpError(400, `${from} has no route to copy`, 'no_route');
    tx(() => writeRoute(order.id, steps, req.principal?.userId));
    audit(req, {
      action: 'update', entity: 'order_route', entityId: order.id,
      summary: `Copied ${from}'s route onto ${order.order_no}`,
    });
    return reply.send({ steps: all('SELECT * FROM order_route WHERE order_id = ? ORDER BY step_no', [order.id]) });
  });

  // ------------------------------------------------------------------ matrix
  app.get('/api/orders/:orderNo/matrix', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'matrix.view');
    const order = findOrder((req.params as { orderNo: string }).orderNo);
    const excess = effectiveExcessPct(order);
    const wip = wipForOrder(order);
    const cells = all<Record<string, unknown>>(
      'SELECT * FROM order_matrix WHERE order_id = ? ORDER BY sort_order, colour, size', [order.id],
    ).map((m) => {
      const w = wip.cells.find((c) => c.colour === m.colour && c.size === m.size);
      return {
        ...m,
        planned_cut: plannedCut(Number(m.order_qty), excess, order.buffer_pct),
        cum_cut: w?.cum_cut ?? 0,
        bal_to_cut: w?.bal_to_cut ?? 0,
        good: w?.good ?? 0,
        rejected: w?.rejected ?? 0,
        packed: w?.packed ?? 0,
        shipped: w?.shipped ?? 0,
        total_wip: w?.total_wip ?? 0,
        where_now: w?.where_now ?? '',
        flag: w?.flag ?? '',
      };
    });
    const total = cells.reduce((s, c) => s + Number((c as Record<string, unknown>).order_qty), 0);
    return reply.send({
      cells, excess_pct: excess, buffer_pct: order.buffer_pct,
      order_qty: order.order_qty, matrix_qty: total, variance: total - order.order_qty,
    });
  });

  app.put('/api/orders/:orderNo/matrix', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'matrix.edit');
    const order = findOrder((req.params as { orderNo: string }).orderNo);
    const before = all('SELECT * FROM order_matrix WHERE order_id = ?', [order.id]);
    const body = parse(MatrixBody, req.body);
    tx(() => writeMatrix(order.id, body, req.principal?.userId));
    const after = all('SELECT * FROM order_matrix WHERE order_id = ? ORDER BY sort_order', [order.id]);
    const total = after.reduce((s, c) => s + Number((c as { order_qty: number }).order_qty), 0);
    audit(req, {
      action: 'update', entity: 'order_matrix', entityId: order.id,
      summary: `Set the matrix for ${order.order_no} (${after.length} cells, ${total} pcs)`,
      before, after,
    });
    return reply.send({ cells: after, matrix_qty: total, variance: total - order.order_qty });
  });

  app.get('/api/orders/export', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'orders.export');
    const rows = all<OrderRow>('SELECT * FROM orders ORDER BY order_no') as unknown as Record<string, unknown>[];
    audit(req, { action: 'export', entity: 'orders', summary: `Exported ${rows.length} orders`, severity: 'notice' });
    return sendCsv(reply, `orders-${new Date().toISOString().slice(0, 10)}.csv`, redactMany(req, rows, ORDER_SPEC));
  });

  // ------------------------------------------------------------------ buyers
  app.get('/api/buyers', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'buyers.view');
    return reply.send({
      rows: all(
        `SELECT b.*, (SELECT COUNT(*) FROM orders o WHERE o.buyer = b.name) AS order_count
           FROM buyers b WHERE b.is_active = 1 ORDER BY b.name`,
      ),
    });
  });

  const BuyerBody = z.object({
    name: zText(160).min(1),
    short_code: zText(20).default(''),
    excess_pct: z.coerce.number().min(0).max(100).default(0),
    excess_billable: z.coerce.number().int().min(0).max(1).default(1),
    shortfall_tolerance_pct: z.coerce.number().min(0).max(100).default(0),
    default_currency: zText(8).default('INR'),
    payment_terms: zText(200).default(''),
    contact: zText(300).default(''),
    notes: zText(1000).default(''),
  });

  app.post('/api/buyers', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'buyers.create');
    const body = parse(BuyerBody, req.body);
    const cols = Object.keys(BuyerBody.shape);
    const info = run(
      `INSERT INTO buyers (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})
       ON CONFLICT(name) DO UPDATE SET ${cols.slice(1).map((c) => `${c} = excluded.${c}`).join(', ')}`,
      cols.map((c) => (body as Record<string, unknown>)[c]),
    );
    learnValue('buyers', body.name, req.principal?.userId);
    audit(req, {
      action: 'create', entity: 'buyers', entityId: info.lastInsertRowid as number,
      summary: `Saved buyer ${body.name} (excess ${body.excess_pct}%)`, after: body, severity: 'notice',
    });
    return reply.code(201).send(one('SELECT * FROM buyers WHERE name = ?', [body.name]));
  });

  app.patch('/api/buyers/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'buyers.edit');
    const id = Number((req.params as { id: string }).id);
    const before = one<Record<string, unknown>>('SELECT * FROM buyers WHERE id = ?', [id]);
    if (!before) throw new HttpError(404, 'No such buyer', 'not_found');
    const body = parse(BuyerBody, { ...before, ...(req.body as object) });
    const cols = Object.keys(BuyerBody.shape);
    run(
      `UPDATE buyers SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
      [...cols.map((c) => (body as Record<string, unknown>)[c]), id],
    );
    const after = one<Record<string, unknown>>('SELECT * FROM buyers WHERE id = ?', [id]);
    audit(req, {
      action: 'update', entity: 'buyers', entityId: id,
      summary: `Edited buyer ${body.name}`, before, after, severity: 'notice',
    });
    return reply.send(after);
  });

  // ----------------------------------------------------------------- vendors
  app.get('/api/vendors', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'vendors.view');
    return reply.send({ rows: all('SELECT * FROM vendors WHERE is_active = 1 ORDER BY name') });
  });

  app.post('/api/vendors', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'vendors.create');
    const body = parse(z.object({
      name: zText(160).min(1),
      processes: zText(300).default(''),
      contact: zText(300).default(''),
      gst_no: zText(30).default(''),
      notes: zText(1000).default(''),
    }), req.body);
    run(
      `INSERT INTO vendors (name, processes, contact, gst_no, notes) VALUES (?,?,?,?,?)
       ON CONFLICT(name) DO UPDATE SET processes = excluded.processes, contact = excluded.contact,
                                       gst_no = excluded.gst_no, notes = excluded.notes`,
      [body.name, body.processes, body.contact, body.gst_no, body.notes],
    );
    learnValue('vendors', body.name, req.principal?.userId);
    audit(req, { action: 'create', entity: 'vendors', summary: `Saved vendor ${body.name}`, after: body });
    return reply.code(201).send(one('SELECT * FROM vendors WHERE name = ?', [body.name]));
  });
}
