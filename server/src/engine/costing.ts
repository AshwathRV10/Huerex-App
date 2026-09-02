/**
 * The costing engine.
 *
 * Everything here is a pure function of its input so it can be unit-tested and
 * re-run against actuals without touching the database.
 *
 * ---------------------------------------------------------------------------
 * The quantity model
 * ---------------------------------------------------------------------------
 * Excess is not free goods sitting in a corner — it ships in the same cartons
 * as the order, and how much of it there is depends on the buyer. Rejection is
 * different again: those pieces are made and paid for but never leave.
 *
 *   excess_qty     = round(order_qty × excess_pct)
 *   ship_qty       = order_qty + excess_qty            ← what physically leaves
 *   billable_qty   = order_qty + excess_qty when the buyer pays for excess,
 *                    otherwise just order_qty          ← what earns money
 *   production_qty = ship_qty ÷ (1 − rejection_pct)    ← what the floor makes
 *
 * Material and CMT are charged on production_qty. Revenue is earned on
 * billable_qty. Cost per garment is quoted against ship_qty, because that is
 * the number of garments the buyer actually receives.
 */

export type CostBasis = 'per_pc' | 'per_order' | 'per_sam_min' | 'pct_of_cost';
export type OverheadBasis = 'per_pc' | 'per_order' | 'pct_of_cost' | 'pct_of_revenue';

export interface FabricComponentInput {
  id?: number;
  component: string;
  rate_per_kg: number;
  vendor?: string;
  loss_pct?: number;
  remarks?: string;
}

export interface FabricLineInput {
  id?: number;
  fabric_type: string;
  colour?: string;
  part?: string;
  gsm?: number;
  consumption_g_per_pc: number;
  wastage_pct?: number;
  rate_mode?: 'buildup' | 'flat';
  flat_rate_per_kg?: number;
  applies_qty_pct?: number;
  supplier?: string;
  remarks?: string;
  components?: FabricComponentInput[];
}

export interface TrimLineInput {
  id?: number;
  trim_item: string;
  colour?: string;
  size?: string;
  uom?: string;
  qty_per_pc: number;
  rate_per_unit: number;
  wastage_pct?: number;
  applies_qty_pct?: number;
  supplier?: string;
  remarks?: string;
}

export interface JobWorkLineInput {
  id?: number;
  process: string;
  vendor?: string;
  colour?: string;
  step_no?: number | null;
  rate_per_pc: number;
  applies_qty_pct?: number;
  vendor_loss_pct?: number;
  freight_per_order?: number;
  remarks?: string;
}

export interface CmtLineInput {
  id?: number;
  operation: string;
  basis: CostBasis;
  rate: number;
  sam_min?: number;
  efficiency_pct?: number;
  applies_qty_pct?: number;
  remarks?: string;
}

export interface OverheadLineInput {
  id?: number;
  category: string;
  basis: OverheadBasis;
  amount: number;
  vendor?: string;
  remarks?: string;
}

export interface CostSheetInput {
  order_qty: number;
  excess_pct: number;
  excess_billable: boolean;
  rejection_pct: number;
  currency: string;
  /** 1 unit of `currency` = fx_rate INR. INR sheets use 1. */
  fx_rate: number;
  selling_price_per_pc: number;
  target_margin_pct?: number;
  fabric: FabricLineInput[];
  trims: TrimLineInput[];
  jobwork: JobWorkLineInput[];
  cmt: CmtLineInput[];
  overheads: OverheadLineInput[];
  /** Optional per colour/size prices; when present they outweigh the flat price. */
  priceOverrides?: { colour: string; size: string; price_per_pc: number; qty: number }[];
}

export interface LineResult {
  id?: number;
  label: string;
  sublabel: string;
  detail: string;
  qty: number;
  qtyUom: string;
  rate: number;
  rateUom: string;
  total: number;
  perPc: number;
}

export interface BlockResult {
  key: 'fabric' | 'trims' | 'jobwork' | 'cmt' | 'overheads';
  label: string;
  lines: LineResult[];
  total: number;
  perPc: number;
  pctOfCost: number;
}

export interface Quantities {
  orderQty: number;
  excessPct: number;
  excessQty: number;
  shipQty: number;
  billableQty: number;
  rejectionPct: number;
  rejectionQty: number;
  productionQty: number;
}

export interface CostResult {
  quantities: Quantities;
  blocks: BlockResult[];
  /** Materials = fabric + trims. */
  materialTotal: number;
  conversionTotal: number;   // jobwork + cmt
  overheadTotal: number;
  totalCost: number;         // INR
  costPerPcShipped: number;  // INR — cost of one garment the buyer receives
  costPerPcProduced: number; // INR — cost of one garment the floor makes
  revenue: number;           // INR
  revenuePerPc: number;      // INR, per billable piece
  sellingPricePerPc: number; // in sheet currency
  margin: number;            // INR
  marginPerPc: number;
  marginPct: number;         // of revenue
  markupPct: number;         // of cost
  breakEvenPricePerPc: number;      // INR, price at which margin = 0
  targetPricePerPc: number;         // INR, price that hits target_margin_pct
  currency: string;
  fxRate: number;
  warnings: string[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const num = (v: unknown, dflt = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};
const pct = (v: unknown, dflt = 0): number => num(v, dflt) / 100;

export function computeQuantities(input: Pick<CostSheetInput, 'order_qty' | 'excess_pct' | 'excess_billable' | 'rejection_pct'>): Quantities {
  const orderQty = Math.max(0, Math.round(num(input.order_qty)));
  const excessPct = Math.max(0, num(input.excess_pct));
  const excessQty = Math.round(orderQty * (excessPct / 100));
  const shipQty = orderQty + excessQty;
  const billableQty = input.excess_billable ? shipQty : orderQty;

  const rejectionPct = Math.min(Math.max(0, num(input.rejection_pct)), 90);
  const productionQty = rejectionPct > 0 ? Math.ceil(shipQty / (1 - rejectionPct / 100)) : shipQty;
  const rejectionQty = productionQty - shipQty;

  return { orderQty, excessPct, excessQty, shipQty, billableQty, rejectionPct, rejectionQty, productionQty };
}

/**
 * Rate per finished kilogram from the build-up. A stage that loses material
 * costs more per surviving kilogram, so its rate is grossed up by its own
 * loss — 10% loss on a ₹90 dyeing charge is ₹100 per good kg, not ₹99.
 */
export function fabricRatePerKg(line: FabricLineInput): { rate: number; parts: { component: string; rate: number }[] } {
  if ((line.rate_mode ?? 'buildup') === 'flat') {
    return { rate: num(line.flat_rate_per_kg), parts: [{ component: 'Flat rate', rate: num(line.flat_rate_per_kg) }] };
  }
  const parts = (line.components ?? []).map((c) => {
    const loss = Math.min(Math.max(0, num(c.loss_pct)), 95) / 100;
    return { component: c.component, rate: r4(num(c.rate_per_kg) / (1 - loss)) };
  });
  return { rate: r4(parts.reduce((s, p) => s + p.rate, 0)), parts };
}

export function computeCostSheet(input: CostSheetInput): CostResult {
  const warnings: string[] = [];
  const q = computeQuantities(input);
  const fx = num(input.fx_rate, 1) || 1;

  // ------------------------------------------------------------ fabric
  const fabricLines: LineResult[] = (input.fabric ?? []).map((line) => {
    const share = num(line.applies_qty_pct, 100) / 100;
    const lineQty = q.productionQty * share;
    const grossGPerPc = num(line.consumption_g_per_pc) * (1 + pct(line.wastage_pct));
    const kg = (grossGPerPc * lineQty) / 1000;
    const { rate, parts } = fabricRatePerKg(line);
    const total = kg * rate;
    if (num(line.consumption_g_per_pc) <= 0) {
      warnings.push(`Fabric "${line.fabric_type}${line.colour ? ` · ${line.colour}` : ''}" has no consumption — it adds nothing to the cost.`);
    }
    if (rate <= 0) {
      warnings.push(`Fabric "${line.fabric_type}${line.colour ? ` · ${line.colour}` : ''}" has no rate.`);
    }
    return {
      id: line.id,
      label: line.fabric_type,
      sublabel: [line.colour, line.part && line.part !== 'Body' ? line.part : ''].filter(Boolean).join(' · '),
      detail: parts.length
        ? parts.map((p) => `${p.component} ₹${r2(p.rate)}`).join(' + ')
        : '',
      qty: r2(kg),
      qtyUom: 'kg',
      rate: r2(rate),
      rateUom: '₹/kg',
      total: r2(total),
      perPc: q.shipQty ? r4(total / q.shipQty) : 0,
    };
  });

  // ------------------------------------------------------------- trims
  const trimLines: LineResult[] = (input.trims ?? []).map((line) => {
    const share = num(line.applies_qty_pct, 100) / 100;
    const perPcQty = num(line.qty_per_pc) * (1 + pct(line.wastage_pct));
    const units = perPcQty * q.productionQty * share;
    const total = units * num(line.rate_per_unit);
    return {
      id: line.id,
      label: line.trim_item,
      sublabel: [line.colour, line.size].filter(Boolean).join(' · '),
      detail: `${r4(perPcQty)} ${line.uom ?? 'pcs'}/garment`,
      qty: r2(units),
      qtyUom: line.uom ?? 'pcs',
      rate: r4(num(line.rate_per_unit)),
      rateUom: `₹/${line.uom ?? 'pc'}`,
      total: r2(total),
      perPc: q.shipQty ? r4(total / q.shipQty) : 0,
    };
  });

  // ---------------------------------------------------------- job work
  const jobworkLines: LineResult[] = (input.jobwork ?? []).map((line) => {
    const share = num(line.applies_qty_pct, 100) / 100;
    const loss = Math.min(Math.max(0, num(line.vendor_loss_pct)), 90) / 100;
    // A vendor is billed for whole garments, so the loss allowance rounds up.
    const pieces = Math.ceil((q.productionQty * share) / (1 - loss));
    const total = pieces * num(line.rate_per_pc) + num(line.freight_per_order);
    return {
      id: line.id,
      label: line.process,
      sublabel: [line.vendor, line.colour].filter(Boolean).join(' · '),
      detail: [
        share !== 1 ? `${r2(share * 100)}% of pieces` : '',
        loss ? `${r2(loss * 100)}% vendor loss` : '',
        num(line.freight_per_order) ? `freight ₹${r2(num(line.freight_per_order))}` : '',
      ].filter(Boolean).join(' · '),
      qty: pieces,
      qtyUom: 'pcs',
      rate: r4(num(line.rate_per_pc)),
      rateUom: '₹/pc',
      total: r2(total),
      perPc: q.shipQty ? r4(total / q.shipQty) : 0,
    };
  });

  // --------------------------------------------------------------- CMT
  // pct_of_cost lines are held back to a second pass, because they need the
  // rest of the sheet before they can be worked out.
  const cmtDirect: LineResult[] = [];
  const cmtPercent: CmtLineInput[] = [];
  for (const line of input.cmt ?? []) {
    if (line.basis === 'pct_of_cost') { cmtPercent.push(line); continue; }
    const share = num(line.applies_qty_pct, 100) / 100;
    const qty = q.productionQty * share;
    let total = 0;
    let detail = '';
    let rate = num(line.rate);
    let rateUom = '₹/pc';
    if (line.basis === 'per_pc') {
      total = qty * rate;
    } else if (line.basis === 'per_order') {
      total = rate;
      rateUom = '₹/order';
      detail = 'lump sum for the order';
    } else {
      // per_sam_min: a minute at 65% efficiency costs 1/0.65 of a standard minute
      const eff = Math.min(Math.max(num(line.efficiency_pct, 100), 1), 200) / 100;
      const minutes = (num(line.sam_min) / eff) * qty;
      total = minutes * rate;
      rateUom = '₹/min';
      detail = `${r2(num(line.sam_min))} SAM ÷ ${r2(eff * 100)}% efficiency = ${r4(num(line.sam_min) / eff)} min/pc`;
      rate = r4(rate);
    }
    cmtDirect.push({
      id: line.id,
      label: line.operation,
      sublabel: line.basis === 'per_sam_min' ? 'SAM based' : line.basis === 'per_order' ? 'per order' : 'per piece',
      detail,
      qty: line.basis === 'per_order' ? 1 : Math.round(qty),
      qtyUom: line.basis === 'per_order' ? 'order' : 'pcs',
      rate,
      rateUom,
      total: r2(total),
      perPc: q.shipQty ? r4(total / q.shipQty) : 0,
    });
  }

  const fabricTotal = fabricLines.reduce((s, l) => s + l.total, 0);
  const trimTotal = trimLines.reduce((s, l) => s + l.total, 0);
  const jobworkTotal = jobworkLines.reduce((s, l) => s + l.total, 0);
  const cmtDirectTotal = cmtDirect.reduce((s, l) => s + l.total, 0);
  const baseForPct = fabricTotal + trimTotal + jobworkTotal + cmtDirectTotal;

  const cmtLines = [...cmtDirect];
  for (const line of cmtPercent) {
    const total = baseForPct * (num(line.rate) / 100);
    cmtLines.push({
      id: line.id,
      label: line.operation,
      sublabel: '% of cost',
      detail: `${r2(num(line.rate))}% of ₹${r2(baseForPct)}`,
      qty: 1,
      qtyUom: 'order',
      rate: r2(num(line.rate)),
      rateUom: '%',
      total: r2(total),
      perPc: q.shipQty ? r4(total / q.shipQty) : 0,
    });
  }
  const cmtTotal = cmtLines.reduce((s, l) => s + l.total, 0);

  // --------------------------------------------------------- revenue
  const priceInr = num(input.selling_price_per_pc) * fx;
  let revenue: number;
  if (input.priceOverrides?.length) {
    // Weighted by the matrix, so a size-graded price list values correctly.
    const totalQty = input.priceOverrides.reduce((s, p) => s + num(p.qty), 0);
    const weighted = input.priceOverrides.reduce((s, p) => s + num(p.qty) * num(p.price_per_pc) * fx, 0);
    const covered = totalQty;
    const uncovered = Math.max(0, q.billableQty - covered);
    revenue = weighted + uncovered * priceInr;
  } else {
    revenue = q.billableQty * priceInr;
  }

  // ------------------------------------------------------- overheads
  const preOverheadCost = fabricTotal + trimTotal + jobworkTotal + cmtTotal;
  const overheadLines: LineResult[] = (input.overheads ?? []).map((line) => {
    const amt = num(line.amount);
    let total = 0;
    let detail = '';
    let rateUom = '₹';
    if (line.basis === 'per_pc') { total = amt * q.productionQty; rateUom = '₹/pc'; }
    else if (line.basis === 'per_order') { total = amt; rateUom = '₹/order'; detail = 'lump sum for the order'; }
    else if (line.basis === 'pct_of_cost') { total = preOverheadCost * (amt / 100); rateUom = '%'; detail = `${r2(amt)}% of ₹${r2(preOverheadCost)}`; }
    else { total = revenue * (amt / 100); rateUom = '%'; detail = `${r2(amt)}% of ₹${r2(revenue)} revenue`; }
    return {
      id: line.id,
      label: line.category,
      sublabel: line.vendor ?? '',
      detail,
      qty: line.basis === 'per_pc' ? q.productionQty : 1,
      qtyUom: line.basis === 'per_pc' ? 'pcs' : 'order',
      rate: r4(amt),
      rateUom,
      total: r2(total),
      perPc: q.shipQty ? r4(total / q.shipQty) : 0,
    };
  });
  const overheadTotal = overheadLines.reduce((s, l) => s + l.total, 0);

  const totalCost = r2(fabricTotal + trimTotal + jobworkTotal + cmtTotal + overheadTotal);
  const pctOf = (v: number) => (totalCost ? r2((v / totalCost) * 100) : 0);

  const blocks: BlockResult[] = [
    { key: 'fabric', label: 'Fabric', lines: fabricLines, total: r2(fabricTotal), perPc: q.shipQty ? r4(fabricTotal / q.shipQty) : 0, pctOfCost: pctOf(fabricTotal) },
    { key: 'trims', label: 'Trims', lines: trimLines, total: r2(trimTotal), perPc: q.shipQty ? r4(trimTotal / q.shipQty) : 0, pctOfCost: pctOf(trimTotal) },
    { key: 'jobwork', label: 'Job Work', lines: jobworkLines, total: r2(jobworkTotal), perPc: q.shipQty ? r4(jobworkTotal / q.shipQty) : 0, pctOfCost: pctOf(jobworkTotal) },
    { key: 'cmt', label: 'CMT', lines: cmtLines, total: r2(cmtTotal), perPc: q.shipQty ? r4(cmtTotal / q.shipQty) : 0, pctOfCost: pctOf(cmtTotal) },
    { key: 'overheads', label: 'Other Costs', lines: overheadLines, total: r2(overheadTotal), perPc: q.shipQty ? r4(overheadTotal / q.shipQty) : 0, pctOfCost: pctOf(overheadTotal) },
  ];

  const margin = r2(revenue - totalCost);
  const marginPct = revenue ? r2((margin / revenue) * 100) : 0;
  const markupPct = totalCost ? r2((margin / totalCost) * 100) : 0;
  const breakEven = q.billableQty ? r2(totalCost / q.billableQty) : 0;

  // Price that would hit the target margin, given the same cost base. A margin
  // target of 100% or more is unreachable, so it is reported as zero.
  const target = num(input.target_margin_pct);
  const targetPrice = q.billableQty && target < 100
    ? r2(totalCost / q.billableQty / (1 - target / 100))
    : 0;

  if (q.orderQty === 0) warnings.push('Order quantity is zero — every per-piece figure will be zero.');
  if (priceInr <= 0 && !input.priceOverrides?.length) warnings.push('No selling price entered, so margin cannot be judged.');
  if (margin < 0 && revenue > 0) warnings.push(`This order loses ₹${r2(Math.abs(margin))} at the quoted price.`);
  if (!input.excess_billable && q.excessQty > 0) {
    warnings.push(`${q.excessQty} excess pieces are shipped free — that is ₹${r2((totalCost / (q.productionQty || 1)) * q.excessQty)} of cost with no revenue against it.`);
  }

  return {
    quantities: q,
    blocks,
    materialTotal: r2(fabricTotal + trimTotal),
    conversionTotal: r2(jobworkTotal + cmtTotal),
    overheadTotal: r2(overheadTotal),
    totalCost,
    costPerPcShipped: q.shipQty ? r4(totalCost / q.shipQty) : 0,
    costPerPcProduced: q.productionQty ? r4(totalCost / q.productionQty) : 0,
    revenue: r2(revenue),
    revenuePerPc: q.billableQty ? r4(revenue / q.billableQty) : 0,
    sellingPricePerPc: r4(num(input.selling_price_per_pc)),
    margin,
    marginPerPc: q.billableQty ? r4(margin / q.billableQty) : 0,
    marginPct,
    markupPct,
    breakEvenPricePerPc: breakEven,
    targetPricePerPc: targetPrice,
    currency: input.currency ?? 'INR',
    fxRate: fx,
    warnings,
  };
}
