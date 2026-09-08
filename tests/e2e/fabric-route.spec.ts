import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { USERS } from './config';

/**
 * The fabric rate build-up, which is a route rather than a basket.
 *
 * Every processor bills on the weight sent in, so a loss at any stage means
 * more weight had to be bought and put through every stage before it. A yarn
 * row carrying no loss of its own therefore still costs more per finished
 * kilogram than its ₹/kg: the cloth that survives to the end needed more yarn
 * than it weighs.
 *
 * Two things follow, and both are tested here. The order of the steps decides
 * the answer, so it has to be visible and changeable. And the figure shown
 * while you type is a mirror of the engine — if the two ever drift, the sheet
 * lies until it is saved, so the last test pins the preview to what the server
 * returns.
 */

test.use({ storageState: USERS.manager.state });

/** ₹451.81/kg → 451.81 */
function money(text: string): number {
  return Number(text.replace(/[^0-9.]/g, ''));
}

/**
 * Build a cost sheet of our own, on an order of our own.
 *
 * The seeded orders are shared: another spec submits one, and from then on its
 * sheet is not editable and every button here is gone. So this makes its own
 * order each run, and its own route on it — at least three steps with known
 * losses, the first of them losing nothing, which is the case the whole change
 * is about.
 */
async function openRoute(page: Page, request: APIRequestContext): Promise<void> {
  const orderNo = `E2E-ROUTE-${Date.now().toString(36).toUpperCase()}`;
  const made = await request.post('/api/orders', {
    data: { order_no: orderNo, buyer: 'E2E ROUTE BUYER', style: 'ROUTE TEST', order_qty: 1000 },
  });
  expect(made.status(), await made.text()).toBe(201);

  await page.goto(`/costing/${orderNo}`);
  await page.getByRole('button', { name: 'Start a cost sheet' }).click();
  await expect(page.getByText('Ordered', { exact: true })).toBeVisible();

  const addFabric = page.getByRole('button', { name: 'Add a fabric' });
  await expect(addFabric).toBeVisible({ timeout: 15_000 });

  // Every block draws .line-card, so counting those says nothing about fabric.
  // The build-up toggle only exists on a fabric line, which makes it the honest
  // test of whether there is one.
  const buildup = page.getByRole('button', { name: 'Build-up' });
  if (await buildup.count() === 0) await addFabric.click();
  await expect(buildup.first()).toBeVisible();
  await buildup.first().click();
  while (await page.locator('.comp-row').count() < 3) {
    await page.getByRole('button', { name: 'Add a component' }).first().click();
  }

  // A fabric line without a fabric is refused on save, rightly.
  const fabric = page.getByRole('combobox', { name: 'Fabric' }).first();
  if (!(await fabric.inputValue())) {
    await fabric.click();
    await fabric.pressSequentially('Single Jersey', { delay: 30 });
    await fabric.press('Enter');
  }
  const grams = page.getByRole('textbox', { name: 'Consumption' }).first();
  await grams.click();
  await grams.press('ControlOrMeta+a');
  await grams.pressSequentially('88', { delay: 30 });

  const names = ['Yarn', 'Dyeing', 'Compacting'];
  for (let i = 0; i < names.length; i += 1) {
    const c = page.locator('.comp-row').nth(i).getByRole('combobox', { name: /^Component/ });
    await c.click();
    await c.press('ControlOrMeta+a');
    await c.pressSequentially(names[i], { delay: 25 });
    await c.press('Enter');
  }

  const set = async (row: number, field: string, value: string) => {
    // Only the first row draws a visible heading; the rest are named by
    // aria-label as "Rate, step 2", so match on the leading word.
    const f = page.locator('.comp-row').nth(row)
      .getByRole('textbox', { name: new RegExp(`^${field}`) });
    await f.click();
    await f.press('ControlOrMeta+a');
    await f.pressSequentially(value, { delay: 30 });
  };
  // Yarn loses nothing of its own; the two stages after it do.
  for (const [row, rate, loss] of [[0, '320', '0'], [1, '60', '4'], [2, '10', '5']] as const) {
    await set(row, 'Rate', rate);
    await set(row, 'Loss', loss);
  }
  await expect(page.getByText(/Rate works out at/).first()).toBeVisible();
}

test('the steps are numbered, because their order changes the rate', async ({ page, request }) => {
  await openRoute(page, request);
  const steps = page.locator('.comp-row .step');
  const n = await steps.count();
  expect(n).toBeGreaterThan(1);
  expect(await steps.allInnerTexts()).toEqual(
    Array.from({ length: n }, (_, i) => String(i + 1)),
  );
});

test('moving a step changes the rate, and moving it back restores it', async ({ page, request }) => {
  await openRoute(page, request);
  const summary = page.getByText(/Rate works out at/).first();
  const before = money((await summary.innerText()).split('·')[0]);

  // The second step is not the first or the last, so it has somewhere to go.
  await page.locator('.comp-row').nth(1).getByRole('button', { name: /Move .* earlier/ }).click();
  const moved = money((await summary.innerText()).split('·')[0]);
  expect(moved).not.toBe(before);

  await page.locator('.comp-row').nth(0).getByRole('button', { name: /Move .* later/ }).click();
  expect(money((await summary.innerText()).split('·')[0])).toBe(before);
});

test('the first step cannot move earlier, nor the last later', async ({ page, request }) => {
  await openRoute(page, request);
  const rows = page.locator('.comp-row');
  const last = (await rows.count()) - 1;
  await expect(rows.nth(0).getByRole('button', { name: /Move .* earlier/ })).toBeDisabled();
  await expect(rows.nth(last).getByRole('button', { name: /Move .* later/ })).toBeDisabled();
});

test('the sheet says how much has to be bought for one finished kilogram', async ({ page, request }) => {
  await openRoute(page, request);
  const summary = await page.getByText(/Rate works out at/).first().innerText();
  // With any loss anywhere on the route, more goes in than comes out.
  const kg = Number(summary.match(/needs\s+([\d.]+)\s*kg/)?.[1]);
  expect(kg).toBeGreaterThan(1);
});

test('the figure shown while typing is the one the server computes', async ({ page, request }) => {
  await openRoute(page, request);
  const summary = page.getByText(/Rate works out at/).first();

  // Change a loss, so the preview is showing something freshly derived rather
  // than whatever was last saved.
  const loss = page.getByRole('textbox', { name: /^Loss/ }).first();
  await loss.click();
  await loss.press('ControlOrMeta+a');
  await loss.pressSequentially('7.5', { delay: 40 });
  const preview = money((await summary.innerText()).split('·')[0]);

  const saved = page.waitForResponse((r) => r.url().includes('/api/costing/') && r.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Save changes' }).click();
  const res = await saved;
  const body = await res.json();
  expect(res.status(), JSON.stringify(body)).toBe(200);

  const fabric = body.result.blocks.find((b: { key: string }) => b.key === 'fabric');
  expect(fabric.lines[0].rate).toBeCloseTo(preview, 1);
});
