import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { all, one, run, tx } from '../db/index.js';
import { audit } from '../audit/index.js';
import { assertPermission, can } from '../rbac/guard.js';
import { HttpError, parse, sendCsv, zText } from '../lib/http.js';
import { computeCostSheet, computeQuantities, type CostResult, type CostSheetInput } from '../engine/costing.js';
import { effectiveExcessPct, type OrderRow } from '../engine/facts.js';
import { bestRate, rememberRate, rememberRateWithFallback, type RateContext } from './rates.js';
import { learnValue } from './masters.js';
import { notify } from './notifications.js';

/**
 * Cost sheets.
 *
 * A sheet is saved whole — header plus every line — in one transaction. That
 * keeps the arithmetic honest (you can never persist a fabric line against a
 * quantity basis that has since changed) and it makes the editor simple: it
 * holds a draft in the browser and puts the whole thing back.
 *
 * Blocks the caller may not see are stripped server-side, both on the way out
 * and on the way in: someone allowed to edit trims but not job work cannot
 * blank the job-work lines by omitting them.
 */

const BLOCKS = ['fabric', 'trims', 'jobwork', 'cmt', 'overheads'] as const;
type Block = (typeof BLOCKS)[number];

const FabricComponent = z.object({
  component: zText(80).min(1),
  rate_per_kg: z.coerce.number().min(0).default(0),
  vendor: zText(160).default(''),
  loss_pct: z.coerce.number().min(0).max(95).default(0),
  remarks: zText(240).default(''),
});

const FabricLine = z.object({
  fabric_type: zText(120).min(1, 'pick a fabric'),
  colour: zText(120).default(''),
  part: zText(80).default('Body'),
  gsm: z.coerce.number().min(0).default(0),
  consumption_g_per_pc: z.coerce.number().min(0).default(0),
  wastage_pct: z.coerce.number().min(0).max(100).default(0),
  rate_mode: z.enum(['buildup', 'flat']).default('buildup'),
  flat_rate_per_kg: z.coerce.number().min(0).default(0),
  applies_qty_pct: z.coerce.number().min(0).max(100).default(100),
  supplier: zText(160).default(''),
  remarks: zText(240).default(''),
  components: z.array(FabricComponent).default([]),
});

const TrimLine = z.object({
  trim_item: zText(120).min(1, 'pick a trim'),
  colour: zText(120).default(''),
  size: zText(60).default(''),
  uom: zText(20).default('pcs'),
  qty_per_pc: z.coerce.number().min(0).default(1),
  rate_per_unit: z.coerce.number().min(0).default(0),
  wastage_pct: z.coerce.number().min(0).max(100).default(0),
  applies_qty_pct: z.coerce.number().min(0).max(100).default(100),
  supplier: zText(160).default(''),
  remarks: zText(240).default(''),
});

const JobWorkLine = z.object({
  process: zText(80).min(1, 'pick a process'),
  vendor: zText(160).default(''),
  colour: zText(120).default(''),
  step_no: z.coerce.number().int().nullable().optional(),
  rate_per_pc: z.coerce.number().min(0).default(0),
  applies_qty_pct: z.coerce.number().min(0).max(100).default(100),
  vendor_loss_pct: z.coerce.number().min(0).max(90).default(0),
  freight_per_order: z.coerce.number().min(0).default(0),
  remarks: zText(240).default(''),
});

const CmtLine = z.object({
  operation: zText(80).min(1, 'name the operation'),
  basis: z.enum(['per_pc', 'per_order', 'per_sam_min', 'pct_of_cost']).default('per_pc'),
  rate: z.coerce.number().min(0).default(0),
  sam_min: z.coerce.number().min(0).default(0),
  efficiency_pct: z.coerce.number().min(1).max(200).default(100),
  applies_qty_pct: z.coerce.number().min(0).max(100).default(100),
  remarks: zText(240).default(''),
});

const OverheadLine = z.object({
  category: zText(80).min(1, 'name the cost'),
  basis: z.enum(['per_pc', 'per_order', 'pct_of_cost', 'pct_of_revenue']).default('per_order'),
  amount: z.coerce.number().min(0).default(0),
  vendor: zText(160).default(''),
  remarks: zText(240).default(''),
});

const SheetBody = z.object({
  label: zText(60).default('Quotation'),
  excess_pct: z.coerce.number().min(0).max(100).default(0),
  excess_billable: z.boolean().default(true),
  rejection_pct: z.coerce.number().min(0).max(90).default(0),
  currency: zText(8).default('INR'),
  fx_rate: z.coerce.number().positive().default(1),
  selling_price_per_pc: z.coerce.number().min(0).default(0),
  price_basis: zText(20).default('FOB'),
  target_margin_pct: z.coerce.number().min(0).max(99).default(0),
  notes: zText(2000).default(''),
  order_qty: z.coerce.number().int().min(0).optional(),
  fabric: z.array(FabricLine).optional(),
  trims: z.array(TrimLine).optional(),
  jobwork: z.array(JobWorkLine).optional(),
  cmt: z.array(CmtLine).optional(),
  overheads: z.array(OverheadLine).optional(),
  prices: z.array(z.object({
    colour: zText(120).default(''), size: zText(60).default(''),
    price_per_pc: z.coerce.number().min(0),
  })).optional(),
});

export interface SheetRow {
  id: number; order_id: number; version: number; label: string; status: string;
  is_primary: number; order_qty: number; excess_pct: number; excess_billable: number;
  rejection_pct: number; currency: string; fx_rate: number; selling_price_per_pc: number;
  price_basis: string; target_margin_pct: number; notes: string;
  submitted_by: number | null; submitted_at: string | null;
  approved_by: number | null; approved_at: string | null; approval_note: string;
  created_at: string; updated_at: string;
}

function orderByNo(orderNo: string): OrderRow {
  const row = one<OrderRow>('SELECT * FROM orders WHERE order_no = ?', [orderNo]);
  if (!row) throw new HttpError(404, `No order called "${orderNo}"`, 'unknown_order');
  return row;
}

function loadLines(sheetId: number) {
  const fabric = all<Record<string, unknown>>(
    'SELECT * FROM cost_fabric_lines WHERE cost_sheet_id = ? ORDER BY sort_order, id', [sheetId],
  ).map((f) => ({
    ...f,
    components: all('SELECT * FROM cost_fabric_components WHERE fabric_line_id = ? ORDER BY sort_order, id', [f.id as number]),
  }));
  return {
    fabric,
    trims: all('SELECT * FROM cost_trim_lines WHERE cost_sheet_id = ? ORDER BY sort_order, id', [sheetId]),
    jobwork: all('SELECT * FROM cost_jobwork_lines WHERE cost_sheet_id = ? ORDER BY sort_order, id', [sheetId]),
    cmt: all('SELECT * FROM cost_cmt_lines WHERE cost_sheet_id = ? ORDER BY sort_order, id', [sheetId]),
    overheads: all('SELECT * FROM cost_overhead_lines WHERE cost_sheet_id = ? ORDER BY sort_order, id', [sheetId]),
    prices: all('SELECT * FROM cost_sheet_prices WHERE cost_sheet_id = ?', [sheetId]),
  };
}

function toEngineInput(sheet: SheetRow, lines: ReturnType<typeof loadLines>, matrixQty: Map<string, number>): CostSheetInput {
  return {
    order_qty: sheet.order_qty,
    excess_pct: sheet.excess_pct,
    excess_billable: Boolean(sheet.excess_billable),
    rejection_pct: sheet.rejection_pct,
    currency: sheet.currency,
    fx_rate: sheet.fx_rate,
    selling_price_per_pc: sheet.selling_price_per_pc,
    target_margin_pct: sheet.target_margin_pct,
    fabric: lines.fabric as never,
    trims: lines.trims as never,
    jobwork: lines.jobwork as never,
    cmt: lines.cmt as never,
    overheads: lines.overheads as never,
    priceOverrides: (lines.prices as Record<string, unknown>[]).map((p) => ({
      colour: String(p.colour), size: String(p.size),
      price_per_pc: Number(p.price_per_pc),
      qty: matrixQty.get(`${p.colour}|${p.size}`) ?? 0,
    })).filter((p) => p.qty > 0),
  };
}

function matrixQtyMap(orderId: number): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of all<{ colour: string; size: string; order_qty: number }>(
    'SELECT colour, size, order_qty FROM order_matrix WHERE order_id = ?', [orderId],
  )) m.set(`${r.colour}|${r.size}`, r.order_qty);
  return m;
}

/** Remove blocks and totals the caller has no right to see. */
function redactResult(req: FastifyRequest, result: CostResult, lines: ReturnType<typeof loadLines>) {
  const visible = new Set(BLOCKS.filter((b) => can(req, `costing.${b}.view`)));
  const seeTotal = can(req, 'costing.total_cost.view');
  const seePrice = can(req, 'costing.selling_price.view');
  const seeMargin = can(req, 'costing.margin.view');

  const blocks = result.blocks.map((b) =>
    visible.has(b.key)
      ? b
      : { key: b.key, label: b.label, lines: [], total: 0, perPc: 0, pctOfCost: 0, locked: true });

  const out: Record<string, unknown> = { ...result, blocks };
  if (!seeTotal) {
    for (const k of ['totalCost', 'costPerPcShipped', 'costPerPcProduced', 'materialTotal', 'conversionTotal', 'overheadTotal', 'breakEvenPricePerPc']) {
      delete out[k];
    }
    out.total_cost__locked = true;
  }
  if (!seePrice) {
    for (const k of ['revenue', 'revenuePerPc', 'sellingPricePerPc', 'targetPricePerPc']) delete out[k];
    out.selling_price__locked = true;
  }
  if (!seeMargin) {
    for (const k of ['margin', 'marginPerPc', 'marginPct', 'markupPct']) delete out[k];
    out.margin__locked = true;
  }

  const visibleLines: Record<string, unknown> = { prices: seePrice ? lines.prices : [] };
  for (const b of BLOCKS) visibleLines[b] = visible.has(b) ? lines[b] : [];
  return { result: out, lines: visibleLines, visibleBlocks: [...visible] };
}

function saveLines(sheetId: number, body: z.infer<typeof SheetBody>, req: FastifyRequest, order: OrderRow): void {
  const editable = (b: Block) => can(req, `costing.${b}.edit`);
  const orderNo = order.order_no;
  const memoBase = { buyer: order.buyer, style: order.style };
  const userId = req.principal?.userId ?? null;

  if (body.fabric && editable('fabric')) {
    run('DELETE FROM cost_fabric_lines WHERE cost_sheet_id = ?', [sheetId]);
    body.fabric.forEach((line, i) => {
      const info = run(
        `INSERT INTO cost_fabric_lines (cost_sheet_id, fabric_type, colour, part, gsm,
            consumption_g_per_pc, wastage_pct, rate_mode, flat_rate_per_kg, applies_qty_pct,
            supplier, remarks, sort_order)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [sheetId, line.fabric_type, line.colour, line.part, line.gsm, line.consumption_g_per_pc,
          line.wastage_pct, line.rate_mode, line.flat_rate_per_kg, line.applies_qty_pct,
          line.supplier, line.remarks, i],
      );
      const lineId = info.lastInsertRowid as number;
      learnValue('fabric_types', line.fabric_type, userId);
      if (line.colour) learnValue('colours', line.colour, userId);
      if (line.part) learnValue('fabric_parts', line.part, userId);
      if (line.supplier) learnValue('suppliers', line.supplier, userId);

      line.components.forEach((c, j) => {
        run(
          `INSERT INTO cost_fabric_components (fabric_line_id, component, rate_per_kg, vendor, loss_pct, remarks, sort_order)
           VALUES (?,?,?,?,?,?,?)`,
          [lineId, c.component, c.rate_per_kg, c.vendor, c.loss_pct, c.remarks, j],
        );
        learnValue('fabric_components', c.component, userId);
        if (c.vendor) learnValue('vendors', c.vendor, userId);
        rememberRateWithFallback(
          { kind: 'fabric_component', ...memoBase, fabric_type: line.fabric_type, colour: line.colour, component: c.component, vendor: c.vendor, uom: 'kg' } as RateContext,
          c.rate_per_kg, ['colour'], { orderNo, costSheetId: sheetId, userId },
        );
      });
      if (line.rate_mode === 'flat') {
        rememberRateWithFallback(
          { kind: 'fabric_flat', ...memoBase, fabric_type: line.fabric_type, colour: line.colour, uom: 'kg' } as RateContext,
          line.flat_rate_per_kg, ['colour'], { orderNo, costSheetId: sheetId, userId },
        );
      }
      rememberRate(
        { kind: 'consumption', ...memoBase, fabric_type: line.fabric_type, uom: 'g' } as RateContext,
        line.consumption_g_per_pc, { orderNo, costSheetId: sheetId, userId },
      );
    });
  }

  if (body.trims && editable('trims')) {
    run('DELETE FROM cost_trim_lines WHERE cost_sheet_id = ?', [sheetId]);
    body.trims.forEach((line, i) => {
      run(
        `INSERT INTO cost_trim_lines (cost_sheet_id, trim_item, colour, size, uom, qty_per_pc,
            rate_per_unit, wastage_pct, applies_qty_pct, supplier, remarks, sort_order)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [sheetId, line.trim_item, line.colour, line.size, line.uom, line.qty_per_pc,
          line.rate_per_unit, line.wastage_pct, line.applies_qty_pct, line.supplier, line.remarks, i],
      );
      learnValue('trim_items', line.trim_item, userId);
      learnValue('trim_uoms', line.uom, userId);
      rememberRateWithFallback(
        { kind: 'trim', ...memoBase, trim_item: line.trim_item, colour: line.colour, uom: line.uom } as RateContext,
        line.rate_per_unit, ['colour'], { orderNo, costSheetId: sheetId, userId },
      );
    });
  }

  if (body.jobwork && editable('jobwork')) {
    run('DELETE FROM cost_jobwork_lines WHERE cost_sheet_id = ?', [sheetId]);
    body.jobwork.forEach((line, i) => {
      run(
        `INSERT INTO cost_jobwork_lines (cost_sheet_id, process, vendor, colour, step_no,
            rate_per_pc, applies_qty_pct, vendor_loss_pct, freight_per_order, remarks, sort_order)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [sheetId, line.process, line.vendor, line.colour, line.step_no ?? null, line.rate_per_pc,
          line.applies_qty_pct, line.vendor_loss_pct, line.freight_per_order, line.remarks, i],
      );
      learnValue('jobwork_processes', line.process, userId);
      if (line.vendor) learnValue('vendors', line.vendor, userId);
      rememberRateWithFallback(
        { kind: 'jobwork', ...memoBase, process: line.process, vendor: line.vendor, colour: line.colour, uom: 'pc' } as RateContext,
        line.rate_per_pc, ['colour'], { orderNo, costSheetId: sheetId, userId },
      );
    });
  }

  if (body.cmt && editable('cmt')) {
    run('DELETE FROM cost_cmt_lines WHERE cost_sheet_id = ?', [sheetId]);
    body.cmt.forEach((line, i) => {
      run(
        `INSERT INTO cost_cmt_lines (cost_sheet_id, operation, basis, rate, sam_min,
            efficiency_pct, applies_qty_pct, remarks, sort_order)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [sheetId, line.operation, line.basis, line.rate, line.sam_min,
          line.efficiency_pct, line.applies_qty_pct, line.remarks, i],
      );
      learnValue('cmt_operations', line.operation, userId);
      rememberRate(
        { kind: 'cmt', ...memoBase, operation: line.operation, uom: line.basis } as RateContext,
        line.rate, { orderNo, costSheetId: sheetId, userId },
      );
    });
  }

  if (body.overheads && editable('overheads')) {
    run('DELETE FROM cost_overhead_lines WHERE cost_sheet_id = ?', [sheetId]);
    body.overheads.forEach((line, i) => {
      run(
        `INSERT INTO cost_overhead_lines (cost_sheet_id, category, basis, amount, vendor, remarks, sort_order)
         VALUES (?,?,?,?,?,?,?)`,
        [sheetId, line.category, line.basis, line.amount, line.vendor, line.remarks, i],
      );
      learnValue('overhead_categories', line.category, userId);
      rememberRate(
        { kind: 'overhead', ...memoBase, category: line.category, uom: line.basis } as RateContext,
        line.amount, { orderNo, costSheetId: sheetId, userId },
      );
    });
  }

  if (body.prices && can(req, 'costing.selling_price.edit')) {
    run('DELETE FROM cost_sheet_prices WHERE cost_sheet_id = ?', [sheetId]);
    for (const p of body.prices) {
      run(
        'INSERT INTO cost_sheet_prices (cost_sheet_id, colour, size, price_per_pc) VALUES (?,?,?,?)',
        [sheetId, p.colour, p.size, p.price_per_pc],
      );
    }
  }
}

/**
 * A first draft built from what the app already knows: the order's own route
 * decides which job-work lines exist, the matrix decides the colours, and the
 * rate library fills in every number it has seen before.
 */
export function proposeSheet(order: OrderRow) {
  const ctx = { buyer: order.buyer, style: order.style };
  const colours = all<{ colour: string }>(
    'SELECT DISTINCT colour FROM order_matrix WHERE order_id = ? ORDER BY colour', [order.id],
  ).map((r) => r.colour);

  const usedFabrics = all<{ fabric_type: string; colour: string; g: number }>(
    `SELECT fabric_type, colour, AVG(COALESCE(pc_weight_g, fabric_gsm * area_per_pc_sqm, 0)) AS g
       FROM cutting WHERE order_id = ? AND fabric_type <> '' GROUP BY fabric_type, colour`,
    [order.id],
  );

  const fabricSeeds = usedFabrics.length
    ? usedFabrics.map((f) => ({ fabric_type: f.fabric_type, colour: f.colour, g: f.g }))
    : (() => {
      const guess = bestRate({ kind: 'consumption', ...ctx, uom: 'g' } as RateContext);
      const lastFabric = one<{ fabric_type: string }>(
        `SELECT fl.fabric_type FROM cost_fabric_lines fl
           JOIN cost_sheets cs ON cs.id = fl.cost_sheet_id
           JOIN orders o ON o.id = cs.order_id
          WHERE o.buyer = ? ORDER BY cs.updated_at DESC LIMIT 1`, [order.buyer],
      );
      return lastFabric
        ? colours.map((c) => ({ fabric_type: lastFabric.fabric_type, colour: c, g: guess?.rate ?? 0 }))
        : [];
    })();

  const componentNames = all<{ value: string }>(
    `SELECT value FROM master_values WHERE list_code = 'fabric_components' AND is_active = 1
      ORDER BY use_count DESC, sort_order LIMIT 6`,
  ).map((r) => r.value);

  const fabric = fabricSeeds.map((f) => ({
    fabric_type: f.fabric_type,
    colour: f.colour,
    part: 'Body',
    gsm: 0,
    consumption_g_per_pc: Math.round(f.g || 0),
    wastage_pct: 8,
    rate_mode: 'buildup' as const,
    flat_rate_per_kg: 0,
    applies_qty_pct: 100,
    supplier: '',
    remarks: '',
    components: (componentNames.length ? componentNames : ['Yarn', 'Knitting', 'Dyeing', 'Compacting'])
      .map((component) => {
        // A colour-free memory is a wildcard in the lookup, so this picks the
        // colour-specific dyeing rate when there is one and the general yarn
        // and knitting rates otherwise, without a second query.
        const s = bestRate({ kind: 'fabric_component', ...ctx, fabric_type: f.fabric_type, colour: f.colour, component, uom: 'kg' } as RateContext);
        return {
          component, rate_per_kg: s?.rate ?? 0, vendor: '', loss_pct: 0, remarks: '',
          _because: s?.because ?? '', _placeholder: s?.placeholder ?? false,
        };
      }),
  }));

  const outsourced = all<{ step_no: number; process: string }>(
    "SELECT step_no, process FROM order_route WHERE order_id = ? AND type = 'Outsourced' ORDER BY step_no",
    [order.id],
  );
  const jobwork = outsourced.map((s) => {
    const lastVendor = one<{ vendor: string }>(
      'SELECT vendor FROM job_work WHERE order_id = ? AND process = ? ORDER BY txn_date DESC LIMIT 1',
      [order.id, s.process],
    )?.vendor ?? '';
    const sug = bestRate({ kind: 'jobwork', ...ctx, process: s.process, vendor: lastVendor, uom: 'pc' } as RateContext);
    return {
      process: s.process, vendor: lastVendor, colour: '', step_no: s.step_no,
      rate_per_pc: sug?.rate ?? 0, applies_qty_pct: 100, vendor_loss_pct: 0,
      freight_per_order: 0, remarks: '',
      _because: sug?.because ?? '', _placeholder: sug?.placeholder ?? false,
    };
  });

  const cmtOps = all<{ value: string }>(
    `SELECT value FROM master_values WHERE list_code = 'cmt_operations' AND is_active = 1
      ORDER BY use_count DESC, sort_order LIMIT 10`,
  ).map((r) => r.value);
  const cmt = (cmtOps.length ? cmtOps : ['Cutting', 'Sewing', 'Fusing', 'Ironing', 'Checking', 'Packing'])
    .map((operation) => {
      const isSewing = operation.toLowerCase() === 'sewing';
      const basis = isSewing && order.sam > 0 ? 'per_sam_min' as const : 'per_pc' as const;
      const sug = bestRate({ kind: 'cmt', ...ctx, operation, uom: basis } as RateContext);
      return {
        operation, basis, rate: sug?.rate ?? 0,
        sam_min: isSewing ? order.sam : 0,
        efficiency_pct: isSewing ? 65 : 100,
        applies_qty_pct: 100, remarks: '',
        _because: sug?.because ?? '', _placeholder: sug?.placeholder ?? false,
      };
    });

  const trimItems = all<{ trim_item: string }>(
    'SELECT DISTINCT trim_item FROM trims WHERE order_id = ?', [order.id],
  ).map((r) => r.trim_item);
  const fallbackTrims = all<{ value: string }>(
    `SELECT value FROM master_values WHERE list_code = 'trim_items' AND is_active = 1
      ORDER BY use_count DESC LIMIT 8`,
  ).map((r) => r.value);
  const trims = (trimItems.length ? trimItems : fallbackTrims).map((trim_item) => {
    const sug = bestRate({ kind: 'trim', ...ctx, trim_item, uom: 'pcs' } as RateContext);
    return {
      trim_item, colour: '', size: '', uom: 'pcs', qty_per_pc: 1,
      rate_per_unit: sug?.rate ?? 0, wastage_pct: 2, applies_qty_pct: 100,
      supplier: '', remarks: '',
      _because: sug?.because ?? '', _placeholder: sug?.placeholder ?? false,
    };
  });

  const ohCats = all<{ value: string }>(
    `SELECT value FROM master_values WHERE list_code = 'overhead_categories' AND is_active = 1
      ORDER BY use_count DESC LIMIT 10`,
  ).map((r) => r.value);
  const overheads = (ohCats.length ? ohCats : ['Sampling', 'Lab Test', 'Documentation', 'Transportation'])
    .map((category) => {
      const sug = bestRate({ kind: 'overhead', ...ctx, category, uom: 'per_order' } as RateContext);
      return {
        category, basis: 'per_order' as const, amount: sug?.rate ?? 0, vendor: '', remarks: '',
        _because: sug?.because ?? '', _placeholder: sug?.placeholder ?? false,
      };
    });

  const priceSug = bestRate({ kind: 'selling_price', ...ctx, uom: 'pc' } as RateContext);

  return {
    excess_pct: effectiveExcessPct(order),
    excess_billable: (one<{ excess_billable: number }>('SELECT excess_billable FROM buyers WHERE name = ?', [order.buyer])?.excess_billable ?? 1) === 1,
    rejection_pct: 2,
    currency: order.currency,
    fx_rate: order.fx_rate,
    selling_price_per_pc: priceSug?.rate ?? 0,
    selling_price_because: priceSug?.because ?? '',
    selling_price_placeholder: priceSug?.placeholder ?? false,
    fabric, trims, jobwork, cmt, overheads,
  };
}

/**
 * What the order really cost, using quantities the floor actually logged and
 * the rates on the sheet. Where a real rate exists — a fabric receipt has one —
 * that beats the planned rate.
 */
export function actualsFor(sheet: SheetRow, order: OrderRow) {
  const lines = loadLines(sheet.id);
  const producedRow = one<{ q: number }>(
    'SELECT COALESCE(SUM(cut_qty),0) AS q FROM cutting WHERE order_id = ? AND counts_as_garment = 1', [order.id],
  );
  const shippedRow = one<{ q: number }>('SELECT COALESCE(SUM(ship_qty),0) AS q FROM shipment WHERE order_id = ?', [order.id]);
  const rejectRow = one<{ q: number }>('SELECT COALESCE(SUM(reject_qty),0) AS q FROM checking WHERE order_id = ?', [order.id]);
  const produced = producedRow?.q ?? 0;
  const shipped = shippedRow?.q ?? 0;
  const rejected = rejectRow?.q ?? 0;

  // --- fabric: kilograms genuinely issued, valued at the receipt rate --------
  const fabricActual = all<{ fabric_type: string; colour: string; issued: number; recd_kg: number; recd_val: number }>(
    `SELECT fabric_type, colour,
            SUM(CASE WHEN direction IN ('ISSUE','TRANSFER_OUT') THEN qty_kg
                     WHEN direction IN ('RETURN','TRANSFER_IN') THEN -qty_kg ELSE 0 END) AS issued,
            SUM(CASE WHEN direction = 'RECEIPT' THEN qty_kg ELSE 0 END) AS recd_kg,
            SUM(CASE WHEN direction = 'RECEIPT' THEN qty_kg * COALESCE(rate_per_kg,0) ELSE 0 END) AS recd_val
       FROM fabric_ledger WHERE order_id = ? GROUP BY fabric_type, colour`,
    [order.id],
  );

  let fabricCost = 0;
  const fabricRows = fabricActual.map((f) => {
    const manual = one<{ consumed_kg: number }>(
      'SELECT consumed_kg FROM fabric_manual_consumption WHERE order_id = ? AND fabric_type = ? AND colour = ?',
      [order.id, f.fabric_type, f.colour],
    );
    const kg = manual?.consumed_kg ?? Math.max(f.issued, 0);
    const planned = (lines.fabric as Record<string, unknown>[]).find(
      (l) => l.fabric_type === f.fabric_type && (l.colour === f.colour || l.colour === ''),
    );
    const plannedRate = planned
      ? (planned.rate_mode === 'flat'
        ? Number(planned.flat_rate_per_kg)
        : (planned.components as Record<string, unknown>[] ?? [])
          .reduce((s, c) => s + Number(c.rate_per_kg) / (1 - Number(c.loss_pct ?? 0) / 100), 0))
      : 0;
    const receiptRate = f.recd_kg > 0 && f.recd_val > 0 ? f.recd_val / f.recd_kg : 0;
    const rate = receiptRate || plannedRate;
    const cost = kg * rate;
    fabricCost += cost;
    return {
      fabric_type: f.fabric_type, colour: f.colour, kg: Math.round(kg * 100) / 100,
      rate: Math.round(rate * 100) / 100, source: receiptRate ? 'receipt' : 'plan',
      total: Math.round(cost * 100) / 100,
    };
  });

  // --- job work: pieces actually sent out, at the sheet's rate ---------------
  let jobworkCost = 0;
  const jobworkRows = all<{ process: string; vendor: string; qty: number }>(
    `SELECT process, vendor, SUM(qty) AS qty FROM job_work
      WHERE order_id = ? AND direction = 'OUT' GROUP BY process, vendor`, [order.id],
  ).map((j) => {
    const planned = (lines.jobwork as Record<string, unknown>[]).find(
      (l) => l.process === j.process && (l.vendor === j.vendor || l.vendor === ''),
    );
    const rate = Number(planned?.rate_per_pc ?? 0);
    const freight = Number(planned?.freight_per_order ?? 0);
    const cost = j.qty * rate + freight;
    jobworkCost += cost;
    return { process: j.process, vendor: j.vendor, qty: j.qty, rate, total: Math.round(cost * 100) / 100 };
  });

  // --- trims and CMT: planned per-piece rates against real production --------
  const trimCost = (lines.trims as Record<string, unknown>[]).reduce((s, t) => {
    const perPc = Number(t.qty_per_pc) * (1 + Number(t.wastage_pct) / 100);
    return s + perPc * produced * (Number(t.applies_qty_pct) / 100) * Number(t.rate_per_unit);
  }, 0);

  const cmtCost = (lines.cmt as Record<string, unknown>[]).reduce((s, c) => {
    const share = Number(c.applies_qty_pct) / 100;
    if (c.basis === 'per_order') return s + Number(c.rate);
    if (c.basis === 'pct_of_cost') return s;
    if (c.basis === 'per_sam_min') {
      const eff = Math.max(Number(c.efficiency_pct) || 100, 1) / 100;
      return s + (Number(c.sam_min) / eff) * produced * share * Number(c.rate);
    }
    return s + produced * share * Number(c.rate);
  }, 0);

  const overheadCost = (lines.overheads as Record<string, unknown>[]).reduce((s, o) => {
    if (o.basis === 'per_pc') return s + Number(o.amount) * produced;
    if (o.basis === 'per_order') return s + Number(o.amount);
    return s;
  }, 0);

  const total = fabricCost + trimCost + jobworkCost + cmtCost + overheadCost;
  const revenue = shipped * sheet.selling_price_per_pc * sheet.fx_rate;
  const r2 = (n: number) => Math.round(n * 100) / 100;

  return {
    produced, shipped, rejected,
    fabric: { rows: fabricRows, total: r2(fabricCost) },
    jobwork: { rows: jobworkRows, total: r2(jobworkCost) },
    trims: { total: r2(trimCost) },
    cmt: { total: r2(cmtCost) },
    overheads: { total: r2(overheadCost) },
    totalCost: r2(total),
    costPerPcProduced: produced ? r2(total / produced) : 0,
    costPerPcShipped: shipped ? r2(total / shipped) : 0,
    revenue: r2(revenue),
    margin: r2(revenue - total),
    marginPct: revenue ? r2(((revenue - total) / revenue) * 100) : 0,
  };
}

export function registerCosting(app: FastifyInstance): void {
  // ------------------------------------------------------------ list sheets
  app.get('/api/costing', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'costing.view');
    const q = req.query as Record<string, string>;
    const where = ['1=1'];
    const params: unknown[] = [];
    if (q.buyer) { where.push('o.buyer = ?'); params.push(q.buyer); }
    if (q.status) { where.push('cs.status = ?'); params.push(q.status); }
    if (q.q) { where.push('(o.order_no LIKE ? OR o.style LIKE ?)'); params.push(`%${q.q}%`, `%${q.q}%`); }

    const sheets = all<SheetRow & { order_no: string; buyer: string; style: string }>(
      `SELECT cs.*, o.order_no, o.buyer, o.style FROM cost_sheets cs
         JOIN orders o ON o.id = cs.order_id
        WHERE ${where.join(' AND ')} AND cs.is_primary = 1
        ORDER BY cs.updated_at DESC LIMIT 300`, params,
    );

    const rows = sheets.map((s) => {
      const lines = loadLines(s.id);
      const result = computeCostSheet(toEngineInput(s, lines, matrixQtyMap(s.order_id)));
      const seeTotal = can(req, 'costing.total_cost.view');
      const seeMargin = can(req, 'costing.margin.view');
      const seePrice = can(req, 'costing.selling_price.view');
      return {
        id: s.id, order_no: s.order_no, buyer: s.buyer, style: s.style,
        version: s.version, label: s.label, status: s.status,
        order_qty: s.order_qty, ship_qty: result.quantities.shipQty,
        excess_qty: result.quantities.excessQty, currency: s.currency,
        updated_at: s.updated_at,
        ...(seeTotal ? { cost_per_pc: result.costPerPcShipped, total_cost: result.totalCost } : { total_cost__locked: true }),
        ...(seePrice ? { selling_price_per_pc: s.selling_price_per_pc } : { selling_price__locked: true }),
        ...(seeMargin ? { margin: result.margin, margin_pct: result.marginPct } : { margin__locked: true }),
      };
    });
    return reply.send({ rows });
  });

  // --------------------------------------------------------- propose a draft
  app.get('/api/costing/propose', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'costing.create');
    const { order_no } = req.query as { order_no?: string };
    if (!order_no) throw new HttpError(400, 'Which order?', 'missing_order');
    const order = orderByNo(order_no);
    return reply.send({ order, proposal: proposeSheet(order) });
  });

  // ------------------------------------------------------------- one sheet
  app.get('/api/costing/order/:orderNo', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'costing.view');
    const order = orderByNo((req.params as { orderNo: string }).orderNo);
    const version = Number((req.query as { version?: string }).version);
    const sheet = version
      ? one<SheetRow>('SELECT * FROM cost_sheets WHERE order_id = ? AND version = ?', [order.id, version])
      : one<SheetRow>('SELECT * FROM cost_sheets WHERE order_id = ? AND is_primary = 1', [order.id])
        ?? one<SheetRow>('SELECT * FROM cost_sheets WHERE order_id = ? ORDER BY version DESC LIMIT 1', [order.id]);

    const versions = all<{ id: number; version: number; label: string; status: string; updated_at: string }>(
      'SELECT id, version, label, status, updated_at FROM cost_sheets WHERE order_id = ? ORDER BY version DESC',
      [order.id],
    );
    if (!sheet) return reply.send({ order, sheet: null, versions, proposal: proposeSheet(order) });

    const lines = loadLines(sheet.id);
    const result = computeCostSheet(toEngineInput(sheet, lines, matrixQtyMap(order.id)));
    const redacted = redactResult(req, result, lines);
    return reply.send({ order, sheet, versions, ...redacted });
  });

  // ----------------------------------------------------------- create sheet
  app.post('/api/costing/order/:orderNo', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'costing.create');
    const order = orderByNo((req.params as { orderNo: string }).orderNo);
    const body = parse(SheetBody, req.body ?? {});

    const sheet = tx(() => {
      const nextVersion = (one<{ v: number }>(
        'SELECT COALESCE(MAX(version),0) + 1 AS v FROM cost_sheets WHERE order_id = ?', [order.id],
      )?.v ?? 1);
      run('UPDATE cost_sheets SET is_primary = 0 WHERE order_id = ?', [order.id]);
      const info = run(
        `INSERT INTO cost_sheets (order_id, version, label, order_qty, excess_pct, excess_billable,
            rejection_pct, currency, fx_rate, selling_price_per_pc, price_basis,
            target_margin_pct, notes, is_primary, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`,
        [order.id, nextVersion, body.label, body.order_qty ?? order.order_qty, body.excess_pct,
          body.excess_billable ? 1 : 0, body.rejection_pct, body.currency, body.fx_rate,
          body.selling_price_per_pc, body.price_basis, body.target_margin_pct, body.notes,
          req.principal?.userId ?? null],
      );
      const id = info.lastInsertRowid as number;
      saveLines(id, body, req, order);
      if (body.selling_price_per_pc > 0) {
        rememberRate(
          { kind: 'selling_price', buyer: order.buyer, style: order.style, uom: 'pc' } as RateContext,
          body.selling_price_per_pc,
          { orderNo: order.order_no, costSheetId: id, userId: req.principal?.userId, currency: body.currency },
        );
      }
      return one<SheetRow>('SELECT * FROM cost_sheets WHERE id = ?', [id])!;
    });

    audit(req, {
      action: 'create', entity: 'cost_sheets', entityId: sheet.id,
      summary: `Created cost sheet v${sheet.version} for ${order.order_no}`,
      after: { ...sheet, lines: body }, severity: 'notice',
    });
    return reply.code(201).send(sheet);
  });

  // ------------------------------------------------------------- save sheet
  app.put('/api/costing/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'costing.edit');
    const id = Number((req.params as { id: string }).id);
    const before = one<SheetRow>('SELECT * FROM cost_sheets WHERE id = ?', [id]);
    if (!before) throw new HttpError(404, 'That cost sheet is gone', 'not_found');
    if (before.status === 'locked') throw new HttpError(409, 'This sheet is locked. Create a new version to change it.', 'locked');
    if (before.status === 'approved' && !can(req, 'costing.approve')) {
      throw new HttpError(409, 'This sheet is approved. Ask for it to be reopened, or start a new version.', 'approved');
    }
    const order = one<OrderRow>('SELECT * FROM orders WHERE id = ?', [before.order_id])!;
    const body = parse(SheetBody, req.body);
    const beforeLines = loadLines(id);

    const after = tx(() => {
      const price = can(req, 'costing.selling_price.edit') ? body.selling_price_per_pc : before.selling_price_per_pc;
      run(
        `UPDATE cost_sheets SET label = ?, order_qty = ?, excess_pct = ?, excess_billable = ?,
            rejection_pct = ?, currency = ?, fx_rate = ?, selling_price_per_pc = ?,
            price_basis = ?, target_margin_pct = ?, notes = ?, updated_at = datetime('now')
          WHERE id = ?`,
        [body.label, body.order_qty ?? before.order_qty, body.excess_pct, body.excess_billable ? 1 : 0,
          body.rejection_pct, body.currency, body.fx_rate, price, body.price_basis,
          body.target_margin_pct, body.notes, id],
      );
      saveLines(id, body, req, order);
      if (price > 0 && can(req, 'costing.selling_price.edit')) {
        rememberRate(
          { kind: 'selling_price', buyer: order.buyer, style: order.style, uom: 'pc' } as RateContext,
          price, { orderNo: order.order_no, costSheetId: id, userId: req.principal?.userId, currency: body.currency },
        );
      }
      return one<SheetRow>('SELECT * FROM cost_sheets WHERE id = ?', [id])!;
    });

    const lines = loadLines(id);
    const result = computeCostSheet(toEngineInput(after, lines, matrixQtyMap(order.id)));
    audit(req, {
      action: 'update', entity: 'cost_sheets', entityId: id,
      summary: `Saved cost sheet v${after.version} for ${order.order_no}`,
      before: { ...before, lines: beforeLines }, after: { ...after, lines },
      severity: 'notice',
    });
    return reply.send({ sheet: after, ...redactResult(req, result, lines) });
  });

  // ------------------------------------------------------ submit / approve
  app.post('/api/costing/:id/submit', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'costing.edit');
    const id = Number((req.params as { id: string }).id);
    const before = one<SheetRow>('SELECT * FROM cost_sheets WHERE id = ?', [id]);
    if (!before) throw new HttpError(404, 'That cost sheet is gone', 'not_found');
    const order = one<OrderRow>('SELECT * FROM orders WHERE id = ?', [before.order_id])!;
    run(
      `UPDATE cost_sheets SET status = 'submitted', submitted_by = ?, submitted_at = datetime('now'),
              updated_at = datetime('now') WHERE id = ?`,
      [req.principal?.userId ?? null, id],
    );
    notify({
      roleCode: 'management', kind: 'costing_submitted', severity: 'info',
      title: `Cost sheet awaiting approval · ${order.order_no}`,
      body: `${req.principal?.fullName ?? 'Someone'} submitted v${before.version} of the cost sheet for ${order.order_no} (${order.buyer}).`,
      link: `/costing/${encodeURIComponent(order.order_no)}`,
      entity: 'cost_sheets', entityId: String(id),
      dedupeKey: `costing_submitted|${id}|${before.version}`,
    });
    audit(req, { action: 'submit', entity: 'cost_sheets', entityId: id, summary: `Submitted cost sheet for ${order.order_no}`, severity: 'notice' });
    return reply.send(one<SheetRow>('SELECT * FROM cost_sheets WHERE id = ?', [id]));
  });

  app.post('/api/costing/:id/decide', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'costing.approve');
    const id = Number((req.params as { id: string }).id);
    const before = one<SheetRow>('SELECT * FROM cost_sheets WHERE id = ?', [id]);
    if (!before) throw new HttpError(404, 'That cost sheet is gone', 'not_found');
    const body = parse(z.object({
      decision: z.enum(['approved', 'rejected', 'locked', 'draft']),
      note: zText(1000).default(''),
    }), req.body);
    const order = one<OrderRow>('SELECT * FROM orders WHERE id = ?', [before.order_id])!;

    run(
      `UPDATE cost_sheets SET status = ?, approved_by = ?, approved_at = datetime('now'),
              approval_note = ?, updated_at = datetime('now') WHERE id = ?`,
      [body.decision, req.principal?.userId ?? null, body.note, id],
    );
    if (before.submitted_by) {
      notify({
        userId: before.submitted_by, kind: 'costing_decided',
        severity: body.decision === 'rejected' ? 'warning' : 'info',
        title: `Cost sheet ${body.decision} · ${order.order_no}`,
        body: body.note || `${req.principal?.fullName ?? 'Management'} marked the sheet ${body.decision}.`,
        link: `/costing/${encodeURIComponent(order.order_no)}`,
        entity: 'cost_sheets', entityId: String(id),
        dedupeKey: `costing_decided|${id}|${body.decision}|${Date.now()}`,
      });
    }
    audit(req, {
      action: body.decision === 'rejected' ? 'reject' : 'approve',
      entity: 'cost_sheets', entityId: id,
      summary: `Cost sheet for ${order.order_no} marked ${body.decision}`,
      before, after: { status: body.decision, note: body.note }, severity: 'notice',
    });
    return reply.send(one<SheetRow>('SELECT * FROM cost_sheets WHERE id = ?', [id]));
  });

  app.post('/api/costing/:id/primary', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'costing.edit');
    const id = Number((req.params as { id: string }).id);
    const sheet = one<SheetRow>('SELECT * FROM cost_sheets WHERE id = ?', [id]);
    if (!sheet) throw new HttpError(404, 'That cost sheet is gone', 'not_found');
    tx(() => {
      run('UPDATE cost_sheets SET is_primary = 0 WHERE order_id = ?', [sheet.order_id]);
      run('UPDATE cost_sheets SET is_primary = 1 WHERE id = ?', [id]);
    });
    audit(req, { action: 'update', entity: 'cost_sheets', entityId: id, summary: `Made v${sheet.version} the live cost sheet`, severity: 'notice' });
    return reply.send({ ok: true });
  });

  // ------------------------------------------------- copy to a new version
  app.post('/api/costing/:id/duplicate', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'costing.create');
    const id = Number((req.params as { id: string }).id);
    const src = one<SheetRow>('SELECT * FROM cost_sheets WHERE id = ?', [id]);
    if (!src) throw new HttpError(404, 'That cost sheet is gone', 'not_found');
    const body = parse(z.object({ label: zText(60).default('Revised'), order_no: zText(60).optional() }), req.body ?? {});
    const target = body.order_no ? orderByNo(body.order_no) : one<OrderRow>('SELECT * FROM orders WHERE id = ?', [src.order_id])!;

    const created = tx(() => {
      const nextVersion = one<{ v: number }>(
        'SELECT COALESCE(MAX(version),0) + 1 AS v FROM cost_sheets WHERE order_id = ?', [target.id],
      )!.v;
      run('UPDATE cost_sheets SET is_primary = 0 WHERE order_id = ?', [target.id]);
      const info = run(
        `INSERT INTO cost_sheets (order_id, version, label, order_qty, excess_pct, excess_billable,
            rejection_pct, currency, fx_rate, selling_price_per_pc, price_basis, target_margin_pct,
            notes, is_primary, created_by)
         SELECT ?, ?, ?, ?, excess_pct, excess_billable, rejection_pct, currency, fx_rate,
                selling_price_per_pc, price_basis, target_margin_pct, notes, 1, ?
           FROM cost_sheets WHERE id = ?`,
        [target.id, nextVersion, body.label, target.order_qty, req.principal?.userId ?? null, id],
      );
      const newId = info.lastInsertRowid as number;

      for (const f of all<Record<string, unknown>>('SELECT * FROM cost_fabric_lines WHERE cost_sheet_id = ?', [id])) {
        const fi = run(
          `INSERT INTO cost_fabric_lines (cost_sheet_id, fabric_type, colour, part, gsm,
              consumption_g_per_pc, wastage_pct, rate_mode, flat_rate_per_kg, applies_qty_pct,
              supplier, remarks, sort_order)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [newId, f.fabric_type, f.colour, f.part, f.gsm, f.consumption_g_per_pc, f.wastage_pct,
            f.rate_mode, f.flat_rate_per_kg, f.applies_qty_pct, f.supplier, f.remarks, f.sort_order],
        );
        for (const c of all<Record<string, unknown>>('SELECT * FROM cost_fabric_components WHERE fabric_line_id = ?', [f.id as number])) {
          run(
            `INSERT INTO cost_fabric_components (fabric_line_id, component, rate_per_kg, vendor, loss_pct, remarks, sort_order)
             VALUES (?,?,?,?,?,?,?)`,
            [fi.lastInsertRowid, c.component, c.rate_per_kg, c.vendor, c.loss_pct, c.remarks, c.sort_order],
          );
        }
      }
      for (const [table, cols] of [
        ['cost_trim_lines', 'trim_item, colour, size, uom, qty_per_pc, rate_per_unit, wastage_pct, applies_qty_pct, supplier, remarks, sort_order'],
        ['cost_jobwork_lines', 'process, vendor, colour, step_no, rate_per_pc, applies_qty_pct, vendor_loss_pct, freight_per_order, remarks, sort_order'],
        ['cost_cmt_lines', 'operation, basis, rate, sam_min, efficiency_pct, applies_qty_pct, remarks, sort_order'],
        ['cost_overhead_lines', 'category, basis, amount, vendor, remarks, sort_order'],
      ] as const) {
        run(`INSERT INTO ${table} (cost_sheet_id, ${cols}) SELECT ?, ${cols} FROM ${table} WHERE cost_sheet_id = ?`, [newId, id]);
      }
      return one<SheetRow>('SELECT * FROM cost_sheets WHERE id = ?', [newId])!;
    });

    audit(req, {
      action: 'create', entity: 'cost_sheets', entityId: created.id,
      summary: `Copied cost sheet to ${target.order_no} v${created.version}`, severity: 'notice',
    });
    return reply.code(201).send(created);
  });

  app.delete('/api/costing/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'costing.delete');
    const id = Number((req.params as { id: string }).id);
    const before = one<SheetRow>('SELECT * FROM cost_sheets WHERE id = ?', [id]);
    if (!before) throw new HttpError(404, 'That cost sheet is gone', 'not_found');
    run('DELETE FROM cost_sheets WHERE id = ?', [id]);
    audit(req, { action: 'delete', entity: 'cost_sheets', entityId: id, summary: `Deleted cost sheet v${before.version}`, before, severity: 'warning' });
    return reply.send({ deleted: true });
  });

  // ---------------------------------------------------------- plan vs actual
  app.get('/api/costing/:id/actual', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'costing.view');
    if (!can(req, 'costing.total_cost.view')) throw new HttpError(403, 'You cannot see cost totals', 'forbidden');
    const id = Number((req.params as { id: string }).id);
    const sheet = one<SheetRow>('SELECT * FROM cost_sheets WHERE id = ?', [id]);
    if (!sheet) throw new HttpError(404, 'That cost sheet is gone', 'not_found');
    const order = one<OrderRow>('SELECT * FROM orders WHERE id = ?', [sheet.order_id])!;
    const lines = loadLines(id);
    const plan = computeCostSheet(toEngineInput(sheet, lines, matrixQtyMap(order.id)));
    return reply.send({ order, plan, actual: actualsFor(sheet, order) });
  });

  // --------------------------------------------------------------- quantities
  // Used by the editor to show the quantity basis live as excess is typed.
  app.get('/api/costing/quantities', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'costing.view');
    const q = parse(z.object({
      order_qty: z.coerce.number().int().min(0),
      excess_pct: z.coerce.number().min(0).max(100).default(0),
      excess_billable: z.coerce.boolean().default(true),
      rejection_pct: z.coerce.number().min(0).max(90).default(0),
    }), req.query);
    return reply.send(computeQuantities(q));
  });

  // -------------------------------------------------------------- export CSV
  app.get('/api/costing/:id/export', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'costing.export');
    const id = Number((req.params as { id: string }).id);
    const sheet = one<SheetRow>('SELECT * FROM cost_sheets WHERE id = ?', [id]);
    if (!sheet) throw new HttpError(404, 'That cost sheet is gone', 'not_found');
    const order = one<OrderRow>('SELECT * FROM orders WHERE id = ?', [sheet.order_id])!;
    const lines = loadLines(id);
    const result = computeCostSheet(toEngineInput(sheet, lines, matrixQtyMap(order.id)));

    const rows: Record<string, unknown>[] = [];
    for (const block of result.blocks) {
      if (!can(req, `costing.${block.key}.view`)) continue;
      for (const l of block.lines) {
        rows.push({
          Order: order.order_no, Buyer: order.buyer, Style: order.style,
          Block: block.label, Item: l.label, Detail: [l.sublabel, l.detail].filter(Boolean).join(' · '),
          Qty: l.qty, Unit: l.qtyUom, Rate: l.rate, RateUnit: l.rateUom,
          Total: l.total, PerGarment: l.perPc,
        });
      }
      rows.push({ Order: order.order_no, Block: block.label, Item: `${block.label} total`, Total: block.total, PerGarment: block.perPc });
    }
    if (can(req, 'costing.total_cost.view')) {
      rows.push({ Order: order.order_no, Block: 'TOTAL', Item: 'Garment cost', Total: result.totalCost, PerGarment: result.costPerPcShipped });
    }
    if (can(req, 'costing.margin.view')) {
      rows.push({ Order: order.order_no, Block: 'TOTAL', Item: 'Margin', Total: result.margin, PerGarment: result.marginPerPc });
    }
    audit(req, {
      action: 'export', entity: 'cost_sheets', entityId: id,
      summary: `Exported cost sheet for ${order.order_no}`, severity: 'notice',
    });
    return sendCsv(reply, `cost-${order.order_no}-v${sheet.version}.csv`, rows);
  });
}
