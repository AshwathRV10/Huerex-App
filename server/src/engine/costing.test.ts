import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCostSheet, computeQuantities, fabricRatePerKg, type CostSheetInput } from './costing.js';

const base: CostSheetInput = {
  order_qty: 1000,
  excess_pct: 0,
  excess_billable: true,
  rejection_pct: 0,
  currency: 'INR',
  fx_rate: 1,
  selling_price_per_pc: 0,
  fabric: [], trims: [], jobwork: [], cmt: [], overheads: [],
};

test('excess ships with the order and is billable by default', () => {
  const q = computeQuantities({ order_qty: 1000, excess_pct: 3, excess_billable: true, rejection_pct: 0 });
  assert.equal(q.excessQty, 30);
  assert.equal(q.shipQty, 1030);
  assert.equal(q.billableQty, 1030);
  assert.equal(q.productionQty, 1030);
});

test('unbilled excess is produced but earns nothing', () => {
  const q = computeQuantities({ order_qty: 1000, excess_pct: 3, excess_billable: false, rejection_pct: 0 });
  assert.equal(q.shipQty, 1030, 'still ships');
  assert.equal(q.billableQty, 1000, 'but only the order is invoiced');
});

test('rejection inflates production above what ships', () => {
  const q = computeQuantities({ order_qty: 1000, excess_pct: 0, excess_billable: true, rejection_pct: 2 });
  assert.equal(q.shipQty, 1000);
  assert.equal(q.productionQty, 1021, '1000 / 0.98 rounded up');
  assert.equal(q.rejectionQty, 21);
});

test('excess and rejection compound in the right order', () => {
  const q = computeQuantities({ order_qty: 1000, excess_pct: 5, excess_billable: true, rejection_pct: 4 });
  assert.equal(q.excessQty, 50);
  assert.equal(q.shipQty, 1050);
  assert.equal(q.productionQty, Math.ceil(1050 / 0.96));
});

test('a fabric build-up grosses each stage up by its own loss', () => {
  const { rate } = fabricRatePerKg({
    fabric_type: 'Single Jersey',
    consumption_g_per_pc: 200,
    components: [
      { component: 'Yarn', rate_per_kg: 250 },
      { component: 'Knitting', rate_per_kg: 40 },
      { component: 'Dyeing', rate_per_kg: 90, loss_pct: 10 },
    ],
  });
  // 250 + 40 + 90/0.9 = 390
  assert.equal(rate, 390);
});

test('dyeing rate changes with colour without touching the rest of the sheet', () => {
  const pink = fabricRatePerKg({
    fabric_type: 'SJ', colour: 'PINK', consumption_g_per_pc: 200,
    components: [{ component: 'Yarn', rate_per_kg: 250 }, { component: 'Dyeing', rate_per_kg: 80 }],
  });
  const black = fabricRatePerKg({
    fabric_type: 'SJ', colour: 'BLACK', consumption_g_per_pc: 200,
    components: [{ component: 'Yarn', rate_per_kg: 250 }, { component: 'Dyeing', rate_per_kg: 140 }],
  });
  assert.equal(black.rate - pink.rate, 60);
});

test('fabric cost uses gross kilograms on the produced quantity', () => {
  const result = computeCostSheet({
    ...base,
    order_qty: 1000,
    rejection_pct: 0,
    fabric: [{
      fabric_type: 'Single Jersey',
      consumption_g_per_pc: 200,
      wastage_pct: 10,
      components: [{ component: 'Flat', rate_per_kg: 300 }],
    }],
  });
  // 200g + 10% = 220g x 1000 pcs = 220 kg at ₹300
  assert.equal(result.blocks[0].lines[0].qty, 220);
  assert.equal(result.blocks[0].total, 66000);
  assert.equal(result.costPerPcShipped, 66);
});

test('sewing costed on SAM is inflated by efficiency', () => {
  const result = computeCostSheet({
    ...base,
    order_qty: 100,
    cmt: [{ operation: 'Sewing', basis: 'per_sam_min', rate: 2, sam_min: 13, efficiency_pct: 65 }],
  });
  // 13 / 0.65 = 20 real minutes x ₹2 x 100 pcs
  assert.equal(result.blocks[3].total, 4000);
});

test('a percentage CMT line is worked out after the direct ones', () => {
  const result = computeCostSheet({
    ...base,
    order_qty: 100,
    cmt: [
      { operation: 'Cutting', basis: 'per_pc', rate: 10 },
      { operation: 'Factory load', basis: 'pct_of_cost', rate: 10 },
    ],
  });
  assert.equal(result.blocks[3].total, 1100, '1000 direct plus 10%');
});

test('job work loss means paying for pieces that never come back', () => {
  const result = computeCostSheet({
    ...base,
    order_qty: 1000,
    jobwork: [{ process: 'Print', vendor: 'ACME', rate_per_pc: 5, vendor_loss_pct: 2, freight_per_order: 500 }],
  });
  const pieces = Math.ceil(1000 / 0.98);
  assert.equal(pieces, 1021);
  assert.equal(result.blocks[2].lines[0].qty, pieces, 'whole garments are sent, not 1020.4 of them');
  assert.equal(result.blocks[2].total, pieces * 5 + 500);
});

test('only part of the order carrying a print costs only for that part', () => {
  const result = computeCostSheet({
    ...base,
    order_qty: 1000,
    jobwork: [{ process: 'Print', rate_per_pc: 10, applies_qty_pct: 40 }],
  });
  assert.equal(result.blocks[2].total, 4000);
});

test('margin is measured against billable pieces, cost against shipped ones', () => {
  const result = computeCostSheet({
    ...base,
    order_qty: 1000,
    excess_pct: 5,
    excess_billable: true,
    selling_price_per_pc: 200,
    cmt: [{ operation: 'CMT', basis: 'per_pc', rate: 100 }],
  });
  assert.equal(result.quantities.shipQty, 1050);
  assert.equal(result.totalCost, 105000);
  assert.equal(result.revenue, 210000);
  assert.equal(result.margin, 105000);
  assert.equal(result.marginPct, 50);
  assert.equal(result.costPerPcShipped, 100);
});

test('free excess is flagged as cost with no revenue behind it', () => {
  const result = computeCostSheet({
    ...base,
    order_qty: 1000,
    excess_pct: 5,
    excess_billable: false,
    selling_price_per_pc: 200,
    cmt: [{ operation: 'CMT', basis: 'per_pc', rate: 100 }],
  });
  assert.equal(result.revenue, 200000, 'only the ordered pieces are invoiced');
  assert.equal(result.totalCost, 105000, 'but all 1050 were made');
  assert.ok(result.warnings.some((w) => w.includes('excess pieces are shipped free')));
});

test('a foreign-currency price is converted before margin is judged', () => {
  const result = computeCostSheet({
    ...base,
    order_qty: 1000,
    currency: 'USD',
    fx_rate: 84,
    selling_price_per_pc: 5,
    cmt: [{ operation: 'CMT', basis: 'per_pc', rate: 300 }],
  });
  assert.equal(result.revenue, 420000);
  assert.equal(result.margin, 120000);
});

test('break-even and target price come back in rupees per piece', () => {
  const result = computeCostSheet({
    ...base,
    order_qty: 1000,
    selling_price_per_pc: 150,
    target_margin_pct: 25,
    cmt: [{ operation: 'CMT', basis: 'per_pc', rate: 100 }],
  });
  assert.equal(result.breakEvenPricePerPc, 100);
  assert.equal(result.targetPricePerPc, Math.round((100 / 0.75) * 100) / 100);
});

test('a loss-making quote is called out rather than left to be spotted', () => {
  const result = computeCostSheet({
    ...base,
    order_qty: 100,
    selling_price_per_pc: 50,
    cmt: [{ operation: 'CMT', basis: 'per_pc', rate: 80 }],
  });
  assert.ok(result.margin < 0);
  assert.ok(result.warnings.some((w) => w.includes('loses')));
});

test('overheads honour every basis they offer', () => {
  const result = computeCostSheet({
    ...base,
    order_qty: 1000,
    selling_price_per_pc: 100,
    cmt: [{ operation: 'CMT', basis: 'per_pc', rate: 50 }],
    overheads: [
      { category: 'Sampling', basis: 'per_order', amount: 5000 },
      { category: 'Transport', basis: 'per_pc', amount: 2 },
      { category: 'Factory', basis: 'pct_of_cost', amount: 10 },
      { category: 'Commission', basis: 'pct_of_revenue', amount: 3 },
    ],
  });
  const lines = result.blocks[4].lines;
  assert.equal(lines[0].total, 5000);
  assert.equal(lines[1].total, 2000);
  assert.equal(lines[2].total, 5000, '10% of the 50,000 CMT base');
  assert.equal(lines[3].total, 3000, '3% of 100,000 revenue');
});

test('size-graded prices are weighted by the matrix', () => {
  const result = computeCostSheet({
    ...base,
    order_qty: 100,
    selling_price_per_pc: 100,
    priceOverrides: [
      { colour: 'PINK', size: 'S', price_per_pc: 120, qty: 60 },
      { colour: 'PINK', size: 'L', price_per_pc: 150, qty: 40 },
    ],
  });
  assert.equal(result.revenue, 60 * 120 + 40 * 150);
});

test('an empty sheet is zero everywhere rather than NaN', () => {
  const result = computeCostSheet({ ...base, order_qty: 0 });
  assert.equal(result.totalCost, 0);
  assert.equal(result.costPerPcShipped, 0);
  assert.equal(result.marginPct, 0);
  assert.ok(result.warnings.some((w) => w.includes('Order quantity is zero')));
});
