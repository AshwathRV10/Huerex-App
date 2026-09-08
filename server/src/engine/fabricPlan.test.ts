import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareToPlan, measuredLoss, planFabric } from './fabricPlan.js';

/**
 * The merchandiser's own notebook, from a real order:
 *
 *   Order Qty : 1000 pcs   pcs wt. 88 g/pc
 *   Fabric S/J   : 1000 × 0.088 = 88 kgs + 10% excess = 96.8 kgs
 *   Fabric 1×1 Rib: 1000 × 0.010 = 10 kgs + 10% excess = 11 kgs
 *
 * If the app disagrees with that page, the app is wrong.
 */
const tee = [
  { fabric_type: 'Single Jersey', part: 'Body', grammage_g_per_pc: 88, excess_pct: 10 },
  { fabric_type: '1x1 Rib', part: 'Collar', grammage_g_per_pc: 10, excess_pct: 10 },
];

test('it agrees with the notebook', () => {
  const plan = planFabric(tee, 1000);
  assert.equal(plan.lines[0].fabricKg, 88);
  assert.equal(plan.lines[0].yarnKg, 96.8);
  assert.equal(plan.lines[1].fabricKg, 10);
  assert.equal(plan.lines[1].yarnKg, 11);
});

test('the totals are what the whole order needs', () => {
  const plan = planFabric(tee, 1000);
  assert.equal(plan.fabricKg, 98, 'cloth in the garments');
  assert.equal(plan.yarnKg, 107.8, 'yarn to buy');
});

test('each fabric carries its own excess, because a dark shade loses more', () => {
  const plan = planFabric([
    { fabric_type: 'Single Jersey', colour: 'Navy', grammage_g_per_pc: 88, excess_pct: 14 },
    { fabric_type: 'Single Jersey', colour: 'White', grammage_g_per_pc: 88, excess_pct: 6 },
  ], 1000);
  assert.equal(plan.lines[0].yarnKg, 100.32);
  assert.equal(plan.lines[1].yarnKg, 93.28);
});

test('the pieces are the pieces given, excess included', () => {
  // 1,000 ordered with 3% excess is 1,030 garments cut from the same rolls.
  const plan = planFabric([tee[0]], 1030);
  assert.equal(plan.lines[0].pieces, 1030);
  assert.equal(plan.lines[0].fabricKg, 90.64);
  assert.equal(plan.lines[0].yarnKg, 99.7);
});

test('no excess means the yarn is the cloth, and no grammage means nothing', () => {
  const plan = planFabric([
    { fabric_type: 'Single Jersey', grammage_g_per_pc: 88, excess_pct: 0 },
    { fabric_type: 'Not decided yet', grammage_g_per_pc: 0, excess_pct: 10 },
  ], 1000);
  assert.equal(plan.lines[0].yarnKg, 88);
  assert.equal(plan.lines[1].yarnKg, 0);
});

test('a negative excess cannot plan less yarn than cloth', () => {
  // Not a discount — a shortfall discovered on the knitting floor.
  const plan = planFabric([{ fabric_type: 'S/J', grammage_g_per_pc: 88, excess_pct: -20 }], 1000);
  assert.equal(plan.lines[0].yarnKg, 88);
});

test('what actually came back is the factory\'s own loss figure', () => {
  // 96.8 kg of yarn went out, 87.4 kg of finished cloth came in.
  assert.equal(measuredLoss(96.8, 87.4), 9.71);
});

test('loss is unanswerable until some cloth is in', () => {
  assert.equal(measuredLoss(96.8, 0), null, 'nothing received is not a total loss');
  assert.equal(measuredLoss(0, 87.4), null, 'no plan, nothing to measure against');
});

test('more cloth back than yarn out reads as a negative loss, not a hidden one', () => {
  // Worth seeing: usually a receipt booked against the wrong order.
  assert.equal(measuredLoss(100, 110), -10);
});

/* ------------------------------------------- the plan against the store -- */

const plan = planFabric([
  { fabric_type: 'Single Jersey', colour: 'Navy', part: 'Body', grammage_g_per_pc: 88, excess_pct: 12 },
  { fabric_type: 'Single Jersey', colour: 'Navy', part: 'Collar', grammage_g_per_pc: 10, excess_pct: 12 },
  { fabric_type: '3T Fleece', colour: '', part: 'Body', grammage_g_per_pc: 200, excess_pct: 10 },
], 1000).lines;

test('yarn out against cloth back is the factory\'s own loss', () => {
  // 109.76 kg of navy jersey booked; 99 kg of cloth came in.
  const [jersey] = compareToPlan(plan, [
    { fabric_type: 'Single Jersey', colour: 'Navy', kg: 99 },
  ]);
  assert.equal(jersey.plannedYarnKg, 109.76, '98.56 for the body plus 11.2 for the collar');
  assert.equal(jersey.receivedKg, 99);
  assert.equal(jersey.lossPct, 9.8);
  assert.equal(jersey.plannedLossPct, 12, 'and it was planned at 12%');
});

test('body and collar of one cloth are compared together, not split', () => {
  // The store books a receipt against a cloth and a shade, never a part, so
  // dividing the loss between the body and the collar would be invented.
  const rows = compareToPlan(plan, [{ fabric_type: 'Single Jersey', colour: 'Navy', kg: 99 }]);
  assert.equal(rows.filter((r) => r.fabric_type === 'Single Jersey').length, 1);
});

test('a plan line with no colour takes the shades no line names', () => {
  const rows = compareToPlan(plan, [
    { fabric_type: '3T Fleece', colour: 'Grey Melange', kg: 190 },
    { fabric_type: '3T Fleege typo', colour: 'Grey', kg: 999 },
  ]);
  const fleece = rows.find((r) => r.fabric_type === '3T Fleece')!;
  assert.equal(fleece.receivedKg, 190, 'a cloth nobody planned is not this plan\'s');
  assert.equal(fleece.plannedYarnKg, 220);
});

test('a wildcard line does not also swallow a colour that has its own line', () => {
  const mixed = planFabric([
    { fabric_type: 'Single Jersey', colour: 'Navy', grammage_g_per_pc: 88, excess_pct: 12 },
    { fabric_type: 'Single Jersey', colour: '', grammage_g_per_pc: 88, excess_pct: 6 },
  ], 1000).lines;

  const rows = compareToPlan(mixed, [
    { fabric_type: 'Single Jersey', colour: 'Navy', kg: 90 },
    { fabric_type: 'Single Jersey', colour: 'White', kg: 85 },
  ]);
  assert.equal(rows.find((r) => r.colour === 'Navy')!.receivedKg, 90);
  assert.equal(rows.find((r) => r.colour === '')!.receivedKg, 85, 'the white only, counted once');
});

test('nothing in yet is no answer, not a total loss', () => {
  const [jersey] = compareToPlan(plan, []);
  assert.equal(jersey.receivedKg, 0);
  assert.equal(jersey.lossPct, null);
});
