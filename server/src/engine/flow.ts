/**
 * Route-driven WIP.
 *
 * Every order travels its own sequence. Fusing may come after sewing, a print
 * may happen twice, an order may skip inspection entirely. So no bucket can be
 * hard-coded to a column: each one is worked out by walking that order's route
 * and asking, at every step, "how many pieces have got this far, and how many
 * are stuck in front of it?"
 *
 * The identity that must never break:
 *     Cum Cut = Shipped + Rejected + WIP
 * TOTAL WIP is *defined* as cut − shipped − rejected, and the buckets are
 * checked against it. When the two disagree the difference is reported rather
 * than hidden, because it means an entry is wrong.
 */

export const OUTSOURCEABLE = ['Print', 'Embroidery', 'Wash', 'Tie&Dye', 'Rotary AOP', 'Other'] as const;
export const IN_HOUSE_STEPS = ['Cutting', 'Fusing', 'Sewing', 'Checking', 'Packing', 'Inspection', 'Shipment'] as const;

export type Process = string;

export interface RouteStep { step_no: number; process: Process; type: 'In-house' | 'Outsourced' }

export interface CellKey { colour: string; size: string }

export interface CellFacts {
  colour: string;
  size: string;
  order_qty: number;
  cum_cut: number;
  cum_fused: number;
  /** keyed `${process}|${step_no ?? ''}` then plain `${process}` as a fallback */
  jw_out: Record<string, number>;
  jw_in: Record<string, number>;
  sewn_exact: number;
  issued_exact: number;
  checked: number;
  pass: number;
  alter: number;
  reject: number;
  rechecked: number;
  packed: number;
  shipped: number;
  last_movement?: string | null;
}

export interface OrderFacts {
  order_qty: number;
  buffer_pct: number;
  excess_pct: number;
  route: RouteStep[];
  /** sewing output logged without a colour/size, to be spread pro-rata */
  sewn_pool: number;
  issued_pool: number;
  cells: CellFacts[];
}

export interface StepState {
  step_no: number;
  process: Process;
  type: 'In-house' | 'Outsourced';
  /** pieces that have finished this step */
  done: number;
  /** pieces waiting to start it */
  waiting: number;
  /** pieces inside it right now (at a vendor, on the line, in rework) */
  inside: number;
}

export interface CellWip {
  colour: string;
  size: string;
  order_qty: number;
  planned_cut: number;
  cum_cut: number;
  bal_to_cut: number;
  awaiting_fusing: number;
  awaiting_jobwork: number;
  at_jobwork_vendor: number;
  ready_for_sewing: number;
  in_sewing: number;
  awaiting_checking: number;
  in_rework: number;
  awaiting_packing: number;
  packed_not_shipped: number;
  rejected: number;
  shipped: number;
  packed: number;
  good: number;
  total_wip: number;
  bucket_sum: number;
  /** non-zero means an entry contradicts another entry */
  imbalance: number;
  where_now: string;
  next_step: string;
  last_movement: string | null;
  ageing_days: number | null;
  flag: '' | 'AGED' | 'STALLED' | 'OVER-CUT' | 'SHORT';
  steps: StepState[];
}

const clamp = (n: number) => (n > 0 ? n : 0);
const r0 = (n: number) => Math.round(n);

export function plannedCut(orderQty: number, excessPct: number, bufferPct: number): number {
  // Excess ships to the buyer, the buffer covers loss on the way. Both are cut.
  return Math.ceil(orderQty * (1 + (excessPct || 0) / 100) * (1 + (bufferPct || 0)));
}

function stepKeys(process: string, stepNo: number): string[] {
  return [`${process}|${stepNo}`, `${process}|`, process];
}

function lookup(map: Record<string, number>, process: string, stepNo: number): number {
  for (const k of stepKeys(process, stepNo)) {
    if (map[k] !== undefined) return map[k];
  }
  return 0;
}

/**
 * Spread order-level sewing output across the cells that could have produced
 * it, weighted by how much each still has left to sew.
 *
 * A cell that logged its own colour and size keeps those pieces in full; what
 * it is weighted by here is only the capacity it has left. So a size with 60
 * cut and 55 already logged competes for the un-attributed pool with 5 pieces
 * of room, not 60 — which is what stops attributed output being counted twice
 * and stops the pool piling onto the sizes nobody happened to write down.
 */
function allocate(pool: number, weights: number[]): number[] {
  const total = weights.reduce((s, w) => s + clamp(w), 0);
  if (pool <= 0 || total <= 0) return weights.map(() => 0);
  const capped = Math.min(pool, total);
  const raw = weights.map((w) => (clamp(w) / total) * capped);
  // largest-remainder rounding so the parts add back up to the whole
  const floors = raw.map(Math.floor);
  let left = Math.round(capped) - floors.reduce((s, n) => s + n, 0);
  const order = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i] += 1;
    left -= 1;
  }
  return floors;
}

export function computeOrderWip(facts: OrderFacts): CellWip[] {
  const route = [...facts.route].sort((a, b) => a.step_no - b.step_no);
  const sewIndex = route.findIndex((s) => s.process === 'Sewing');

  // ---- pass 1: how much is available to sew in each cell, for allocation ---
  const availableToSew: number[] = facts.cells.map((cell) => {
    if (sewIndex <= 0) return clamp(cell.cum_cut - cell.sewn_exact);
    let done = 0;
    for (let i = 0; i < sewIndex; i += 1) {
      const s = route[i];
      done = i === 0
        ? cell.cum_cut
        : stepDone(s, cell, done, 0, 0).done;
    }
    return clamp(done - cell.sewn_exact);
  });

  const sewnShare = allocate(facts.sewn_pool, availableToSew);
  const issuedShare = allocate(facts.issued_pool, availableToSew);

  // ---------------------------- pass 2: walk the route for every cell ------
  return facts.cells.map((cell, idx) => {
    const sewn = cell.sewn_exact + (sewnShare[idx] ?? 0);
    const issued = Math.max(cell.issued_exact + (issuedShare[idx] ?? 0), sewn);

    const steps: StepState[] = [];
    const buckets = {
      awaiting_fusing: 0,
      awaiting_jobwork: 0,
      at_jobwork_vendor: 0,
      ready_for_sewing: 0,
      in_sewing: 0,
      awaiting_checking: 0,
      in_rework: 0,
      awaiting_packing: 0,
      packed_not_shipped: 0,
    };

    let prevDone = 0;
    for (let i = 0; i < route.length; i += 1) {
      const s = route[i];
      const res = stepDone(s, cell, prevDone, sewn, issued);
      steps.push({ step_no: s.step_no, process: s.process, type: s.type, done: res.done, waiting: res.waiting, inside: res.inside });

      switch (s.process) {
        case 'Cutting': break;
        case 'Fusing': buckets.awaiting_fusing += res.waiting; break;
        case 'Sewing':
          buckets.ready_for_sewing += res.waiting;
          buckets.in_sewing += res.inside;
          break;
        case 'Checking':
          buckets.awaiting_checking += res.waiting;
          buckets.in_rework += res.inside;
          break;
        case 'Packing': buckets.awaiting_packing += res.waiting; break;
        case 'Inspection': break;
        case 'Shipment': buckets.packed_not_shipped += res.waiting; break;
        default:
          buckets.awaiting_jobwork += res.waiting;
          buckets.at_jobwork_vendor += res.inside;
      }
      prevDone = res.done;
    }

    const rejected = cell.reject;
    const shipped = cell.shipped;
    const good = clamp(cell.pass + cell.rechecked);
    const totalWip = clamp(cell.cum_cut - shipped - rejected);
    const bucketSum = Object.values(buckets).reduce((s, n) => s + n, 0);

    const planned = plannedCut(cell.order_qty, facts.excess_pct, facts.buffer_pct);
    const ageing = cell.last_movement
      ? Math.floor((Date.now() - new Date(`${cell.last_movement}T00:00:00Z`).getTime()) / 86_400_000)
      : null;

    // Where it is now = the first step in the route with pieces stacked in
    // front of it or sitting inside it.
    let whereNow = '';
    let nextStep = '';
    for (let i = 0; i < steps.length; i += 1) {
      const st = steps[i];
      if (st.waiting > 0) { whereNow = `Awaiting ${st.process}`; nextStep = st.process; break; }
      if (st.inside > 0) {
        whereNow = st.type === 'Outsourced' ? `At vendor · ${st.process}` : `In ${st.process}`;
        nextStep = steps[i + 1]?.process ?? 'Done';
        break;
      }
    }
    if (!whereNow) {
      whereNow = clamp(planned - cell.cum_cut) > 0 ? 'Not cut yet'
        : totalWip === 0 ? 'Complete' : 'On floor';
      nextStep = clamp(planned - cell.cum_cut) > 0 ? 'Cutting' : (totalWip === 0 ? '—' : 'Check entries');
    }

    let flag: CellWip['flag'] = '';
    if (cell.cum_cut > planned) flag = 'OVER-CUT';
    else if (totalWip > 0 && ageing !== null && ageing >= 14) flag = 'AGED';
    else if (totalWip > 0 && ageing !== null && ageing >= 7) flag = 'STALLED';
    else if (cell.cum_cut < planned && cell.cum_cut > 0 && clamp(planned - cell.cum_cut) > 0) flag = 'SHORT';

    return {
      colour: cell.colour,
      size: cell.size,
      order_qty: cell.order_qty,
      planned_cut: planned,
      cum_cut: cell.cum_cut,
      bal_to_cut: clamp(planned - cell.cum_cut),
      ...buckets,
      rejected,
      shipped,
      packed: cell.packed,
      good,
      total_wip: totalWip,
      bucket_sum: r0(bucketSum),
      imbalance: r0(bucketSum - totalWip),
      where_now: whereNow,
      next_step: nextStep,
      last_movement: cell.last_movement ?? null,
      ageing_days: ageing,
      flag,
      steps,
    };
  });
}

interface StepResult { done: number; waiting: number; inside: number }

function stepDone(s: RouteStep, cell: CellFacts, prevDone: number, sewn: number, issued: number): StepResult {
  switch (s.process) {
    case 'Cutting':
      return { done: cell.cum_cut, waiting: 0, inside: 0 };

    case 'Fusing': {
      const done = Math.min(cell.cum_fused, prevDone);
      return { done, waiting: clamp(prevDone - cell.cum_fused), inside: 0 };
    }

    case 'Sewing': {
      const done = Math.min(sewn, prevDone);
      const inLine = clamp(Math.min(issued, prevDone) - done);
      return { done, waiting: clamp(prevDone - Math.max(issued, done)), inside: inLine };
    }

    case 'Checking': {
      const good = clamp(cell.pass + cell.rechecked);
      const done = Math.min(good, prevDone);
      const rework = clamp(cell.alter - cell.rechecked);
      const waiting = clamp(prevDone - cell.checked);
      return { done, waiting, inside: rework };
    }

    case 'Packing': {
      const done = Math.min(cell.packed, prevDone);
      return { done, waiting: clamp(prevDone - cell.packed), inside: 0 };
    }

    case 'Inspection':
      // Inspection is a gate, not a holding point: it does not consume pieces.
      return { done: prevDone, waiting: 0, inside: 0 };

    case 'Shipment': {
      const done = Math.min(cell.shipped, prevDone);
      return { done, waiting: clamp(prevDone - cell.shipped), inside: 0 };
    }

    default: {
      // Any outsourced process, including one that appears twice in the route.
      const out = lookup(cell.jw_out, s.process, s.step_no);
      const back = lookup(cell.jw_in, s.process, s.step_no);
      const done = Math.min(back, prevDone);
      return { done, waiting: clamp(prevDone - out), inside: clamp(out - back) };
    }
  }
}

export interface OrderWipTotals {
  planned_cut: number; cum_cut: number; bal_to_cut: number;
  awaiting_fusing: number; awaiting_jobwork: number; at_jobwork_vendor: number;
  ready_for_sewing: number; in_sewing: number; awaiting_checking: number;
  in_rework: number; awaiting_packing: number; packed_not_shipped: number;
  rejected: number; shipped: number; packed: number; good: number;
  total_wip: number; imbalance: number; oldest_movement: string | null; max_ageing: number;
}

export function totalsFor(cells: CellWip[]): OrderWipTotals {
  const t: OrderWipTotals = {
    planned_cut: 0, cum_cut: 0, bal_to_cut: 0, awaiting_fusing: 0, awaiting_jobwork: 0,
    at_jobwork_vendor: 0, ready_for_sewing: 0, in_sewing: 0, awaiting_checking: 0,
    in_rework: 0, awaiting_packing: 0, packed_not_shipped: 0, rejected: 0, shipped: 0,
    packed: 0, good: 0, total_wip: 0, imbalance: 0, oldest_movement: null, max_ageing: 0,
  };
  for (const c of cells) {
    t.planned_cut += c.planned_cut; t.cum_cut += c.cum_cut; t.bal_to_cut += c.bal_to_cut;
    t.awaiting_fusing += c.awaiting_fusing; t.awaiting_jobwork += c.awaiting_jobwork;
    t.at_jobwork_vendor += c.at_jobwork_vendor; t.ready_for_sewing += c.ready_for_sewing;
    t.in_sewing += c.in_sewing; t.awaiting_checking += c.awaiting_checking;
    t.in_rework += c.in_rework; t.awaiting_packing += c.awaiting_packing;
    t.packed_not_shipped += c.packed_not_shipped; t.rejected += c.rejected;
    t.shipped += c.shipped; t.packed += c.packed; t.good += c.good;
    t.total_wip += c.total_wip; t.imbalance += c.imbalance;
    if (c.total_wip > 0 && c.ageing_days !== null && c.ageing_days > t.max_ageing) t.max_ageing = c.ageing_days;
    if (c.last_movement && (!t.oldest_movement || c.last_movement < t.oldest_movement)) t.oldest_movement = c.last_movement;
  }
  return t;
}
