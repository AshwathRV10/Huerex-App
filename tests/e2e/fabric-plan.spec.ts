import { expect, test } from '@playwright/test';
import { USERS } from './config';

/**
 * The fabric plan: what yarn to buy, decided the day the order lands.
 *
 * The arithmetic under test is a page from the merchandiser's notebook:
 *
 *   Order Qty : 1000 pcs   pcs wt. 88 g/pc
 *   S/J   : 1000 × 0.088 = 88 kgs + 10% excess = 96.8 kgs
 *   1×1 Rib: 1000 × 0.010 = 10 kgs + 10% excess = 11 kgs
 *
 * An order carries several cloths — a body, a collar rib, a fleece panel —
 * each with its own grammage and its own excess, because a dark shade loses
 * more in dyeing than a pastel does.
 */

test.use({ storageState: USERS.manager.state });

async function makeOrder(request: import('@playwright/test').APIRequestContext, qty = 1000) {
  const orderNo = `E2E-PLAN-${Date.now().toString(36).toUpperCase()}`;
  const made = await request.post('/api/orders', {
    data: { order_no: orderNo, buyer: 'E2E PLAN BUYER', style: 'TEE', order_qty: qty, excess_pct: 0 },
  });
  expect(made.status(), await made.text()).toBe(201);
  return orderNo;
}

test('the plan works out the yarn, one line per cloth', async ({ page, request }) => {
  const orderNo = await makeOrder(request);
  await request.put(`/api/orders/${orderNo}/fabrics`, {
    data: {
      fabrics: [
        { fabric_type: 'Single Jersey', colour: 'Bachelor Button', part: 'Body', grammage_g_per_pc: 88, excess_pct: 10 },
        { fabric_type: '1x1 Rib', colour: 'Bachelor Button', part: 'Collar', grammage_g_per_pc: 10, excess_pct: 10 },
      ],
    },
  });

  await page.goto(`/orders/${orderNo}`);
  await page.getByRole('tab', { name: 'Fabric plan' }).click();

  const jersey = page.locator('table.data tbody tr').filter({ hasText: 'Single Jersey' });
  await expect(jersey).toContainText('88 kg');
  await expect(jersey).toContainText('96.8 kg');

  const rib = page.locator('table.data tbody tr').filter({ hasText: '1x1 Rib' });
  await expect(rib).toContainText('11 kg');

  // The whole order, which is the number that goes to the yarn agent.
  await expect(page.locator('table.data tfoot')).toContainText('107.8 kg');
});

test('an order with no plan says so, and offers to start one', async ({ page, request }) => {
  const orderNo = await makeOrder(request);
  await page.goto(`/orders/${orderNo}`);
  await page.getByRole('tab', { name: 'Fabric plan' }).click();

  await expect(page.getByText('No fabric planned yet')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Plan the fabric' }).first()).toBeVisible();
});

test('the yarn figure moves as the plan is typed', async ({ page, request }) => {
  const orderNo = await makeOrder(request);
  await page.goto(`/orders/${orderNo}`);
  await page.getByRole('tab', { name: 'Fabric plan' }).click();
  await page.getByRole('button', { name: 'Plan the fabric' }).first().click();

  const fabric = page.getByRole('combobox', { name: 'Fabric' }).first();
  await fabric.click();
  await fabric.pressSequentially('Single Jersey', { delay: 25 });
  await fabric.press('Enter');

  // fill() replaces the cell's contents outright; typing into a grid cell that
  // already holds 0 appends to it, which is a different test entirely.
  await page.getByRole('textbox', { name: 'g/pc' }).first().fill('88');
  await page.getByRole('textbox', { name: 'Excess %' }).first().fill('10');

  await expect(page.getByText(/Yarn to buy, as typed/)).toContainText('96.80 kg');

  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('table.data tfoot')).toContainText('96.8 kg');
});

test('a merchandiser who may not edit orders sees the plan but cannot change it', async ({ page, request, browser }) => {
  const orderNo = await makeOrder(request);
  await request.put(`/api/orders/${orderNo}/fabrics`, {
    data: { fabrics: [{ fabric_type: 'Single Jersey', grammage_g_per_pc: 88, excess_pct: 10 }] },
  });

  const ctx = await browser.newContext({ storageState: USERS.store.state });
  const p = await ctx.newPage();
  await p.goto(`/orders/${orderNo}`);
  await p.getByRole('tab', { name: 'Fabric plan' }).click();
  await expect(p.locator('table.data tbody tr').first()).toContainText('96.8 kg');
  await expect(p.getByRole('button', { name: /Plan the fabric|Edit the plan/ })).toHaveCount(0);
  await ctx.close();
});

/* ------------------------------------------ the plan against the store -- */

test('the loss is measured as the cloth is booked in', async ({ page, request }) => {
  const orderNo = await makeOrder(request);
  await request.put(`/api/orders/${orderNo}/fabrics`, {
    data: {
      fabrics: [
        { fabric_type: 'Single Jersey', colour: 'Navy', part: 'Body', grammage_g_per_pc: 88, excess_pct: 10 },
      ],
    },
  });

  await page.goto(`/orders/${orderNo}`);
  await page.getByRole('tab', { name: 'Fabric plan' }).click();
  await expect(page.getByText(/Nothing received against this plan yet/)).toBeVisible();

  // 96.8 kg of yarn was booked; 88.2 kg of cloth comes back.
  const got = await request.post('/api/fabric', {
    data: {
      txn_date: '2026-09-08', direction: 'RECEIPT', fabric_type: 'Single Jersey', colour: 'Navy',
      order_no: orderNo, qty_kg: 88.2, rate_per_kg: 320, supplier: 'E2E MILLS',
    },
  });
  expect(got.status(), await got.text()).toBe(201);

  await page.reload();
  await page.getByRole('tab', { name: 'Fabric plan' }).click();
  await expect(page.getByText('What actually came back')).toBeVisible();

  const row = page.locator('table.data tbody tr').filter({ hasText: 'Single Jersey' }).last();
  await expect(row).toContainText('96.8 kg');
  await expect(row).toContainText('88.2 kg');
  await expect(row).toContainText('8.88%');
});

test('a cost sheet is proposed from the plan, part and all', async ({ page, request }) => {
  const orderNo = await makeOrder(request);
  await request.put(`/api/orders/${orderNo}/fabrics`, {
    data: {
      fabrics: [
        { fabric_type: 'Single Jersey', colour: 'Navy', part: 'Body', grammage_g_per_pc: 88, excess_pct: 10 },
        { fabric_type: '1x1 Rib', colour: 'Navy', part: 'Collar', grammage_g_per_pc: 10, excess_pct: 10 },
      ],
    },
  });

  await page.goto(`/costing/${orderNo}`);
  // The draft says where the fabric came from rather than presenting a
  // grammage somebody chose as though the app had invented it.
  await expect(page.getByText(/Fabric — from the order/)).toBeVisible();
  await expect(page.getByText(/Single Jersey · Navy at 88 g\/pc/)).toBeVisible();
  await expect(page.getByText(/1x1 Rib · Navy \(Collar\) at 10 g\/pc/)).toBeVisible();

  await page.getByRole('button', { name: 'Start a cost sheet' }).click();
  await expect(page.getByText('Ordered', { exact: true })).toBeVisible();

  // And the sheet itself carries the planned grammage, not a guess.
  const grams = page.getByRole('textbox', { name: 'Consumption' }).first();
  await expect(grams).toHaveValue('88');
});
