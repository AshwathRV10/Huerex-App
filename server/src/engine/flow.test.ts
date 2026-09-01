import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeOrderWip, plannedCut, totalsFor, type CellFacts, type OrderFacts, type RouteStep } from './flow.js';

const cell = (over: Partial<CellFacts> = {}): CellFacts => ({
  colour: 'PINK', size: 'M', order_qty: 100, cum_cut: 0, cum_fused: 0,
  jw_out: {}, jw_in: {}, sewn_exact: 0, issued_exact: 0,
  checked: 0, pass: 0, alter: 0, reject: 0, rechecked: 0,
  packed: 0, shipped: 0, last_movement: null, ...over,
});

const route = (...steps: [string, 'In-house' | 'Outsourced'][]): RouteStep[] =>
  steps.map(([process, type], i) => ({ step_no: i + 1, process, type }));

const facts = (over: Partial<OrderFacts> = {}): OrderFacts => ({
  order_qty: 100, buffer_pct: 0.05, excess_pct: 0,
  route: route(['Cutting', 'In-house'], ['Sewing', 'In-house'], ['Checking', 'In-house'],
    ['Packing', 'In-house'], ['Shipment', 'In-house']),
  sewn_pool: 0, issued_pool: 0, cells: [cell()], ...over,
});

test('planned cut carries both the excess and the cutting buffer', () => {
  assert.equal(plannedCut(100, 0, 0.05), 105);
  assert.equal(plannedCut(100, 3, 0.05), Math.ceil(100 * 1.03 * 1.05));
  assert.equal(plannedCut(100, 0, 0), 100);
});

test('pieces stack in front of the step that has not happened', () => {
  const [w] = computeOrderWip(facts({ cells: [cell({ cum_cut: 100 })] }));
  assert.equal(w.ready_for_sewing, 100);
  assert.equal(w.total_wip, 100);
  assert.equal(w.where_now, 'Awaiting Sewing');
  assert.equal(w.next_step, 'Sewing');
});

test('the identity Cut = Shipped + Rejected + WIP holds through the route', () => {
  const [w] = computeOrderWip(facts({
    cells: [cell({ cum_cut: 100, checked: 90, pass: 85, alter: 2, reject: 3, rechecked: 2, packed: 80, shipped: 60 })],
    sewn_pool: 95, issued_pool: 100,
  }));
  assert.equal(w.total_wip, 100 - 60 - 3);
  assert.equal(w.imbalance, 0, 'the buckets add back up to total WIP');
});

test('an outsourced step splits into waiting, at the vendor, and returned', () => {
  const [w] = computeOrderWip(facts({
    route: route(['Cutting', 'In-house'], ['Print', 'Outsourced'], ['Sewing', 'In-house']),
    cells: [cell({ cum_cut: 100, jw_out: { Print: 70, 'Print|2': 70 }, jw_in: { Print: 40, 'Print|2': 40 } })],
  }));
  assert.equal(w.awaiting_jobwork, 30, 'never sent');
  assert.equal(w.at_jobwork_vendor, 30, 'sent but not back');
  assert.equal(w.ready_for_sewing, 40, 'came back and can be sewn');
  assert.equal(w.imbalance, 0);
});

test('the same process twice in a route is kept apart by step number', () => {
  const [w] = computeOrderWip(facts({
    route: route(['Cutting', 'In-house'], ['Print', 'Outsourced'], ['Sewing', 'In-house'], ['Print', 'Outsourced']),
    cells: [cell({
      cum_cut: 100,
      jw_out: { 'Print|2': 100, 'Print|4': 30, Print: 130 },
      jw_in: { 'Print|2': 100, 'Print|4': 10, Print: 110 },
    })],
    sewn_pool: 100, issued_pool: 100,
  }));
  // First print finished; second print has 30 sent, 10 back, 70 not yet sent.
  assert.equal(w.at_jobwork_vendor, 20);
  assert.equal(w.awaiting_jobwork, 70);
});

test('fusing after sewing is allowed and lands in its own bucket', () => {
  const [w] = computeOrderWip(facts({
    route: route(['Cutting', 'In-house'], ['Sewing', 'In-house'], ['Fusing', 'In-house'], ['Checking', 'In-house']),
    cells: [cell({ cum_cut: 100, cum_fused: 40 })],
    sewn_pool: 100, issued_pool: 100,
  }));
  assert.equal(w.awaiting_fusing, 60);
  assert.equal(w.awaiting_checking, 40);
});

test('rework is held inside checking, not counted as good', () => {
  const [w] = computeOrderWip(facts({
    cells: [cell({ cum_cut: 100, checked: 100, pass: 90, alter: 8, reject: 2, rechecked: 3 })],
    sewn_pool: 100, issued_pool: 100,
  }));
  assert.equal(w.in_rework, 5, '8 sent to alter, 3 came back');
  assert.equal(w.good, 93, '90 passed plus 3 re-checked');
  assert.equal(w.rejected, 2);
});

test('order-level sewing output is spread across the sizes that could have made it', () => {
  const cells = computeOrderWip(facts({
    cells: [
      cell({ size: 'S', cum_cut: 60 }),
      cell({ size: 'M', cum_cut: 40 }),
    ],
    sewn_pool: 50, issued_pool: 50,
  }));
  const sewnByCell = cells.map((c) => c.steps.find((s) => s.process === 'Sewing')!.done);
  assert.equal(sewnByCell.reduce((a, b) => a + b, 0), 50, 'nothing is created or lost in the split');
  assert.equal(sewnByCell[0], 30);
  assert.equal(sewnByCell[1], 20);
});

test('exact sewing entries are kept, and the pool fills only what is left', () => {
  const cells = computeOrderWip(facts({
    cells: [
      // S has 5 pieces of room left, M has 40. The 30 un-attributed pieces are
      // split in that ratio, so S ends on 55 + 3 and M on 27.
      cell({ size: 'S', cum_cut: 60, sewn_exact: 55, issued_exact: 60 }),
      cell({ size: 'M', cum_cut: 40 }),
    ],
    sewn_pool: 30, issued_pool: 30,
  }));
  const sewn = cells.map((c) => c.steps.find((s) => s.process === 'Sewing')!.done);
  assert.equal(sewn[0], 58);
  assert.equal(sewn[1], 27);
  assert.equal(sewn[0] + sewn[1], 55 + 30, 'the exact entries plus the whole pool, nothing invented');
});

test('inspection is a gate, not a place pieces pile up', () => {
  const [w] = computeOrderWip(facts({
    route: route(['Cutting', 'In-house'], ['Packing', 'In-house'], ['Inspection', 'In-house'], ['Shipment', 'In-house']),
    cells: [cell({ cum_cut: 100, packed: 100 })],
  }));
  assert.equal(w.packed_not_shipped, 100);
  assert.equal(w.imbalance, 0);
});

test('cutting beyond plan is flagged rather than silently absorbed', () => {
  const [w] = computeOrderWip(facts({ cells: [cell({ cum_cut: 120 })] }));
  assert.equal(w.planned_cut, 105);
  assert.equal(w.flag, 'OVER-CUT');
  assert.equal(w.bal_to_cut, 0);
});

test('totals add the cells up without double counting', () => {
  const cells = computeOrderWip(facts({
    cells: [cell({ size: 'S', cum_cut: 60, shipped: 10 }), cell({ size: 'M', cum_cut: 40, shipped: 5 })],
    sewn_pool: 100, issued_pool: 100,
  }));
  const t = totalsFor(cells);
  assert.equal(t.cum_cut, 100);
  assert.equal(t.shipped, 15);
  assert.equal(t.total_wip, 85);
});
