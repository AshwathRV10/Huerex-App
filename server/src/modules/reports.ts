import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { all, one } from '../db/index.js';
import { audit } from '../audit/index.js';
import { assertPermission, can } from '../rbac/guard.js';
import { redactMany, BUYER_SUMMARY_SPEC } from '../rbac/fieldPolicy.js';
import { sendCsv } from '../lib/http.js';
import { computeAlerts, summarise } from '../engine/alerts.js';
import { listOrders, wipForAll, wipForOrder, effectiveExcessPct, type OrderRow } from '../engine/facts.js';
import { computeCostSheet } from '../engine/costing.js';
import { setControl } from '../engine/sets.js';

/**
 * Everything that reads rather than writes: the dashboard, WIP, the timeline,
 * reconciliation, the buyer book and the data audit.
 *
 * None of these store anything. Every number is derived from the transaction
 * tables on the way out, which is the only way "one truth per number" survives
 * contact with a second user.
 */

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

function daysBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const a = new Date(`${from}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

// ---------------------------------------------------------------- timeline
interface Milestones {
  fabric_in: string | null; cut_start: string | null; cut_end: string | null;
  jw_out: string | null; jw_in: string | null; sew_start: string | null; sew_end: string | null;
  pack_start: string | null; pack_end: string | null; inspection: string | null;
  first_dispatch: string | null; last_dispatch: string | null;
}

function milestonesFor(orderId: number): Milestones {
  const m = one<Milestones>(
    `SELECT
       (SELECT MIN(txn_date) FROM fabric_ledger WHERE order_id = o.id AND direction = 'RECEIPT') AS fabric_in,
       (SELECT MIN(txn_date) FROM cutting WHERE order_id = o.id) AS cut_start,
       (SELECT MAX(txn_date) FROM cutting WHERE order_id = o.id) AS cut_end,
       (SELECT MIN(txn_date) FROM job_work WHERE order_id = o.id AND direction = 'OUT') AS jw_out,
       (SELECT MAX(txn_date) FROM job_work WHERE order_id = o.id AND direction = 'IN') AS jw_in,
       (SELECT MIN(txn_date) FROM sewing WHERE order_id = o.id AND (block1+block2+block3) > 0) AS sew_start,
       (SELECT MAX(txn_date) FROM sewing WHERE order_id = o.id AND (block1+block2+block3) > 0) AS sew_end,
       (SELECT MIN(txn_date) FROM packing WHERE order_id = o.id) AS pack_start,
       (SELECT MAX(txn_date) FROM packing WHERE order_id = o.id) AS pack_end,
       (SELECT MAX(inspection_date) FROM inspection WHERE order_id = o.id AND result = 'Pass') AS inspection,
       (SELECT MIN(txn_date) FROM shipment WHERE order_id = o.id) AS first_dispatch,
       (SELECT MAX(txn_date) FROM shipment WHERE order_id = o.id) AS last_dispatch
     FROM orders o WHERE o.id = ?`, [orderId],
  );
  return m!;
}

export function timelineRow(order: OrderRow) {
  const m = milestonesFor(order.id);
  const shipped = one<{ q: number }>('SELECT COALESCE(SUM(ship_qty),0) AS q FROM shipment WHERE order_id = ?', [order.id])!.q;
  const closed = order.order_qty > 0 && shipped >= order.order_qty;
  const today = new Date().toISOString().slice(0, 10);
  const cycleEnd = closed ? m.last_dispatch : today;

  return {
    order_no: order.order_no, buyer: order.buyer, style: order.style, status: order.status,
    order_date: order.order_date, ex_factory_date: order.ex_factory_date, ...m,
    fabric_lead_time: daysBetween(order.order_date, m.fabric_in),
    cutting_duration: daysBetween(m.cut_start, m.cut_end),
    jobwork_turnaround: daysBetween(m.jw_out, m.jw_in),
    sewing_duration: daysBetween(m.sew_start, m.sew_end),
    packing_duration: daysBetween(m.pack_start, m.pack_end),
    dispatch_spread: daysBetween(m.first_dispatch, m.last_dispatch),
    total_cycle_time: daysBetween(order.order_date, cycleEnd),
    // Delay is measured against ex-factory, not against the order date.
    delay_days: order.ex_factory_date
      ? (closed
        ? daysBetween(order.ex_factory_date, m.last_dispatch)
        : daysBetween(order.ex_factory_date, today))
      : null,
    shipped, closed,
  };
}

// -------------------------------------------------------------- data audit
export interface AuditCheck { id: number; check: string; issues: number; detail: string[]; what_to_do: string }

export function dataAudit(): AuditCheck[] {
  const checks: AuditCheck[] = [];
  const add = (id: number, check: string, rows: { label: string }[], what: string) =>
    checks.push({ id, check, issues: rows.length, detail: rows.slice(0, 25).map((r) => r.label), what_to_do: what });

  add(1, 'Set group missing one half',
    all<{ label: string }>(
      `SELECT set_group AS label FROM orders WHERE set_group <> ''
        GROUP BY set_group HAVING COUNT(*) = 1`),
    'A set group has only one order in it. Declare both halves or clear the group.');

  add(2, 'Orders with no route',
    all<{ label: string }>(
      `SELECT order_no AS label FROM orders o WHERE status = 'Active'
        AND NOT EXISTS (SELECT 1 FROM order_route r WHERE r.order_id = o.id)`),
    'Every order needs its steps listed before anything can be counted.');

  add(3, 'Route step numbers with a gap',
    all<{ label: string }>(
      `SELECT o.order_no AS label FROM orders o
         JOIN order_route r ON r.order_id = o.id
        GROUP BY o.id HAVING MAX(r.step_no) <> COUNT(*)`),
    'Renumber the route 1, 2, 3… with no gaps.');

  add(4, 'Matrix does not match order quantity',
    all<{ label: string }>(
      `SELECT o.order_no || ' (matrix ' || COALESCE(SUM(m.order_qty),0) || ' vs order ' || o.order_qty || ')' AS label
         FROM orders o LEFT JOIN order_matrix m ON m.order_id = o.id
        WHERE o.status = 'Active'
        GROUP BY o.id HAVING COALESCE(SUM(m.order_qty),0) <> o.order_qty`),
    'The colour × size breakdown has to add up to the order quantity.');

  add(5, 'Cutting logged outside the route',
    all<{ label: string }>(
      `SELECT DISTINCT o.order_no AS label FROM cutting c JOIN orders o ON o.id = c.order_id
        WHERE NOT EXISTS (SELECT 1 FROM order_route r WHERE r.order_id = c.order_id AND r.process = 'Cutting')`),
    'Cutting has been logged for an order whose route has no cutting step.');

  add(6, 'Possible duplicate cutting entries',
    all<{ label: string }>(
      `SELECT o.order_no || ' · ' || c.colour || ' ' || c.size || ' on ' || c.txn_date AS label
         FROM cutting c JOIN orders o ON o.id = c.order_id
        GROUP BY c.order_id, c.colour, c.size, c.txn_date, c.cut_qty HAVING COUNT(*) > 1`),
    'Same date, order, colour, size and quantity twice — check it is not the same bundle counted twice.');

  add(7, 'Job work rows outside the route',
    all<{ label: string }>(
      `SELECT DISTINCT o.order_no || ' · ' || j.process AS label
         FROM job_work j JOIN orders o ON o.id = j.order_id
        WHERE NOT EXISTS (SELECT 1 FROM order_route r WHERE r.order_id = j.order_id AND r.process = j.process)`),
    'A process has been sent out that is not in that order’s route.');

  add(8, 'Job work received more than sent',
    all<{ label: string }>(
      `SELECT o.order_no || ' · ' || j.process || ' at ' || j.vendor AS label
         FROM job_work j JOIN orders o ON o.id = j.order_id
        GROUP BY j.order_id, j.process, j.vendor, j.colour, j.size
       HAVING SUM(CASE WHEN j.direction='IN' THEN j.qty ELSE -j.qty END) > 0`),
    'More pieces have come back from a vendor than went out.');

  add(9, 'Job work out for more than 14 days',
    all<{ label: string }>(
      `SELECT o.order_no || ' · ' || j.process || ' at ' || j.vendor AS label
         FROM job_work j JOIN orders o ON o.id = j.order_id
        GROUP BY j.order_id, j.process, j.vendor
       HAVING SUM(CASE WHEN j.direction='OUT' THEN j.qty ELSE -j.qty END) > 0
          AND julianday('now') - julianday(MIN(CASE WHEN j.direction='OUT' THEN j.txn_date END)) >= 14`),
    'Pieces have been outside the factory for two weeks.');

  add(10, 'Checking entries that do not tally',
    all<{ label: string }>(
      `SELECT o.order_no || ' · ' || c.colour || ' ' || c.size || ' on ' || c.txn_date AS label
         FROM checking c JOIN orders o ON o.id = c.order_id
        WHERE c.checked_qty <> c.pass_qty + c.alter_qty + c.reject_qty`),
    'Pass + Alter + Reject does not equal Checked.');

  add(11, 'Sewing dated before cutting',
    all<{ label: string }>(
      `SELECT o.order_no || ' on ' || s.txn_date AS label
         FROM sewing s JOIN orders o ON o.id = s.order_id
        WHERE s.txn_date < (SELECT MIN(txn_date) FROM cutting c WHERE c.order_id = s.order_id)`),
    'A sewing entry is dated before the first cut on that order.');

  add(12, 'Fabric issued with no rate',
    all<{ label: string }>(
      `SELECT fabric_type || ' ' || colour || ' on ' || txn_date AS label
         FROM fabric_ledger WHERE direction = 'RECEIPT' AND (rate_per_kg IS NULL OR rate_per_kg = 0)`),
    'A fabric receipt has no rate, so the order cannot be costed on what it really used.');

  add(13, 'Trims short and blocking packing',
    all<{ label: string }>(
      `SELECT o.order_no || ' · ' || t.trim_item AS label
         FROM trims t JOIN orders o ON o.id = t.order_id
        WHERE t.blocks_packing = 1
        GROUP BY t.order_id, t.trim_item
       HAVING SUM(t.required_qty) - SUM(t.received_qty) > 0`),
    'A trim marked Blocks Packing is short.');

  add(14, 'Orders with no order date',
    all<{ label: string }>("SELECT order_no AS label FROM orders WHERE status='Active' AND (order_date IS NULL OR order_date='')"),
    'Cycle time cannot be measured without an order date.');

  add(15, 'Orders with no SAM',
    all<{ label: string }>("SELECT order_no AS label FROM orders WHERE status='Active' AND COALESCE(sam,0) = 0"),
    'Efficiency and capacity cannot be worked out without a SAM.');

  add(16, 'Approvals waived without a valid-until date',
    all<{ label: string }>(
      `SELECT o.order_no || ' · ' || w.alert_type AS label FROM alert_waivers w
         JOIN orders o ON o.id = w.order_id
        WHERE w.approved = 1 AND (w.valid_until IS NULL OR w.valid_until = '')`),
    'A waiver with no end date would suppress its alert forever.');

  add(17, 'Active orders with no cost sheet',
    all<{ label: string }>(
      `SELECT order_no AS label FROM orders o WHERE o.status = 'Active'
        AND NOT EXISTS (SELECT 1 FROM cost_sheets cs WHERE cs.order_id = o.id)`),
    'Nobody knows what these orders earn until they are costed.');

  add(18, 'Cost sheets whose quantity has drifted from the order',
    all<{ label: string }>(
      `SELECT o.order_no || ' (sheet ' || cs.order_qty || ' vs order ' || o.order_qty || ')' AS label
         FROM cost_sheets cs JOIN orders o ON o.id = cs.order_id
        WHERE cs.is_primary = 1 AND cs.order_qty <> o.order_qty`),
    'The order quantity changed after the sheet was costed. Re-base the sheet.');

  add(19, 'Users with no role',
    all<{ label: string }>(
      `SELECT username AS label FROM users u WHERE u.is_active = 1
        AND NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id)`),
    'A user with no role can sign in and see nothing. Give them a role or disable them.');

  // Reconciliation is the one that matters most, so it is computed rather
  // than queried: it needs the route walk.
  const broken = wipForAll(false)
    .filter((w) => w.totals.imbalance !== 0)
    .map((w) => ({ label: `${w.order.order_no} (out by ${w.totals.imbalance})` }));
  add(20, 'Reconciliation out of balance', broken,
    'Cut = Shipped + Rejected + WIP has failed. A piece has been double counted or lost.');

  return checks;
}

export function registerReports(app: FastifyInstance): void {
  // ------------------------------------------------------------- dashboard
  app.get('/api/dashboard', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'dashboard.view');
    const wips = wipForAll(true);
    const alerts = computeAlerts();
    const summary = summarise(alerts);

    const totals = wips.reduce((acc, w) => {
      acc.order_qty += w.order.order_qty;
      acc.cut += w.totals.cum_cut;
      acc.packed += w.totals.packed;
      acc.shipped += w.totals.shipped;
      acc.wip += w.totals.total_wip;
      acc.aged += w.totals.max_ageing >= 14 ? w.totals.total_wip : 0;
      acc.good += w.totals.good;
      return acc;
    }, { order_qty: 0, cut: 0, packed: 0, shipped: 0, wip: 0, aged: 0, good: 0 });

    const timelines = listOrders({ liveOnly: true }).map(timelineRow);
    const overdue = timelines.filter((t) => (t.delay_days ?? 0) > 0 && !t.closed).length;
    const closedAll = listOrders({ liveOnly: false }).map(timelineRow).filter((t) => t.closed);
    const onTimePct = closedAll.length
      ? Math.round((closedAll.filter((t) => (t.delay_days ?? 0) <= 0).length / closedAll.length) * 100)
      : null;

    // Where the floor is stuck right now, biggest pile first.
    const buckets = [
      ['Awaiting fusing', 'awaiting_fusing'], ['Awaiting job work', 'awaiting_jobwork'],
      ['At job work vendor', 'at_jobwork_vendor'], ['Ready for sewing', 'ready_for_sewing'],
      ['In sewing', 'in_sewing'], ['Awaiting checking', 'awaiting_checking'],
      ['In rework', 'in_rework'], ['Awaiting packing', 'awaiting_packing'],
      ['Packed, not shipped', 'packed_not_shipped'],
    ] as const;
    const bottlenecks = buckets
      .map(([label, key]) => ({ label, qty: wips.reduce((s, w) => s + (w.totals[key] as number), 0) }))
      .filter((b) => b.qty > 0)
      .sort((a, b) => b.qty - a.qty);

    const output14 = all<{ d: string; qty: number }>(
      `SELECT txn_date AS d, SUM(block1+block2+block3) AS qty FROM sewing
        WHERE date(txn_date) >= date('now','-13 day') GROUP BY txn_date ORDER BY txn_date`,
    );

    const issues = dataAudit();
    const openIssues = issues.reduce((s, c) => s + c.issues, 0);

    let commercial: Record<string, unknown> | undefined;
    if (can(req, 'costing.margin.view')) {
      let value = 0; let cost = 0; let costed = 0;
      for (const w of wips) {
        const sheet = one<Record<string, unknown>>(
          'SELECT * FROM cost_sheets WHERE order_id = ? AND is_primary = 1', [w.order.id],
        );
        if (!sheet) continue;
        costed += 1;
        const lines = {
          fabric: all<Record<string, unknown>>('SELECT * FROM cost_fabric_lines WHERE cost_sheet_id = ?', [sheet.id as number])
            .map((f) => ({ ...f, components: all('SELECT * FROM cost_fabric_components WHERE fabric_line_id = ?', [f.id as number]) })),
          trims: all('SELECT * FROM cost_trim_lines WHERE cost_sheet_id = ?', [sheet.id as number]),
          jobwork: all('SELECT * FROM cost_jobwork_lines WHERE cost_sheet_id = ?', [sheet.id as number]),
          cmt: all('SELECT * FROM cost_cmt_lines WHERE cost_sheet_id = ?', [sheet.id as number]),
          overheads: all('SELECT * FROM cost_overhead_lines WHERE cost_sheet_id = ?', [sheet.id as number]),
        };
        const res = computeCostSheet({
          order_qty: Number(sheet.order_qty), excess_pct: Number(sheet.excess_pct),
          excess_billable: Boolean(sheet.excess_billable), rejection_pct: Number(sheet.rejection_pct),
          currency: String(sheet.currency), fx_rate: Number(sheet.fx_rate),
          selling_price_per_pc: Number(sheet.selling_price_per_pc),
          target_margin_pct: Number(sheet.target_margin_pct),
          ...lines,
        } as never);
        value += res.revenue; cost += res.totalCost;
      }
      commercial = {
        order_book_value: r2(value), order_book_cost: r2(cost),
        order_book_margin: r2(value - cost),
        order_book_margin_pct: value ? r1(((value - cost) / value) * 100) : 0,
        costed_orders: costed, uncosted_orders: wips.length - costed,
      };
    }

    return reply.send({
      live_orders: wips.length,
      ...totals,
      overdue,
      on_time_pct: onTimePct,
      alerts: summary,
      bottlenecks,
      output_14d: output14,
      data_audit: { open: openIssues, clean: openIssues === 0, checks: issues.filter((c) => c.issues > 0).length },
      commercial,
      top_alerts: alerts.filter((a) => !a.suppressed).slice(0, 12),
    });
  });

  // -------------------------------------------------------------------- WIP
  app.get('/api/wip', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'wip.view');
    const q = req.query as { order_no?: string; live?: string; flag?: string };
    const orders = listOrders({ liveOnly: q.live !== '0', orderNo: q.order_no });
    const rows: Record<string, unknown>[] = [];
    for (const o of orders) {
      const w = wipForOrder(o);
      for (const c of w.cells) {
        if (q.flag && c.flag !== q.flag) continue;
        rows.push({ order_no: o.order_no, buyer: o.buyer, style: o.style, status: o.status, ...c });
      }
    }
    const totals = rows.reduce((acc: Record<string, number>, r) => {
      for (const k of ['cum_cut', 'bal_to_cut', 'awaiting_fusing', 'awaiting_jobwork', 'at_jobwork_vendor',
        'ready_for_sewing', 'in_sewing', 'awaiting_checking', 'in_rework', 'awaiting_packing',
        'packed_not_shipped', 'total_wip', 'shipped', 'rejected']) {
        acc[k] = (acc[k] ?? 0) + Number(r[k] ?? 0);
      }
      return acc;
    }, {});
    return reply.send({ rows, totals });
  });

  app.get('/api/wip/export', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'wip.export');
    const rows: Record<string, unknown>[] = [];
    for (const o of listOrders({ liveOnly: true })) {
      for (const c of wipForOrder(o).cells) {
        const { steps, ...rest } = c;
        rows.push({ order_no: o.order_no, buyer: o.buyer, ...rest });
      }
    }
    audit(req, { action: 'export', entity: 'wip', summary: `Exported ${rows.length} WIP rows`, severity: 'notice' });
    return sendCsv(reply, `wip-${new Date().toISOString().slice(0, 10)}.csv`, rows);
  });

  // --------------------------------------------------------- reconciliation
  app.get('/api/reconciliation', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'reconciliation.view');
    const rows = wipForAll(false).map((w) => {
      const accounted = w.totals.shipped + w.totals.rejected + w.totals.total_wip;
      const difference = w.totals.cum_cut - accounted;
      return {
        order_no: w.order.order_no, buyer: w.order.buyer, status: w.order.status,
        order_qty: w.order.order_qty, cum_cut: w.totals.cum_cut,
        shipped: w.totals.shipped, rejected: w.totals.rejected, total_wip: w.totals.total_wip,
        accounted, difference,
        bucket_sum: w.cells.reduce((s, c) => s + c.bucket_sum, 0),
        bucket_imbalance: w.totals.imbalance,
        verdict: difference === 0
          ? (w.totals.imbalance === 0 ? 'Balanced' : 'Buckets disagree')
          : difference > 0 ? 'Pieces unaccounted' : 'Counted twice',
      };
    });
    return reply.send({ rows, broken: rows.filter((r) => r.difference !== 0 || r.bucket_imbalance !== 0).length });
  });

  // --------------------------------------------------------------- timeline
  app.get('/api/timeline', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'timeline.view');
    const q = req.query as { live?: string };
    const rows = listOrders({ liveOnly: q.live !== '0' }).map((o) => {
      const row = timelineRow(o);
      const reason = one<{ reason: string; note: string }>(
        'SELECT reason, note FROM order_delay_reason WHERE order_id = ?', [o.id],
      );
      return { ...row, delay_reason: reason?.reason ?? '-', delay_note: reason?.note ?? '' };
    });
    return reply.send({ rows });
  });

  app.put('/api/timeline/:orderNo/reason', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'timeline.edit');
    const orderNo = (req.params as { orderNo: string }).orderNo;
    const order = one<{ id: number }>('SELECT id FROM orders WHERE order_no = ?', [orderNo]);
    if (!order) return reply.code(404).send({ error: 'No such order' });
    const body = req.body as { reason?: string; note?: string };
    const { run } = await import('../db/index.js');
    run(
      `INSERT INTO order_delay_reason (order_id, reason, note, updated_by, updated_at)
       VALUES (?,?,?,?,datetime('now'))
       ON CONFLICT(order_id) DO UPDATE SET reason = excluded.reason, note = excluded.note,
                                           updated_by = excluded.updated_by, updated_at = datetime('now')`,
      [order.id, body.reason ?? '-', body.note ?? '', req.principal?.userId ?? null],
    );
    audit(req, { action: 'update', entity: 'order_delay_reason', entityId: order.id, summary: `Delay reason for ${orderNo}: ${body.reason}` });
    return reply.send({ ok: true });
  });

  // ---------------------------------------------------------------- alerts
  app.get('/api/alerts', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'alerts.view');
    const q = req.query as { type?: string; include_suppressed?: string; owner?: string };
    let rows = computeAlerts();
    if (q.include_suppressed !== '1') rows = rows.filter((a) => !a.suppressed);
    if (q.type) rows = rows.filter((a) => a.type === q.type);
    if (q.owner) rows = rows.filter((a) => a.owner === q.owner);
    return reply.send({ rows, summary: summarise(computeAlerts()) });
  });

  // ---------------------------------------------------------- buyer summary
  // Deeper than the sheet's version: the book, the clock, the quality and —
  // for those allowed to see it — the money, per buyer.
  app.get('/api/buyer-summary', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'buyersummary.view');
    const buyers = all<{ name: string; excess_pct: number; excess_billable: number; payment_terms: string }>(
      'SELECT name, excess_pct, excess_billable, payment_terms FROM buyers WHERE is_active = 1 ORDER BY name',
    );
    const allWip = wipForAll(false);
    const alerts = computeAlerts().filter((a) => !a.suppressed);

    const rows = buyers.map((b) => {
      const mine = allWip.filter((w) => w.order.buyer === b.name);
      const live = mine.filter((w) => w.order.status === 'Active');
      const t = mine.reduce((acc, w) => {
        acc.order_qty += w.order.order_qty;
        acc.cut += w.totals.cum_cut;
        acc.good += w.totals.good;
        acc.packed += w.totals.packed;
        acc.shipped += w.totals.shipped;
        acc.wip += w.totals.total_wip;
        acc.rejected += w.totals.rejected;
        return acc;
      }, { order_qty: 0, cut: 0, good: 0, packed: 0, shipped: 0, wip: 0, rejected: 0 });

      const timelines = mine.map((w) => timelineRow(w.order));
      const closed = timelines.filter((x) => x.closed);
      const overdue = timelines.filter((x) => !x.closed && (x.delay_days ?? 0) > 0).length;
      const avgCycle = closed.length
        ? r1(closed.reduce((s, x) => s + (x.total_cycle_time ?? 0), 0) / closed.length) : null;
      const onTime = closed.length
        ? Math.round((closed.filter((x) => (x.delay_days ?? 0) <= 0).length / closed.length) * 100) : null;

      const appr = one<{ avg: number; pending: number }>(
        `SELECT AVG(julianday(a.decided_date) - julianday(a.sent_date)) AS avg,
                SUM(CASE WHEN a.status = 'Pending' THEN 1 ELSE 0 END) AS pending
           FROM buyer_approvals a JOIN orders o ON o.id = a.order_id
          WHERE o.buyer = ? AND a.required = 1`, [b.name],
      );

      const dhuRow = one<{ checked: number; defects: number }>(
        `SELECT COALESCE(SUM(c.checked_qty),0) AS checked, COALESCE(SUM(c.alter_qty + c.reject_qty),0) AS defects
           FROM checking c JOIN orders o ON o.id = c.order_id WHERE o.buyer = ?`, [b.name],
      )!;

      const base: Record<string, unknown> = {
        buyer: b.name,
        excess_pct: b.excess_pct,
        excess_billable: Boolean(b.excess_billable),
        payment_terms: b.payment_terms,
        total_orders: mine.length,
        live_orders: live.length,
        ...t,
        shipped_pct: t.order_qty ? r1((t.shipped / t.order_qty) * 100) : 0,
        overdue_orders: overdue,
        on_time_pct: onTime,
        avg_cycle_days: avgCycle,
        avg_approval_turnaround: appr?.avg != null ? r1(appr.avg) : null,
        approvals_pending: appr?.pending ?? 0,
        open_alerts: alerts.filter((a) => a.buyer === b.name).length,
        dhu_pct: dhuRow.checked ? r1((dhuRow.defects / dhuRow.checked) * 100) : 0,
        reject_pct: t.cut ? r1((t.rejected / t.cut) * 100) : 0,
      };

      // Money, only for those allowed to see it — the redaction below strips
      // these keys anyway, but not computing them keeps the endpoint cheap.
      if (can(req, 'buyersummary.commercials.view')) {
        let value = 0; let cost = 0; let costed = 0; let excessGiven = 0;
        for (const w of mine) {
          const sheet = one<Record<string, unknown>>(
            'SELECT * FROM cost_sheets WHERE order_id = ? AND is_primary = 1', [w.order.id],
          );
          if (!sheet) continue;
          costed += 1;
          const lines = {
            fabric: all<Record<string, unknown>>('SELECT * FROM cost_fabric_lines WHERE cost_sheet_id = ?', [sheet.id as number])
              .map((f) => ({ ...f, components: all('SELECT * FROM cost_fabric_components WHERE fabric_line_id = ?', [f.id as number]) })),
            trims: all('SELECT * FROM cost_trim_lines WHERE cost_sheet_id = ?', [sheet.id as number]),
            jobwork: all('SELECT * FROM cost_jobwork_lines WHERE cost_sheet_id = ?', [sheet.id as number]),
            cmt: all('SELECT * FROM cost_cmt_lines WHERE cost_sheet_id = ?', [sheet.id as number]),
            overheads: all('SELECT * FROM cost_overhead_lines WHERE cost_sheet_id = ?', [sheet.id as number]),
          };
          const res = computeCostSheet({
            order_qty: Number(sheet.order_qty), excess_pct: Number(sheet.excess_pct),
            excess_billable: Boolean(sheet.excess_billable), rejection_pct: Number(sheet.rejection_pct),
            currency: String(sheet.currency), fx_rate: Number(sheet.fx_rate),
            selling_price_per_pc: Number(sheet.selling_price_per_pc),
            target_margin_pct: Number(sheet.target_margin_pct), ...lines,
          } as never);
          value += res.revenue; cost += res.totalCost;
          if (!sheet.excess_billable) excessGiven += res.quantities.excessQty * res.costPerPcProduced;
        }
        Object.assign(base, {
          costed_orders: costed,
          order_value: r2(value),
          total_cost: r2(cost),
          margin: r2(value - cost),
          margin_pct: value ? r1(((value - cost) / value) * 100) : 0,
          avg_price: t.order_qty ? r2(value / t.order_qty) : 0,
          avg_cost: t.order_qty ? r2(cost / t.order_qty) : 0,
          free_excess_cost: r2(excessGiven),
        });
      } else {
        // Say "restricted" rather than saying nothing. A caller that cannot
        // see these needs to be able to tell a withheld figure apart from a
        // genuine zero, and every other endpoint marks them the same way.
        Object.assign(base, {
          order_value__locked: true, total_cost__locked: true, margin__locked: true,
          margin_pct__locked: true, avg_price__locked: true, avg_cost__locked: true,
        });
      }

      base.verdict = overdue > 0 ? 'Behind'
        : (base.open_alerts as number) > 0 ? 'Watch'
          : t.order_qty === 0 ? 'No orders' : 'Healthy';
      return base;
    });

    return reply.send({ rows: redactMany(req, rows, BUYER_SUMMARY_SPEC) });
  });

  app.get('/api/buyer-summary/:buyer', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'buyersummary.view');
    const buyer = decodeURIComponent((req.params as { buyer: string }).buyer);
    const orders = all<OrderRow>('SELECT * FROM orders WHERE buyer = ? ORDER BY ex_factory_date DESC', [buyer]);
    const timelines = orders.map(timelineRow);

    const monthly = all(
      `SELECT strftime('%Y-%m', s.txn_date) AS month, SUM(s.ship_qty) AS shipped, COUNT(DISTINCT s.order_id) AS orders
         FROM shipment s JOIN orders o ON o.id = s.order_id
        WHERE o.buyer = ? GROUP BY month ORDER BY month DESC LIMIT 18`, [buyer],
    );

    const styles = all(
      `SELECT o.style, COUNT(*) AS orders, SUM(o.order_qty) AS qty
         FROM orders o WHERE o.buyer = ? GROUP BY o.style ORDER BY qty DESC LIMIT 15`, [buyer],
    );

    const vendors = all(
      `SELECT j.vendor, j.process, SUM(CASE WHEN j.direction='OUT' THEN j.qty ELSE 0 END) AS sent,
              COUNT(DISTINCT j.order_id) AS orders
         FROM job_work j JOIN orders o ON o.id = j.order_id
        WHERE o.buyer = ? GROUP BY j.vendor, j.process ORDER BY sent DESC LIMIT 20`, [buyer],
    );

    const approvals = all(
      `SELECT a.approval_type, COUNT(*) AS raised,
              AVG(julianday(a.decided_date) - julianday(a.sent_date)) AS avg_days,
              SUM(CASE WHEN a.status='Pending' THEN 1 ELSE 0 END) AS pending
         FROM buyer_approvals a JOIN orders o ON o.id = a.order_id
        WHERE o.buyer = ? GROUP BY a.approval_type ORDER BY avg_days DESC`, [buyer],
    );

    const delays = all(
      `SELECT COALESCE(d.reason,'-') AS reason, COUNT(*) AS orders
         FROM orders o LEFT JOIN order_delay_reason d ON d.order_id = o.id
        WHERE o.buyer = ? GROUP BY reason ORDER BY orders DESC`, [buyer],
    );

    return reply.send({ buyer, orders: timelines, monthly, styles, vendors, approvals, delays });
  });

  // ------------------------------------------------------------ data audit
  app.get('/api/data-audit', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'dataaudit.view');
    const checks = dataAudit();
    return reply.send({ checks, open: checks.reduce((s, c) => s + c.issues, 0) });
  });

  // ---------------------------------------------------------- set control
  app.get('/api/set-control', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'sets.view');
    return reply.send(setControl());
  });

  app.get('/api/set-control/export', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'sets.export');
    const { rows } = setControl();
    const flat = rows.flatMap((r) => r.legs.map((l) => ({
      Set: r.set_group, Colour: r.colour, Size: r.size, SetQty: r.set_qty,
      Order: l.order_no, Role: l.role, Cut: l.cut, Good: l.good,
      Packed: l.packed, Shipped: l.shipped,
      SetsMakeable: r.sets_makeable, SetsShipped: r.sets_shipped,
      LegGap: r.leg_gap, Status: r.status,
    })));
    audit(req, { action: 'export', entity: 'set_control', summary: `Exported ${flat.length} set rows`, severity: 'notice' });
    return sendCsv(reply, `set-control-${new Date().toISOString().slice(0, 10)}.csv`, flat);
  });

  // ------------------------------------------------------- capacity & load
  app.get('/api/capacity', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'capacity.view');
    const lines = all<{
      line: string; entries: number; output: number; op_hours: number;
      avg_operators: number; sam_minutes: number;
    }>(
      `SELECT s.line,
              COUNT(*) AS entries,
              SUM(s.block1+s.block2+s.block3) AS output,
              SUM(s.operators * s.hours) AS op_hours,
              AVG(s.operators) AS avg_operators,
              SUM((s.block1+s.block2+s.block3) * COALESCE(o.sam,0)) AS sam_minutes
         FROM sewing s JOIN orders o ON o.id = s.order_id
        WHERE date(s.txn_date) >= date('now','-30 day')
        GROUP BY s.line ORDER BY s.line`,
    );

    const rows = lines.map((l) => {
      const minutesAvailable = l.op_hours * 60;
      const efficiency = minutesAvailable > 0 ? r1((l.sam_minutes / minutesAvailable) * 100) : 0;
      return {
        ...l,
        op_hours: r1(l.op_hours),
        avg_operators: r1(l.avg_operators),
        pcs_per_op_hour: l.op_hours > 0 ? r2(l.output / l.op_hours) : 0,
        efficiency_pct: efficiency,
        minutes_available_per_day: r1(minutesAvailable / 30),
      };
    });

    // What is still owed to the floor, in minutes, per line-less total.
    const pending = wipForAll(true).reduce((s, w) => {
      const toSew = w.totals.ready_for_sewing + w.totals.in_sewing;
      return s + toSew * (w.order.sam || 0);
    }, 0);
    const dailyMinutes = rows.reduce((s, r) => s + r.minutes_available_per_day, 0);
    const avgEff = rows.length ? rows.reduce((s, r) => s + r.efficiency_pct, 0) / rows.length : 0;
    const effectiveDaily = dailyMinutes * (avgEff > 0 ? avgEff / 100 : 1);

    return reply.send({
      rows,
      pending_sam_minutes: Math.round(pending),
      minutes_available_per_day: Math.round(dailyMinutes),
      days_of_work: effectiveDaily > 0 ? r1(pending / effectiveDaily) : null,
      avg_efficiency_pct: r1(avgEff),
    });
  });
}
