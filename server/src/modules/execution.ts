import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { all, one } from '../db/index.js';
import { registerCrud } from './crud.js';
import { assertPermission } from '../rbac/guard.js';
import { redactMany, FABRIC_SPEC, JOBWORK_SPEC } from '../rbac/fieldPolicy.js';
import { HttpError, parse, zDate, zText } from '../lib/http.js';
import { notifyApprovalPending } from './notifications.js';

/**
 * The transaction sheets. Each one is a thin declaration on top of the CRUD
 * factory: what it stores, what a valid row looks like, and which master lists
 * it teaches.
 *
 * The validations here are the ones that stop a wrong number reaching a
 * report — checked = pass + alter + reject, an IN row that exceeds what went
 * OUT, a sewing date before the first cut. They are stated as plain sentences
 * because the person reading them is standing at a cutting table.
 */

const orderRef = { order_id: z.coerce.number().int().positive(), order_no: zText(60).optional() };
const withCreated = { created_by: z.coerce.number().nullable().optional() };

function orderOf(orderId: number) {
  const o = one<{ id: number; order_no: string; buyer: string; status: string }>(
    'SELECT id, order_no, buyer, status FROM orders WHERE id = ?', [orderId],
  );
  if (!o) throw new HttpError(400, 'That order does not exist', 'unknown_order');
  return o;
}

function assertInRoute(orderId: number, process: string): void {
  const row = one<{ c: number }>(
    'SELECT COUNT(*) AS c FROM order_route WHERE order_id = ? AND process = ?', [orderId, process],
  );
  if (!row || row.c === 0) {
    const order = orderOf(orderId);
    throw new HttpError(
      400,
      `${process} is not in ${order.order_no}'s route. Add the step on the Route screen first, or pick a different process.`,
      'not_in_route',
    );
  }
}

export function registerExecution(app: FastifyInstance): void {
  // ------------------------------------------------------------------ cutting
  registerCrud(app, {
    key: 'cutting',
    table: 'cutting',
    withOrder: true,
    orderBy: 't.txn_date DESC, t.id DESC',
    columns: ['txn_date', 'order_id', 'colour', 'size', 'fabric_type', 'counts_as_garment',
      'lot_no', 'cut_qty', 'fabric_gsm', 'area_per_pc_sqm', 'pc_weight_g', 'table_no', 'remarks'],
    learns: { colour: 'colours', size: 'sizes', fabric_type: 'fabric_types' },
    schema: z.object({
      ...orderRef, ...withCreated,
      txn_date: zDate,
      colour: zText(120).min(1, 'which colour?'),
      size: zText(60).min(1, 'which size?'),
      fabric_type: zText(120).default(''),
      counts_as_garment: z.coerce.number().int().min(0).max(1).default(1),
      lot_no: zText(80).default(''),
      cut_qty: z.coerce.number().int().refine((n) => n !== 0, 'a cut of zero pieces is not a cut'),
      fabric_gsm: z.coerce.number().min(0).nullable().default(null),
      area_per_pc_sqm: z.coerce.number().min(0).nullable().default(null),
      pc_weight_g: z.coerce.number().min(0).nullable().default(null),
      table_no: zText(40).default(''),
      remarks: zText(300).default(''),
    }),
    validate: (row) => assertInRoute(Number(row.order_id), 'Cutting'),
    describe: (r) => `Cut ${r.cut_qty} · ${r.colour} ${r.size}`,
  });

  // ------------------------------------------------------------------- fusing
  registerCrud(app, {
    key: 'fusing',
    table: 'fusing',
    withOrder: true,
    orderBy: 't.txn_date DESC, t.id DESC',
    columns: ['txn_date', 'order_id', 'colour', 'size', 'fused_qty', 'remarks'],
    learns: { colour: 'colours', size: 'sizes' },
    schema: z.object({
      ...orderRef, ...withCreated,
      txn_date: zDate,
      colour: zText(120).min(1, 'which colour?'),
      size: zText(60).min(1, 'which size?'),
      fused_qty: z.coerce.number().int().positive('how many pieces were fused?'),
      remarks: zText(300).default(''),
    }),
    validate: (row) => assertInRoute(Number(row.order_id), 'Fusing'),
    describe: (r) => `Fused ${r.fused_qty} · ${r.colour} ${r.size}`,
  });

  // ----------------------------------------------------------------- job work
  registerCrud(app, {
    key: 'jobwork',
    table: 'job_work',
    withOrder: true,
    orderBy: 't.txn_date DESC, t.id DESC',
    columns: ['txn_date', 'order_id', 'colour', 'size', 'process', 'step_no', 'vendor',
      'direction', 'qty', 'dc_no', 'remarks'],
    learns: { colour: 'colours', size: 'sizes', process: 'jobwork_processes', vendor: 'vendors' },
    redaction: JOBWORK_SPEC,
    filters: { process: 't.process = ?', vendor: 't.vendor = ?', direction: 't.direction = ?' },
    schema: z.object({
      ...orderRef, ...withCreated,
      txn_date: zDate,
      colour: zText(120).min(1, 'which colour?'),
      size: zText(60).default(''),
      process: zText(80).min(1, 'which process?'),
      step_no: z.coerce.number().int().nullable().default(null),
      vendor: zText(160).min(1, 'which vendor?'),
      direction: z.enum(['OUT', 'IN']),
      qty: z.coerce.number().int().positive('how many pieces?'),
      dc_no: zText(80).default(''),
      remarks: zText(300).default(''),
    }),
    validate: (row, id) => {
      const orderId = Number(row.order_id);
      assertInRoute(orderId, String(row.process));
      if (row.direction === 'IN') {
        // You cannot get more back than you sent — that is a typo, every time.
        const sums = one<{ out: number; back: number }>(
          `SELECT COALESCE(SUM(CASE WHEN direction='OUT' THEN qty END),0) AS out,
                  COALESCE(SUM(CASE WHEN direction='IN' THEN qty END),0) AS back
             FROM job_work
            WHERE order_id = ? AND process = ? AND vendor = ? AND colour = ? AND size = ?
              AND (? IS NULL OR id <> ?)`,
          [orderId, row.process, row.vendor, row.colour, row.size, id, id],
        )!;
        const pending = sums.out - sums.back;
        if (Number(row.qty) > pending) {
          throw new HttpError(
            400,
            `Only ${pending} pcs are still out at ${row.vendor} for ${row.process}. Receiving ${row.qty} would mean more came back than went.`,
            'jobwork_over_receipt',
          );
        }
      }
    },
    describe: (r) => `${r.direction} ${r.qty} · ${r.process} · ${r.vendor}`,
  });

  app.get('/api/jobwork/pending', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'jobwork.view');
    const q = req.query as { order_no?: string; vendor?: string };
    const where = ['1=1'];
    const params: unknown[] = [];
    if (q.order_no) { where.push('o.order_no = ?'); params.push(q.order_no); }
    if (q.vendor) { where.push('j.vendor = ?'); params.push(q.vendor); }
    const rows = all(
      `SELECT o.order_no, o.buyer, j.process, j.vendor, j.colour, j.size,
              SUM(CASE WHEN j.direction='OUT' THEN j.qty ELSE -j.qty END) AS pending,
              MIN(CASE WHEN j.direction='OUT' THEN j.txn_date END) AS first_out,
              CAST(julianday('now') - julianday(MIN(CASE WHEN j.direction='OUT' THEN j.txn_date END)) AS INTEGER) AS days_out
         FROM job_work j JOIN orders o ON o.id = j.order_id
        WHERE ${where.join(' AND ')}
        GROUP BY o.order_no, o.buyer, j.process, j.vendor, j.colour, j.size
       HAVING pending > 0
        ORDER BY days_out DESC`, params,
    );
    return reply.send({ rows });
  });

  // ------------------------------------------------------------------ sewing
  registerCrud(app, {
    key: 'sewing',
    table: 'sewing',
    withOrder: true,
    orderBy: 't.txn_date DESC, t.id DESC',
    columns: ['txn_date', 'order_id', 'line', 'colour', 'size', 'operators', 'hours',
      'block1', 'block2', 'block3', 'issued_to_line', 'remarks'],
    learns: { line: 'lines', colour: 'colours', size: 'sizes' },
    filters: { line: 't.line = ?' },
    schema: z.object({
      ...orderRef, ...withCreated,
      txn_date: zDate,
      line: zText(60).min(1, 'which line?'),
      colour: zText(120).default(''),
      size: zText(60).default(''),
      operators: z.coerce.number().min(0).default(0),
      hours: z.coerce.number().min(0).max(24).default(0),
      block1: z.coerce.number().int().min(0).default(0),
      block2: z.coerce.number().int().min(0).default(0),
      block3: z.coerce.number().int().min(0).default(0),
      issued_to_line: z.coerce.number().int().min(0).default(0),
      remarks: zText(300).default(''),
    }),
    validate: (row) => {
      const orderId = Number(row.order_id);
      assertInRoute(orderId, 'Sewing');
      const firstCut = one<{ d: string }>('SELECT MIN(txn_date) AS d FROM cutting WHERE order_id = ?', [orderId])?.d;
      if (firstCut && String(row.txn_date) < firstCut) {
        throw new HttpError(400, `This order was first cut on ${firstCut}. Sewing cannot be dated before that.`, 'sewing_before_cut');
      }
    },
    describe: (r) => `Sewn ${Number(r.block1) + Number(r.block2) + Number(r.block3)} · ${r.line}`,
  });

  // ---------------------------------------------------------------- checking
  registerCrud(app, {
    key: 'checking',
    table: 'checking',
    withOrder: true,
    orderBy: 't.txn_date DESC, t.id DESC',
    columns: ['txn_date', 'order_id', 'colour', 'size', 'line', 'checked_qty', 'pass_qty',
      'alter_qty', 'reject_qty', 'rechecked_ok', 'defect_notes', 'remarks'],
    learns: { colour: 'colours', size: 'sizes', line: 'lines' },
    schema: z.object({
      ...orderRef, ...withCreated,
      txn_date: zDate,
      colour: zText(120).min(1, 'which colour?'),
      size: zText(60).min(1, 'which size?'),
      line: zText(60).default(''),
      checked_qty: z.coerce.number().int().min(0).default(0),
      pass_qty: z.coerce.number().int().min(0).default(0),
      alter_qty: z.coerce.number().int().min(0).default(0),
      reject_qty: z.coerce.number().int().min(0).default(0),
      rechecked_ok: z.coerce.number().int().min(0).default(0),
      defect_notes: zText(400).default(''),
      remarks: zText(300).default(''),
    }).refine(
      (r) => r.checked_qty === 0 || r.checked_qty === r.pass_qty + r.alter_qty + r.reject_qty,
      { message: 'Pass + Alter + Reject has to equal Checked', path: ['checked_qty'] },
    ),
    validate: (row) => assertInRoute(Number(row.order_id), 'Checking'),
    describe: (r) => `Checked ${r.checked_qty} · ${r.colour} ${r.size}`,
  });

  // ----------------------------------------------------------------- packing
  registerCrud(app, {
    key: 'packing',
    table: 'packing',
    withOrder: true,
    orderBy: 't.txn_date DESC, t.id DESC',
    columns: ['txn_date', 'order_id', 'colour', 'size', 'packed_qty', 'carton_no', 'remarks'],
    learns: { colour: 'colours', size: 'sizes' },
    schema: z.object({
      ...orderRef, ...withCreated,
      txn_date: zDate,
      colour: zText(120).min(1, 'which colour?'),
      size: zText(60).min(1, 'which size?'),
      packed_qty: z.coerce.number().int().positive('how many pieces went in the carton?'),
      carton_no: zText(60).default(''),
      remarks: zText(300).default(''),
    }),
    validate: (row) => {
      const orderId = Number(row.order_id);
      assertInRoute(orderId, 'Packing');
      const blocking = all<{ trim_item: string; short: number }>(
        `SELECT trim_item, SUM(required_qty) - SUM(received_qty) AS short FROM trims
          WHERE order_id = ? AND blocks_packing = 1 GROUP BY trim_item HAVING short > 0`, [orderId],
      );
      if (blocking.length > 0) {
        const names = blocking.map((b) => `${b.trim_item} (short ${Math.round(b.short)})`).join(', ');
        throw new HttpError(400, `Packing is held: ${names}. Receive the trim or clear the Blocks Packing flag.`, 'trims_block');
      }
    },
    describe: (r) => `Packed ${r.packed_qty} · ${r.colour} ${r.size}`,
  });

  // -------------------------------------------------------------- inspection
  registerCrud(app, {
    key: 'inspection',
    table: 'inspection',
    withOrder: true,
    orderBy: 't.inspection_date DESC, t.id DESC',
    columns: ['order_id', 'inspection_date', 'offered_qty', 'result', 'aql', 'inspector', 'remarks'],
    learns: { result: 'inspection_results' },
    schema: z.object({
      ...orderRef, ...withCreated,
      inspection_date: zDate,
      offered_qty: z.coerce.number().int().min(0).default(0),
      result: zText(40).default('Pending'),
      aql: zText(40).default(''),
      inspector: zText(160).default(''),
      remarks: zText(400).default(''),
    }),
    describe: (r) => `Inspection ${r.result} · ${r.offered_qty} pcs`,
  });

  // ---------------------------------------------------------------- shipment
  registerCrud(app, {
    key: 'shipment',
    table: 'shipment',
    withOrder: true,
    orderBy: 't.txn_date DESC, t.id DESC',
    columns: ['txn_date', 'order_id', 'colour', 'size', 'ship_qty', 'invoice_no', 'buyer_po_no',
      'cartons', 'gross_wt_kg', 'net_wt_kg', 'remarks'],
    learns: { colour: 'colours', size: 'sizes' },
    schema: z.object({
      ...orderRef, ...withCreated,
      txn_date: zDate,
      colour: zText(120).min(1, 'which colour?'),
      size: zText(60).min(1, 'which size?'),
      ship_qty: z.coerce.number().int().positive('how many pieces shipped?'),
      invoice_no: zText(80).default(''),
      buyer_po_no: zText(80).default(''),
      cartons: z.coerce.number().min(0).default(0),
      gross_wt_kg: z.coerce.number().min(0).default(0),
      net_wt_kg: z.coerce.number().min(0).default(0),
      remarks: zText(300).default(''),
    }),
    validate: (row) => {
      const orderId = Number(row.order_id);
      const hasInspection = one<{ c: number }>(
        "SELECT COUNT(*) AS c FROM order_route WHERE order_id = ? AND process = 'Inspection'", [orderId],
      )!.c;
      if (hasInspection > 0) {
        const passed = one<{ c: number }>(
          "SELECT COUNT(*) AS c FROM inspection WHERE order_id = ? AND result = 'Pass'", [orderId],
        )!.c;
        if (passed === 0) {
          throw new HttpError(400, 'Inspection is in this order’s route and has not passed. Record the pass before shipping.', 'inspection_gate');
        }
      }
    },
    describe: (r) => `Shipped ${r.ship_qty} · ${r.colour} ${r.size}`,
  });

  // ------------------------------------------------------------------- trims
  registerCrud(app, {
    key: 'trims',
    table: 'trims',
    withOrder: true,
    orderBy: 't.txn_date DESC, t.id DESC',
    columns: ['txn_date', 'order_id', 'trim_item', 'colour', 'required_qty', 'received_qty',
      'issued_qty', 'uom', 'blocks_packing', 'supplier', 'remarks'],
    learns: { trim_item: 'trim_items', colour: 'colours', uom: 'trim_uoms', supplier: 'suppliers' },
    schema: z.object({
      ...orderRef, ...withCreated,
      txn_date: zDate,
      trim_item: zText(120).min(1, 'which trim?'),
      colour: zText(120).default(''),
      required_qty: z.coerce.number().min(0).default(0),
      received_qty: z.coerce.number().min(0).default(0),
      issued_qty: z.coerce.number().min(0).default(0),
      uom: zText(20).default('pcs'),
      blocks_packing: z.coerce.number().int().min(0).max(1).default(0),
      supplier: zText(160).default(''),
      remarks: zText(300).default(''),
    }),
    describe: (r) => `${r.trim_item} · required ${r.required_qty}, received ${r.received_qty}`,
  });

  app.get('/api/trims/coverage', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'trims.view');
    const q = req.query as { order_no?: string };
    const rows = all(
      `SELECT o.order_no, o.buyer, t.trim_item,
              SUM(t.required_qty) AS required, SUM(t.received_qty) AS received,
              SUM(t.issued_qty) AS issued,
              SUM(t.required_qty) - SUM(t.received_qty) AS short,
              MAX(t.blocks_packing) AS blocks_packing,
              CASE WHEN SUM(t.required_qty) = 0 THEN 100
                   ELSE ROUND(SUM(t.received_qty) * 100.0 / SUM(t.required_qty), 1) END AS coverage_pct
         FROM trims t JOIN orders o ON o.id = t.order_id
        WHERE (? IS NULL OR o.order_no = ?)
        GROUP BY o.order_no, o.buyer, t.trim_item
        ORDER BY blocks_packing DESC, short DESC`,
      [q.order_no ?? null, q.order_no ?? null],
    );
    return reply.send({ rows });
  });

  // ---------------------------------------------------------- buyer approvals
  registerCrud(app, {
    key: 'approvals',
    table: 'buyer_approvals',
    withOrder: true,
    orderBy: "CASE t.status WHEN 'Pending' THEN 0 ELSE 1 END, t.sent_date",
    columns: ['order_id', 'approval_type', 'required', 'status', 'sent_date', 'decided_date',
      'blocks_production', 'owner', 'remarks'],
    learns: { approval_type: 'approval_types', status: 'approval_status', owner: 'team' },
    filters: { status: 't.status = ?' },
    schema: z.object({
      ...orderRef, ...withCreated,
      approval_type: zText(80).min(1, 'which approval?'),
      required: z.coerce.number().int().min(0).max(1).default(1),
      status: zText(40).default('Pending'),
      sent_date: z.union([zDate, z.literal(''), z.null()]).optional().transform((v) => (v ? v : null)),
      decided_date: z.union([zDate, z.literal(''), z.null()]).optional().transform((v) => (v ? v : null)),
      blocks_production: z.coerce.number().int().min(0).max(1).default(0),
      owner: zText(120).default(''),
      remarks: zText(400).default(''),
    }),
    afterWrite: (row, action) => {
      // The gap the spreadsheet had: a blocked order waited for someone to
      // notice. Now the owner is told the moment it is raised or reopened.
      if (action === 'delete') return;
      if (row.status !== 'Pending' || !row.blocks_production) return;
      const order = orderOf(Number(row.order_id));
      const days = row.sent_date
        ? Math.floor((Date.now() - new Date(`${row.sent_date}T00:00:00Z`).getTime()) / 86_400_000)
        : 0;
      notifyApprovalPending(order.order_no, order.buyer, String(row.approval_type), String(row.owner ?? ''), days);
    },
    describe: (r) => `${r.approval_type} · ${r.status}`,
  });

  // ------------------------------------------------- management alert waivers
  registerCrud(app, {
    key: 'waivers',
    table: 'alert_waivers',
    withOrder: true,
    orderBy: 't.created_at DESC',
    columns: ['order_id', 'alert_type', 'approved', 'approved_by', 'approved_at', 'reason', 'valid_until'],
    schema: z.object({
      ...orderRef, ...withCreated,
      alert_type: zText(60).min(1, 'which alert?'),
      approved: z.coerce.number().int().min(0).max(1).default(0),
      approved_by: zText(120).default(''),
      approved_at: z.union([zDate, z.literal(''), z.null()]).optional().transform((v) => (v ? v : null)),
      reason: zText(600).min(3, 'say why this is being accepted'),
      valid_until: zDate,
    }).refine((r) => r.valid_until >= new Date().toISOString().slice(0, 10), {
      message: 'Valid Until has to be today or later, otherwise the alert fires again immediately',
      path: ['valid_until'],
    }),
    describe: (r) => `Waived ${r.alert_type} until ${r.valid_until}`,
  });

  // ====================================================== fabric store ledger
  registerCrud(app, {
    key: 'fabric',
    table: 'fabric_ledger',
    withOrder: true,
    orderBy: 't.txn_date DESC, t.id DESC',
    columns: ['txn_date', 'direction', 'fabric_type', 'colour', 'lot_no', 'order_id',
      'counter_order_id', 'qty_kg', 'rate_per_kg', 'supplier', 'dc_no', 'remarks'],
    learns: { fabric_type: 'fabric_types', colour: 'colours', supplier: 'suppliers' },
    redaction: FABRIC_SPEC,
    filters: { fabric_type: 't.fabric_type = ?', colour: 't.colour = ?', direction: 't.direction = ?' },
    schema: z.object({
      ...withCreated,
      txn_date: zDate,
      direction: z.enum(['RECEIPT', 'ISSUE', 'RETURN', 'ADJUST', 'TRANSFER_OUT', 'TRANSFER_IN']),
      fabric_type: zText(120).min(1, 'which fabric?'),
      colour: zText(120).min(1, 'which colour?'),
      lot_no: zText(80).default(''),
      order_id: z.coerce.number().int().positive().nullable().default(null),
      order_no: zText(60).optional(),
      counter_order_id: z.coerce.number().int().positive().nullable().default(null),
      qty_kg: z.coerce.number().positive('how many kilograms?'),
      rate_per_kg: z.coerce.number().min(0).nullable().default(null),
      supplier: zText(160).default(''),
      dc_no: zText(80).default(''),
      remarks: zText(300).default(''),
    }),
    validate: (row, id) => {
      // Never let the store go negative — that is always a missing receipt.
      const outgoing = ['ISSUE', 'TRANSFER_OUT'];
      if (!outgoing.includes(String(row.direction))) return;
      const bal = one<{ kg: number }>(
        `SELECT COALESCE(SUM(CASE
                   WHEN direction IN ('RECEIPT','RETURN','TRANSFER_IN','ADJUST') THEN qty_kg
                   ELSE -qty_kg END), 0) AS kg
           FROM fabric_ledger
          WHERE fabric_type = ? AND colour = ? AND lot_no = ?
            AND (? IS NULL OR id <> ?)`,
        [row.fabric_type, row.colour, row.lot_no ?? '', id, id],
      )!.kg;
      if (Number(row.qty_kg) > bal + 0.001) {
        throw new HttpError(
          400,
          `The store holds ${bal.toFixed(2)} kg of ${row.fabric_type} ${row.colour}${row.lot_no ? ` lot ${row.lot_no}` : ''}. Issuing ${Number(row.qty_kg).toFixed(2)} kg would take it below zero — record the receipt first.`,
          'fabric_negative',
        );
      }
    },
    describe: (r) => `${r.direction} ${r.qty_kg} kg · ${r.fabric_type} ${r.colour}`,
  });

  /**
   * What is actually left in the store. This is the thing the spreadsheet
   * never had: you could see kilograms in and kilograms consumed, but never
   * what was on the shelf.
   */
  app.get('/api/fabric/stock', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'fabric.view');
    const q = req.query as { fabric_type?: string; colour?: string; order_no?: string; include_zero?: string };
    const where = ['1=1'];
    const params: unknown[] = [];
    if (q.fabric_type) { where.push('f.fabric_type = ?'); params.push(q.fabric_type); }
    if (q.colour) { where.push('f.colour = ?'); params.push(q.colour); }
    if (q.order_no) { where.push('o.order_no = ?'); params.push(q.order_no); }

    const rows = all<Record<string, unknown>>(
      `SELECT f.fabric_type, f.colour, f.lot_no,
              COALESCE(o.order_no, '(free stock)') AS order_no,
              SUM(CASE WHEN f.direction = 'RECEIPT' THEN f.qty_kg ELSE 0 END) AS received_kg,
              SUM(CASE WHEN f.direction = 'ISSUE' THEN f.qty_kg ELSE 0 END) AS issued_kg,
              SUM(CASE WHEN f.direction = 'RETURN' THEN f.qty_kg ELSE 0 END) AS returned_kg,
              SUM(CASE WHEN f.direction = 'TRANSFER_OUT' THEN f.qty_kg ELSE 0 END) AS transferred_out_kg,
              SUM(CASE WHEN f.direction = 'TRANSFER_IN' THEN f.qty_kg ELSE 0 END) AS transferred_in_kg,
              SUM(CASE WHEN f.direction = 'ADJUST' THEN f.qty_kg ELSE 0 END) AS adjusted_kg,
              SUM(CASE WHEN f.direction IN ('RECEIPT','RETURN','TRANSFER_IN','ADJUST') THEN f.qty_kg
                       ELSE -f.qty_kg END) AS balance_kg,
              CASE WHEN SUM(CASE WHEN f.direction='RECEIPT' THEN f.qty_kg ELSE 0 END) > 0
                   THEN ROUND(SUM(CASE WHEN f.direction='RECEIPT' THEN f.qty_kg * COALESCE(f.rate_per_kg,0) ELSE 0 END)
                              / SUM(CASE WHEN f.direction='RECEIPT' THEN f.qty_kg ELSE 0 END), 2)
                   ELSE NULL END AS rate_per_kg,
              MAX(f.txn_date) AS last_movement
         FROM fabric_ledger f LEFT JOIN orders o ON o.id = f.order_id
        WHERE ${where.join(' AND ')}
        GROUP BY f.fabric_type, f.colour, f.lot_no, o.order_no
        ORDER BY f.fabric_type, f.colour, f.lot_no`,
      params,
    );

    const withValue = rows
      .filter((r) => q.include_zero === '1' || Math.abs(Number(r.balance_kg)) > 0.001)
      .map((r) => ({
        ...r,
        stock_value: r.rate_per_kg ? Math.round(Number(r.balance_kg) * Number(r.rate_per_kg) * 100) / 100 : null,
      }));

    return reply.send({ rows: redactMany(req, withValue, FABRIC_SPEC) });
  });

  /** Consumption against issue, per order — where the wastage number comes from. */
  app.get('/api/fabric/consumption', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'fabric.view');
    const q = req.query as { order_no?: string };
    const rows = all<Record<string, unknown>>(
      `SELECT o.order_no, o.buyer, f.fabric_type, f.colour,
              SUM(CASE WHEN f.direction IN ('ISSUE','TRANSFER_OUT') THEN f.qty_kg
                       WHEN f.direction IN ('RETURN','TRANSFER_IN') THEN -f.qty_kg ELSE 0 END) AS net_issued_kg,
              (SELECT ROUND(COALESCE(SUM(c.cut_qty * COALESCE(c.pc_weight_g, c.fabric_gsm * c.area_per_pc_sqm, 0)),0)/1000.0, 2)
                 FROM cutting c WHERE c.order_id = f.order_id AND c.fabric_type = f.fabric_type AND c.colour = f.colour) AS derived_consumed_kg,
              (SELECT m.consumed_kg FROM fabric_manual_consumption m
                WHERE m.order_id = f.order_id AND m.fabric_type = f.fabric_type AND m.colour = f.colour) AS manual_consumed_kg
         FROM fabric_ledger f JOIN orders o ON o.id = f.order_id
        WHERE (? IS NULL OR o.order_no = ?)
        GROUP BY o.order_no, o.buyer, f.order_id, f.fabric_type, f.colour
        ORDER BY o.order_no, f.fabric_type`,
      [q.order_no ?? null, q.order_no ?? null],
    ).map((r) => {
      const consumed = Number(r.manual_consumed_kg ?? r.derived_consumed_kg ?? 0);
      const issued = Number(r.net_issued_kg ?? 0);
      const waste = issued - consumed;
      return {
        ...r,
        consumed_kg: Math.round(consumed * 100) / 100,
        wastage_kg: Math.round(waste * 100) / 100,
        wastage_pct: issued > 0 ? Math.round((waste / issued) * 1000) / 10 : 0,
        source: r.manual_consumed_kg != null ? 're-weighed' : 'from cutting',
      };
    });
    return reply.send({ rows });
  });

  app.post('/api/fabric/consumption', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'fabric.edit');
    const body = parse(z.object({
      order_id: z.coerce.number().int().positive(),
      fabric_type: zText(120).min(1),
      colour: zText(120).min(1),
      consumed_kg: z.coerce.number().min(0),
      as_of_date: zDate,
      remarks: zText(300).default(''),
    }), req.body);
    const { run } = await import('../db/index.js');
    run(
      `INSERT INTO fabric_manual_consumption (order_id, fabric_type, colour, consumed_kg, as_of_date, remarks, created_by)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(order_id, fabric_type, colour)
       DO UPDATE SET consumed_kg = excluded.consumed_kg, as_of_date = excluded.as_of_date,
                     remarks = excluded.remarks`,
      [body.order_id, body.fabric_type, body.colour, body.consumed_kg, body.as_of_date,
        body.remarks, req.principal?.userId ?? null],
    );
    const { audit } = await import('../audit/index.js');
    audit(req, {
      action: 'update', entity: 'fabric_manual_consumption',
      summary: `Re-weighed ${body.fabric_type} ${body.colour}: ${body.consumed_kg} kg`,
      after: body, severity: 'notice',
    });
    return reply.send({ ok: true });
  });
}
