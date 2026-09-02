/**
 * The alerts engine.
 *
 * Each rule answers one question: what is going wrong, how badly, how many
 * pieces it affects, whose job it is, and what to do about it. An alert that
 * management has accepted is suppressed, never deleted — the count of
 * suppressed alerts stays on the dashboard so nothing quietly disappears.
 */

import { all, one } from '../db/index.js';
import { wipForAll, effectiveExcessPct, type OrderWip } from './facts.js';
import { plannedCut } from './flow.js';

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface Alert {
  order_no: string;
  order_id: number;
  buyer: string;
  type: string;
  severity: Severity;
  qty: number;
  days: number;
  message: string;
  action: string;
  owner: string;
  suppressed: boolean;
  suppressed_until?: string;
  link: string;
  /** stable identity, so a notification is sent once and not every minute */
  dedupe_key: string;
}

export interface AlertCatalogEntry { type: string; label: string; waivable: boolean; description: string }

export const ALERT_CATALOG: AlertCatalogEntry[] = [
  { type: 'OVERDUE', label: 'Past ex-factory', waivable: true, description: 'Ex-factory date has gone by with pieces still unshipped.' },
  { type: 'SHIPMENT RISK', label: 'Will not make the date', waivable: true, description: 'At the current pace the order cannot be sewn in time.' },
  { type: 'APPROVAL BLOCK', label: 'Buyer approval pending', waivable: true, description: 'A production-blocking approval is still open.' },
  { type: 'FABRIC WAITING', label: 'Fabric not in', waivable: true, description: 'Fabric required-by date has passed with nothing received.' },
  { type: 'TRIMS BLOCK', label: 'Trim short blocks packing', waivable: true, description: 'A trim marked Blocks Packing is short.' },
  { type: 'AT JOB WORK', label: 'Sitting at a vendor', waivable: true, description: 'Pieces have been outside the factory too long.' },
  { type: 'AGED WIP', label: 'Not moving', waivable: true, description: 'WIP has not moved for two weeks.' },
  { type: 'OVER-CUT', label: 'Cut beyond plan', waivable: false, description: 'Cleared on the matrix, not here — an over-cut is a material loss.' },
  { type: 'RECUT PENDING', label: 'Recut not decided', waivable: true, description: 'A short size has no recut decision.' },
  { type: 'SEWING BEHIND', label: 'Sewing behind plan', waivable: true, description: 'Required per day has passed what the line is producing.' },
  { type: 'DHU HIGH', label: 'Quality slipping', waivable: true, description: 'Defects per hundred units above threshold.' },
  { type: 'INSPECTION BLOCK', label: 'Inspection not passed', waivable: true, description: 'Shipment is gated on an inspection that has not passed.' },
  { type: 'SET PAIR GAP', label: 'Set halves out of step', waivable: true, description: 'One half of a set is ahead of the other.' },
  { type: 'FABRIC WASTAGE', label: 'Fabric unaccounted', waivable: false, description: 'A material loss has to be corrected, not accepted.' },
  { type: 'FABRIC SHORT', label: 'Not enough fabric in store', waivable: true, description: 'Store balance cannot cover what is still to cut.' },
  { type: 'MARGIN RISK', label: 'Order loses money', waivable: true, description: 'The approved cost sheet is above the quoted price.' },
  { type: 'NO COST SHEET', label: 'Costed on nothing', waivable: true, description: 'An active order has no cost sheet at all.' },
];
export const WAIVABLE = new Set(ALERT_CATALOG.filter((a) => a.waivable).map((a) => a.type));

const DEFAULTS = {
  jobWorkDays: 14,
  agedWipDays: 14,
  dhuPct: 5,
  wastagePct: 12,
  fabricLeadDays: 21,
  shipmentRiskDays: 3,
};

function daysBetween(a: string | null | undefined, b: Date = new Date()): number {
  if (!a) return 0;
  const t = new Date(`${a}T00:00:00Z`).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.floor((b.getTime() - t) / 86_400_000);
}

const today = () => new Date().toISOString().slice(0, 10);

interface WaiverRow { order_id: number; alert_type: string; valid_until: string }

function activeWaivers(): Map<string, string> {
  const rows = all<WaiverRow>(
    `SELECT order_id, alert_type, valid_until FROM alert_waivers
      WHERE approved = 1 AND date(valid_until) >= date('now')`,
  );
  return new Map(rows.map((r) => [`${r.order_id}|${r.alert_type}`, r.valid_until]));
}

function settingNum(key: string, dflt: number): number {
  const row = one<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
  const n = Number(row?.value);
  return Number.isFinite(n) ? n : dflt;
}

export function computeAlerts(): Alert[] {
  const waivers = activeWaivers();
  const out: Alert[] = [];
  const wips = wipForAll(true);
  const thresholds = {
    jobWorkDays: settingNum('alert.jobwork_days', DEFAULTS.jobWorkDays),
    agedWipDays: settingNum('alert.aged_wip_days', DEFAULTS.agedWipDays),
    dhuPct: settingNum('alert.dhu_pct', DEFAULTS.dhuPct),
    wastagePct: settingNum('alert.wastage_pct', DEFAULTS.wastagePct),
    fabricLeadDays: settingNum('alert.fabric_lead_days', DEFAULTS.fabricLeadDays),
  };

  const push = (
    w: OrderWip, type: string, severity: Severity, qty: number, days: number,
    message: string, action: string, owner: string, link: string, extra = '',
  ) => {
    const wk = `${w.order.id}|${type}`;
    const until = waivers.get(wk);
    out.push({
      order_no: w.order.order_no,
      order_id: w.order.id,
      buyer: w.order.buyer,
      type, severity, qty, days, message, action,
      owner: owner || w.order.planner || w.order.merchandiser || '',
      suppressed: WAIVABLE.has(type) && Boolean(until),
      suppressed_until: until,
      link,
      dedupe_key: `${w.order.id}|${type}|${extra}`,
    });
  };

  for (const w of wips) {
    const o = w.order;
    const t = w.totals;
    const link = `/orders/${encodeURIComponent(o.order_no)}`;

    // ---------------------------------------------------------- OVERDUE
    const overdueDays = o.ex_factory_date ? daysBetween(o.ex_factory_date) : 0;
    const unshipped = Math.max(0, o.order_qty - t.shipped);
    if (overdueDays > 0 && unshipped > 0) {
      push(w, 'OVERDUE', overdueDays > 7 ? 'CRITICAL' : 'HIGH', unshipped, overdueDays,
        `Past ex-factory by ${overdueDays} day${overdueDays === 1 ? '' : 's'} with ${unshipped} pcs unshipped`,
        'Agree a revised date with the buyer and update Ex-Factory on the order',
        o.merchandiser, link);
    }

    // ---------------------------------------------------- SHIPMENT RISK
    if (overdueDays <= 0 && o.ex_factory_date && o.sam > 0) {
      const daysLeft = -overdueDays;
      const toSew = t.ready_for_sewing + t.in_sewing + t.awaiting_fusing + t.awaiting_jobwork + t.at_jobwork_vendor;
      if (toSew > 0 && daysLeft > 0) {
        const perDay = Math.ceil(toSew / daysLeft);
        const recent = one<{ avg: number }>(
          `SELECT AVG(block1 + block2 + block3) AS avg FROM sewing
            WHERE order_id = ? AND date(txn_date) >= date('now','-10 day')`, [o.id],
        )?.avg ?? 0;
        if (recent > 0 && perDay > recent * 1.25) {
          push(w, 'SHIPMENT RISK', 'HIGH', toSew, daysLeft,
            `Needs ${perDay} pcs/day for ${daysLeft} days; the line is averaging ${Math.round(recent)}`,
            'Add a line, add hours, or move the ex-factory date now rather than later',
            o.planner, link);
        } else if (recent === 0 && daysLeft <= DEFAULTS.shipmentRiskDays) {
          push(w, 'SHIPMENT RISK', 'HIGH', toSew, daysLeft,
            `${toSew} pcs still to sew with ${daysLeft} day${daysLeft === 1 ? '' : 's'} to go and no output logged`,
            'Start the line or re-plan the date',
            o.planner, link);
        }
      }
    }

    // --------------------------------------------------- APPROVAL BLOCK
    for (const a of all<{ approval_type: string; sent_date: string; owner: string }>(
      `SELECT approval_type, sent_date, owner FROM buyer_approvals
        WHERE order_id = ? AND required = 1 AND blocks_production = 1 AND status = 'Pending'`, [o.id],
    )) {
      const d = daysBetween(a.sent_date);
      push(w, 'APPROVAL BLOCK', d > 7 ? 'HIGH' : 'MEDIUM', o.order_qty, d,
        `${a.approval_type} pending${a.sent_date ? ` for ${d} days` : ' — not even sent yet'}`,
        'Chase the buyer; production is held on this',
        a.owner || o.merchandiser, `/approvals?order=${encodeURIComponent(o.order_no)}`, a.approval_type);
    }

    // --------------------------------------------------- FABRIC WAITING
    const lead = o.fabric_lead_days ?? thresholds.fabricLeadDays;
    if (o.order_date) {
      const requiredBy = new Date(new Date(`${o.order_date}T00:00:00Z`).getTime() + lead * 86_400_000)
        .toISOString().slice(0, 10);
      const recd = one<{ kg: number }>(
        `SELECT COALESCE(SUM(CASE WHEN direction = 'RECEIPT' THEN qty_kg ELSE 0 END), 0) AS kg
           FROM fabric_ledger WHERE order_id = ?`, [o.id],
      )?.kg ?? 0;
      const late = daysBetween(requiredBy);
      if (recd <= 0 && late > 0) {
        push(w, 'FABRIC WAITING', late > 7 ? 'CRITICAL' : 'HIGH', o.order_qty, late,
          `No fabric received; required by ${requiredBy}, ${late} day${late === 1 ? '' : 's'} ago`,
          'Chase the mill, or record the receipt if it is already in the store',
          o.merchandiser, `/fabric?order=${encodeURIComponent(o.order_no)}`);
      }
    }

    // ----------------------------------------------------- TRIMS BLOCK
    for (const tr of all<{ trim_item: string; short: number }>(
      `SELECT trim_item, SUM(required_qty) - SUM(received_qty) AS short FROM trims
        WHERE order_id = ? AND blocks_packing = 1
        GROUP BY trim_item HAVING short > 0`, [o.id],
    )) {
      push(w, 'TRIMS BLOCK', 'HIGH', Math.round(tr.short), 0,
        `${tr.trim_item} short by ${Math.round(tr.short)} and it blocks packing`,
        'Get the trim in or the cartons cannot close',
        o.merchandiser, `/trims?order=${encodeURIComponent(o.order_no)}`, tr.trim_item);
    }

    // ------------------------------------------------------ AT JOB WORK
    for (const jw of all<{ process: string; vendor: string; pending: number; days: number }>(
      `SELECT process, vendor,
              SUM(CASE WHEN direction = 'OUT' THEN qty ELSE -qty END) AS pending,
              CAST(julianday('now') - julianday(MIN(CASE WHEN direction = 'OUT' THEN txn_date END)) AS INTEGER) AS days
         FROM job_work WHERE order_id = ?
        GROUP BY process, vendor HAVING pending > 0`, [o.id],
    )) {
      if (jw.days >= thresholds.jobWorkDays) {
        push(w, 'AT JOB WORK', jw.days > 21 ? 'CRITICAL' : 'HIGH', jw.pending, jw.days,
          `${jw.pending} pcs at ${jw.vendor} for ${jw.days} days (${jw.process})`,
          'Escalate to the vendor or send a vehicle to collect',
          o.planner, `/jobwork?order=${encodeURIComponent(o.order_no)}`, `${jw.process}|${jw.vendor}`);
      }
    }

    // --------------------------------------------------------- AGED WIP
    if (t.total_wip > 0 && t.max_ageing >= thresholds.agedWipDays) {
      push(w, 'AGED WIP', t.max_ageing > 30 ? 'CRITICAL' : 'HIGH', t.total_wip, t.max_ageing,
        `${t.total_wip} pcs have not moved for ${t.max_ageing} days`,
        'Find the pile on the floor and give it an owner today',
        o.planner, `/wip?order=${encodeURIComponent(o.order_no)}`);
    }

    // ------------------------------------------- OVER-CUT / RECUT PENDING
    const excess = effectiveExcessPct(o);
    for (const m of all<{ colour: string; size: string; order_qty: number; recut_decision: string }>(
      'SELECT colour, size, order_qty, recut_decision FROM order_matrix WHERE order_id = ?', [o.id],
    )) {
      const cell = w.cells.find((c) => c.colour === m.colour && c.size === m.size);
      if (!cell) continue;
      const plan = plannedCut(m.order_qty, excess, o.buffer_pct);
      const over = cell.cum_cut - plan;
      if (over > 0 && m.recut_decision !== 'Over Cut Approved') {
        push(w, 'OVER-CUT', 'MEDIUM', over, 0,
          `${m.colour} ${m.size} cut ${over} beyond plan of ${plan}`,
          'Approve the over-cut on the matrix or correct the cutting entry',
          o.planner, `/matrix?order=${encodeURIComponent(o.order_no)}`, `${m.colour}|${m.size}`);
      }
      const short = plan - cell.cum_cut;
      const decided = ['Recut Done', 'Ship Short Approved', 'Recut Required'].includes(m.recut_decision);
      if (short > 0 && cell.cum_cut > 0 && !decided && t.bal_to_cut === short) {
        push(w, 'RECUT PENDING', 'MEDIUM', short, 0,
          `${m.colour} ${m.size} is ${short} short and no recut decision has been taken`,
          'Decide on the matrix: recut, or ship short with the buyer’s agreement',
          o.planner, `/matrix?order=${encodeURIComponent(o.order_no)}`, `${m.colour}|${m.size}`);
      }
    }

    // --------------------------------------------------------- DHU HIGH
    const chk = one<{ checked: number; defects: number }>(
      `SELECT COALESCE(SUM(checked_qty),0) AS checked,
              COALESCE(SUM(alter_qty + reject_qty),0) AS defects
         FROM checking WHERE order_id = ?`, [o.id],
    );
    if (chk && chk.checked >= 100) {
      const dhu = (chk.defects / chk.checked) * 100;
      if (dhu > thresholds.dhuPct) {
        push(w, 'DHU HIGH', dhu > thresholds.dhuPct * 2 ? 'HIGH' : 'MEDIUM', chk.defects, 0,
          `DHU is ${dhu.toFixed(1)}% against a ${thresholds.dhuPct}% limit`,
          'Find the operation causing it before the rework pile grows',
          o.planner, `/checking?order=${encodeURIComponent(o.order_no)}`);
      }
    }

    // -------------------------------------------------- INSPECTION BLOCK
    const hasInspection = all<{ c: number }>(
      "SELECT COUNT(*) AS c FROM order_route WHERE order_id = ? AND process = 'Inspection'", [o.id],
    )[0]?.c ?? 0;
    if (hasInspection > 0 && t.packed_not_shipped > 0) {
      const passed = one<{ c: number }>(
        "SELECT COUNT(*) AS c FROM inspection WHERE order_id = ? AND result = 'Pass'", [o.id],
      )?.c ?? 0;
      if (passed === 0) {
        push(w, 'INSPECTION BLOCK', 'HIGH', t.packed_not_shipped, 0,
          `${t.packed_not_shipped} pcs packed but inspection has not passed`,
          'Book the inspection; shipment stays shut until it passes',
          o.merchandiser, `/inspection?order=${encodeURIComponent(o.order_no)}`);
      }
    }

    // ---------------------------------------------------- FABRIC WASTAGE
    for (const f of all<{ fabric_type: string; colour: string; net: number }>(
      `SELECT fabric_type, colour,
              SUM(CASE WHEN direction IN ('ISSUE','TRANSFER_OUT') THEN qty_kg
                       WHEN direction IN ('RETURN','TRANSFER_IN') THEN -qty_kg ELSE 0 END) AS net
         FROM fabric_ledger WHERE order_id = ? GROUP BY fabric_type, colour HAVING net > 0`, [o.id],
    )) {
      const consumedRow = one<{ kg: number }>(
        `SELECT COALESCE(SUM(cut_qty * COALESCE(pc_weight_g, fabric_gsm * area_per_pc_sqm, 0)), 0) / 1000.0 AS kg
           FROM cutting WHERE order_id = ? AND fabric_type = ? AND colour = ?`,
        [o.id, f.fabric_type, f.colour],
      );
      const manual = one<{ consumed_kg: number }>(
        'SELECT consumed_kg FROM fabric_manual_consumption WHERE order_id = ? AND fabric_type = ? AND colour = ?',
        [o.id, f.fabric_type, f.colour],
      );
      const consumed = manual?.consumed_kg ?? consumedRow?.kg ?? 0;
      if (consumed <= 0) continue;
      const waste = f.net - consumed;
      const wastePct = (waste / f.net) * 100;
      if (wastePct > thresholds.wastagePct) {
        push(w, 'FABRIC WASTAGE', 'MEDIUM', Math.round(waste), 0,
          `${f.fabric_type} ${f.colour}: ${wastePct.toFixed(1)}% unaccounted (${waste.toFixed(1)} kg)`,
          'Re-weigh and enter the actual consumption on the fabric store',
          o.planner, `/fabric?order=${encodeURIComponent(o.order_no)}`, `${f.fabric_type}|${f.colour}`);
      }
    }

    // ----------------------------------------------------- FABRIC SHORT
    // What is still to cut, against what the store actually holds.
    if (t.bal_to_cut > 0) {
      const need = one<{ g: number }>(
        `SELECT COALESCE(AVG(COALESCE(pc_weight_g, fabric_gsm * area_per_pc_sqm)), 0) AS g
           FROM cutting WHERE order_id = ?`, [o.id],
      )?.g ?? 0;
      if (need > 0) {
        const needKg = (need * t.bal_to_cut) / 1000;
        const inStore = one<{ kg: number }>(
          `SELECT COALESCE(SUM(CASE
                     WHEN direction IN ('RECEIPT','RETURN','TRANSFER_IN') THEN qty_kg
                     WHEN direction IN ('ISSUE','TRANSFER_OUT') THEN -qty_kg
                     ELSE qty_kg END), 0) AS kg
             FROM fabric_ledger WHERE order_id = ?`, [o.id],
        )?.kg ?? 0;
        if (inStore < needKg * 0.95) {
          push(w, 'FABRIC SHORT', 'HIGH', t.bal_to_cut, 0,
            `${t.bal_to_cut} pcs still to cut need about ${needKg.toFixed(1)} kg; the store holds ${inStore.toFixed(1)} kg`,
            'Issue more fabric to this order or raise a shortage with the mill',
            o.merchandiser, `/fabric?order=${encodeURIComponent(o.order_no)}`);
        }
      }
    }

    // ------------------------------------------- MARGIN RISK / NO COST SHEET
    const sheet = one<{ id: number; status: string; margin: number | null }>(
      `SELECT id, status FROM cost_sheets WHERE order_id = ? AND is_primary = 1 LIMIT 1`, [o.id],
    );
    if (!sheet) {
      push(w, 'NO COST SHEET', 'MEDIUM', o.order_qty, 0,
        'Active order with no cost sheet — nobody knows what this order earns',
        'Build a cost sheet before the order runs any further',
        o.merchandiser, `/costing/${encodeURIComponent(o.order_no)}`);
    }
  }

  // SET PAIR GAP works across orders, so it runs after the per-order loop.
  const groups = new Map<string, OrderWip[]>();
  for (const w of wips) {
    if (!w.order.set_group) continue;
    const list = groups.get(w.order.set_group) ?? [];
    list.push(w);
    groups.set(w.order.set_group, list);
  }
  for (const [group, members] of groups) {
    if (members.length < 2) {
      const w = members[0];
      push(w, 'SET PAIR GAP', 'HIGH', w.order.order_qty, 0,
        `Set group "${group}" has only one order in it`,
        'Declare both halves of the set, or clear the set group',
        w.order.merchandiser, `/orders/${encodeURIComponent(w.order.order_no)}`, group);
      continue;
    }
    const shipped = members.map((m) => m.totals.shipped);
    const gap = Math.max(...shipped) - Math.min(...shipped);
    if (gap > 0) {
      const behind = members[shipped.indexOf(Math.min(...shipped))];
      push(behind, 'SET PAIR GAP', 'MEDIUM', gap, 0,
        `Set "${group}" is ${gap} pcs out of step; a set only ships when both halves ship`,
        'Bring the trailing half up before dispatching either',
        behind.order.planner, `/orders/${encodeURIComponent(behind.order.order_no)}`, group);
    }
  }

  const rank: Record<Severity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  return out.sort((a, b) => {
    if (a.suppressed !== b.suppressed) return a.suppressed ? 1 : -1;
    if (rank[a.severity] !== rank[b.severity]) return rank[a.severity] - rank[b.severity];
    if (b.days !== a.days) return b.days - a.days;
    return b.qty - a.qty;
  });
}

export interface AlertSummary {
  open: number; suppressed: number; critical: number; high: number;
  byType: { type: string; count: number; qty: number }[];
  generatedAt: string;
}

export function summarise(alerts: Alert[]): AlertSummary {
  const live = alerts.filter((a) => !a.suppressed);
  const byType = new Map<string, { type: string; count: number; qty: number }>();
  for (const a of live) {
    const e = byType.get(a.type) ?? { type: a.type, count: 0, qty: 0 };
    e.count += 1; e.qty += a.qty;
    byType.set(a.type, e);
  }
  return {
    open: live.length,
    suppressed: alerts.length - live.length,
    critical: live.filter((a) => a.severity === 'CRITICAL').length,
    high: live.filter((a) => a.severity === 'HIGH').length,
    byType: [...byType.values()].sort((a, b) => b.count - a.count),
    generatedAt: today(),
  };
}
