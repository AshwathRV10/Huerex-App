import { all } from '../db/index.js';
import { wipForAll, type OrderWip } from './facts.js';

/**
 * Set control.
 *
 * Some styles ship as a pair — a top and a bottom — and a carton is only a
 * carton when both halves are in it. Making 500 tops and 420 bottoms means
 * you have 420 sets and 80 tops nobody ordered on their own.
 *
 * Nothing is typed here. The pairing is declared once on the order (same Set
 * Group, one Primary and one Secondary) and this reads the rest from what the
 * floor has actually logged, colour by colour and size by size, because a
 * pairing that balances in total can still be 40 short in one size.
 */

export interface SetLeg {
  order_no: string;
  role: string;
  cut: number;
  good: number;
  packed: number;
  shipped: number;
}

export interface SetRow {
  set_group: string;
  colour: string;
  size: string;
  set_qty: number;
  legs: SetLeg[];
  sets_makeable: number;
  sets_packed: number;
  sets_shipped: number;
  /** how far apart the halves are — the number that costs money */
  leg_gap: number;
  status: string;
  config_error: string;
}

export interface SetSummary {
  rows: SetRow[];
  groups: number;
  misconfigured: string[];
  worst_gap: number;
}

function cellsOf(w: OrderWip): Map<string, { cut: number; good: number; packed: number; shipped: number }> {
  const m = new Map<string, { cut: number; good: number; packed: number; shipped: number }>();
  for (const c of w.cells) {
    m.set(`${c.colour}|${c.size}`, { cut: c.cum_cut, good: c.good, packed: c.packed, shipped: c.shipped });
  }
  return m;
}

export function setControl(): SetSummary {
  const groups = all<{ set_group: string }>(
    `SELECT DISTINCT set_group FROM orders WHERE set_group <> '' ORDER BY set_group`,
  ).map((r) => r.set_group);

  if (groups.length === 0) {
    return { rows: [], groups: 0, misconfigured: [], worst_gap: 0 };
  }

  const wips = wipForAll(false);
  const rows: SetRow[] = [];
  const misconfigured: string[] = [];
  let worstGap = 0;

  for (const group of groups) {
    const members = wips.filter((w) => w.order.set_group === group);

    let configError = '';
    if (members.length < 2) configError = 'only one order is in this set group';
    else if (!members.some((m) => m.order.set_role === 'Primary')) configError = 'no order is marked Primary';
    else if (!members.some((m) => m.order.set_role === 'Secondary')) configError = 'no order is marked Secondary';
    if (configError) misconfigured.push(`${group} — ${configError}`);

    const byOrder = members.map((m) => ({ w: m, cells: cellsOf(m) }));

    // Every colour and size that appears on any half of the set.
    const keys = new Set<string>();
    for (const m of byOrder) for (const k of m.cells.keys()) keys.add(k);

    for (const key of [...keys].sort()) {
      const [colour, size] = key.split('|');
      const legs: SetLeg[] = byOrder.map((m) => {
        const c = m.cells.get(key) ?? { cut: 0, good: 0, packed: 0, shipped: 0 };
        return {
          order_no: m.w.order.order_no,
          role: m.w.order.set_role || '—',
          ...c,
        };
      });

      // A set is limited by its scarcest half, at every stage.
      const makeable = Math.min(...legs.map((l) => l.good));
      const packed = Math.min(...legs.map((l) => l.packed));
      const shipped = Math.min(...legs.map((l) => l.shipped));
      const gap = Math.max(...legs.map((l) => l.good)) - makeable;
      if (gap > worstGap) worstGap = gap;

      const setQty = Math.min(...legs.map((l) => {
        const cell = l.order_no;
        const w = byOrder.find((m) => m.w.order.order_no === cell)!.w;
        const matrix = w.cells.find((c) => `${c.colour}|${c.size}` === key);
        return matrix?.order_qty ?? 0;
      }));

      rows.push({
        set_group: group,
        colour,
        size,
        set_qty: setQty,
        legs,
        sets_makeable: makeable,
        sets_packed: packed,
        sets_shipped: shipped,
        leg_gap: gap,
        status: configError ? 'Not paired properly'
          : gap > 0 ? 'Halves out of step'
            : shipped >= setQty && setQty > 0 ? 'Complete'
              : makeable > 0 ? 'In step' : 'Nothing good yet',
        config_error: configError,
      });
    }
  }

  return { rows, groups: groups.length, misconfigured, worst_gap: worstGap };
}
