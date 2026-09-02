import { expect, type Page, test } from '@playwright/test';
import { COSTED_ORDER, USERS } from './config';

/**
 * The cost sheet, which is the reason this application exists.
 *
 * The quantity model is what these tests are really guarding. Four different
 * numbers govern a costing — what was ordered, what ships, what is invoiced
 * and what the floor must actually make — and getting any of them wrong is
 * the kind of mistake that only shows up in a quarter's margin. The
 * relationships between them are asserted from what the screen shows, so the
 * test holds for any order rather than one memorised set of figures.
 */

test.use({ storageState: USERS.manager.state });

/** Read one of the five figures out of the quantity strip. */
async function stat(page: Page, label: string): Promise<number> {
  const value = page.locator('.stat', { has: page.getByText(label, { exact: true }) })
    .locator('.stat-value').first();
  const text = await value.innerText();
  return Number(text.replace(/[^0-9.-]/g, ''));
}

/**
 * Save, and wait for the sheet to come back recomputed.
 *
 * The quantity strip is worked out by the costing engine on the server — the
 * same code the engine tests cover — rather than duplicated in the browser, so
 * it answers on save rather than on each keystroke.
 */
async function save(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible();
}

test('an uncosted order can be costed, and the quantities hold together', async ({ page }) => {
  await page.goto(`/costing/${COSTED_ORDER}`);

  await expect(page.getByRole('heading', { name: `Cost ${COSTED_ORDER}` })).toBeVisible();
  await expect(page.getByText('This order has never been costed')).toBeVisible();

  await page.getByRole('button', { name: 'Start a cost sheet' }).click();

  // The proposal fills the sheet in from the order's own route and the rate
  // library, so the quantity strip is live the moment the sheet exists.
  await expect(page.getByText('Ordered', { exact: true })).toBeVisible();

  const ordered = await stat(page, 'Ordered');
  const excess = await stat(page, 'Excess');
  const ships = await stat(page, 'Ships');
  const invoiced = await stat(page, 'Invoiced');
  const made = await stat(page, 'Must be made');

  expect(ordered).toBeGreaterThan(0);

  // Excess ships in the same cartons as the order.
  expect(ships).toBe(ordered + excess);

  // Whether it earns money is the buyer's rule, so invoiced is one or the other
  // — never something in between.
  expect([ordered, ships]).toContain(invoiced);

  // Rejection is made and paid for and never leaves, so the floor must always
  // make at least what ships.
  expect(made).toBeGreaterThanOrEqual(ships);
});

test('the excess percentage flows through to what ships and what is invoiced',
  async ({ page }) => {
    await page.goto(`/costing/${COSTED_ORDER}`);

    const start = page.getByRole('button', { name: 'Start a cost sheet' });
    if (await start.isVisible().catch(() => false)) await start.click();

    await expect(page.getByText('Ordered', { exact: true })).toBeVisible();
    const ordered = await stat(page, 'Ordered');

    await page.getByLabel('Excess %').fill('10');
    await save(page);

    // The arithmetic itself lives on the server, so the strip answers once the
    // sheet is saved rather than on each keystroke.
    const excess = Math.round(ordered * 0.1);
    expect(await stat(page, 'Excess')).toBe(excess);
    expect(await stat(page, 'Ships'), 'excess ships in the same cartons')
      .toBe(ordered + excess);

    // These buyers are all set to invoice their excess, so it earns money.
    expect(await stat(page, 'Invoiced')).toBe(ordered + excess);
  });

test('excess the buyer does not pay for is shipped but not invoiced', async ({ page }) => {
  await page.goto(`/costing/${COSTED_ORDER}`);

  const start = page.getByRole('button', { name: 'Start a cost sheet' });
  if (await start.isVisible().catch(() => false)) await start.click();

  await expect(page.getByText('Ordered', { exact: true })).toBeVisible();
  const ordered = await stat(page, 'Ordered');

  await page.getByLabel('Excess %').fill('10');
  await page.getByText('Yes — invoiced').click();
  await save(page);

  const excess = Math.round(ordered * 0.1);
  expect(await stat(page, 'Ships')).toBe(ordered + excess);
  expect(await stat(page, 'Invoiced'), 'free excess is made and shipped, and earns nothing')
    .toBe(ordered);
});

test('a rejection allowance raises what the floor must make', async ({ page }) => {
  await page.goto(`/costing/${COSTED_ORDER}`);

  const start = page.getByRole('button', { name: 'Start a cost sheet' });
  if (await start.isVisible().catch(() => false)) await start.click();

  await expect(page.getByText('Ordered', { exact: true })).toBeVisible();

  await page.getByLabel('Rejection allowance %').fill('0');
  await save(page);
  expect(await stat(page, 'Must be made')).toBe(await stat(page, 'Ships'));

  await page.getByLabel('Rejection allowance %').fill('5');
  await save(page);
  expect(
    await stat(page, 'Must be made'),
    'pieces allowed for rejection are made and paid for and never ship',
  ).toBeGreaterThan(await stat(page, 'Ships'));
});
