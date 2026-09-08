/**
 * The fabric plan: how much yarn to buy, worked out when the order is taken.
 *
 * This is the arithmetic a merchant does on paper the day an order lands,
 * before any cloth exists:
 *
 *     1,000 pcs × 88 g   =  88.0 kg of cloth
 *     + 10% process loss =  96.8 kg of yarn to procure
 *
 * The grammage is finished cloth per garment — from the GSM and the body
 * spec — and the excess is what disappears between the yarn going out and the
 * cloth coming back: knitting, dyeing, washing. It is not cutting loss, which
 * happens to cloth that has already arrived and is counted on the cost sheet.
 *
 * Kept apart from the costing engine on purpose. Nothing here is money, so
 * everyone who plans an order can see it, and it holds whether or not anybody
 * has built a cost sheet.
 */

export interface FabricPlanLine {
  fabric_type: string;
  colour?: string;
  part?: string;
  grammage_g_per_pc: number;
  excess_pct: number;
}

export interface PlannedFabric extends FabricPlanLine {
  /** garments this cloth has to cover */
  pieces: number;
  /** cloth in the garments, before any process loss */
  fabricKg: number;
  /** what to procure, once the process has taken its share */
  yarnKg: number;
}

export interface FabricPlanTotals {
  lines: PlannedFabric[];
  fabricKg: number;
  yarnKg: number;
}

const num = (v: unknown, dflt = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};
const r2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * @param pieces garments the cloth must cover — the order plus whatever excess
 *   ships with it, since those pieces are cut from the same rolls.
 */
export function planFabric(lines: FabricPlanLine[], pieces: number): FabricPlanTotals {
  const qty = Math.max(0, Math.round(num(pieces)));

  const planned = lines.map((l) => {
    const grammage = Math.max(0, num(l.grammage_g_per_pc));
    // A negative excess would quietly plan less yarn than cloth, which is not
    // a discount, it is a shortfall waiting to happen on the knitting floor.
    const excess = Math.max(0, num(l.excess_pct));
    const fabricKg = (qty * grammage) / 1000;
    return {
      ...l,
      pieces: qty,
      fabricKg: r2(fabricKg),
      yarnKg: r2(fabricKg * (1 + excess / 100)),
    };
  });

  return {
    lines: planned,
    fabricKg: r2(planned.reduce((s, l) => s + l.fabricKg, 0)),
    yarnKg: r2(planned.reduce((s, l) => s + l.yarnKg, 0)),
  };
}

/**
 * What the cloth actually cost you in loss, once it is in the store.
 *
 * The yarn went out; finished cloth came back. Everything that did not come
 * back went somewhere — knitting fall-out, weight lost in dyeing, a roll
 * rejected on inspection. Measuring it is how a guessed excess turns into this
 * factory's own figure for this cloth in this shade.
 */
export function measuredLoss(yarnKg: number, receivedKg: number): number | null {
  const out = num(yarnKg);
  if (out <= 0) return null;
  const back = Math.max(0, num(receivedKg));
  // Nothing received yet is not a 100% loss, it is no answer at all.
  if (back === 0) return null;
  return r2(((out - back) / out) * 100);
}


/* ------------------------------------------------- what actually came back */

export interface FabricReceipt {
  fabric_type: string;
  colour: string;
  kg: number;
}

export interface PlanVsActual {
  fabric_type: string;
  /** blank means the plan line covers every colour without one of its own */
  colour: string;
  plannedYarnKg: number;
  receivedKg: number;
  /** null until some cloth is in — no answer is not the same as no loss */
  lossPct: number | null;
  /** the excess that was planned, to compare the measured loss against */
  plannedLossPct: number;
}

/**
 * The plan against the store: yarn booked versus cloth that came back.
 *
 * This is what turns a guessed excess into this factory's own figure. The
 * comparison is drawn at fabric and colour, not per plan line, because the
 * store ledger records a receipt against a cloth and a shade and nothing
 * finer. A jersey body and a jersey collar in the same shade arrive on the
 * same roll, so splitting the loss between them would be invented precision.
 *
 * A plan line with no colour covers whatever arrives in shades that no line
 * names, so a wildcard and a specific line never count the same receipt twice.
 */
export function compareToPlan(planned: PlannedFabric[], receipts: FabricReceipt[]): PlanVsActual[] {
  const named = new Map<string, Set<string>>();
  for (const l of planned) {
    if (!l.colour) continue;
    const set = named.get(l.fabric_type) ?? new Set<string>();
    set.add(l.colour.toLowerCase());
    named.set(l.fabric_type, set);
  }

  const groups = new Map<string, PlanVsActual>();
  for (const l of planned) {
    const key = `${l.fabric_type}\u0000${l.colour ?? ''}`;
    const g = groups.get(key) ?? {
      fabric_type: l.fabric_type,
      colour: l.colour ?? '',
      plannedYarnKg: 0,
      receivedKg: 0,
      lossPct: null,
      plannedLossPct: num(l.excess_pct),
    };
    g.plannedYarnKg = r2(g.plannedYarnKg + num(l.yarnKg));
    groups.set(key, g);
  }

  for (const g of groups.values()) {
    const specific = named.get(g.fabric_type) ?? new Set<string>();
    g.receivedKg = r2(receipts
      .filter((r) => r.fabric_type === g.fabric_type
        && (g.colour
          ? r.colour.toLowerCase() === g.colour.toLowerCase()
          : !specific.has((r.colour ?? '').toLowerCase())))
      .reduce((s, r) => s + num(r.kg), 0));
    g.lossPct = measuredLoss(g.plannedYarnKg, g.receivedKg);
  }

  return [...groups.values()];
}
