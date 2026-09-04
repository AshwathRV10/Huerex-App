import { expect, test } from '@playwright/test';
import { COSTED_ORDER, USERS } from './config';

/**
 * Dropdowns open where they can actually be read.
 *
 * The bulk entry grid scrolls sideways, because a twelve-column grid has to.
 * A menu positioned inside it was therefore clipped by it: the list opened
 * into a two-line slot and you had to scroll that slot to see the colours —
 * on the one screen where picking a colour quickly is the entire job.
 */

test.use({ storageState: USERS.manager.state });

test('a dropdown inside the entry grid is not trapped in the grid', async ({ page }) => {
  await page.goto(`/cutting?order=${COSTED_ORDER}`);
  await expect(page.locator('table.bulk')).toBeVisible();

  const colour = page.locator('table.bulk tbody tr').first().getByRole('combobox').first();
  await colour.click();

  const menu = page.locator('.combo-menu');
  await expect(menu).toBeVisible();

  // The proof: the menu is not a descendant of the scrolling grid, so nothing
  // can clip it.
  await expect(page.locator('.bulk-wrap .combo-menu')).toHaveCount(0);
});

test('the whole menu is on screen, and shows several options at once', async ({ page }) => {
  await page.goto(`/cutting?order=${COSTED_ORDER}`);
  await expect(page.locator('table.bulk')).toBeVisible();

  await page.locator('table.bulk tbody tr').first().getByRole('combobox').first().click();

  const menu = page.locator('.combo-menu');
  await expect(menu).toBeVisible();

  const box = (await menu.boundingBox())!;
  const view = page.viewportSize()!;

  expect(box.y, 'the menu must not run off the top').toBeGreaterThanOrEqual(0);
  expect(box.y + box.height, 'nor off the bottom').toBeLessThanOrEqual(view.height + 1);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(view.width + 1);

  // At least three options readable without scrolling the menu itself — the
  // failure being fixed showed barely two.
  const options = menu.getByRole('option');
  const count = await options.count();
  if (count >= 3) {
    const third = (await options.nth(2).boundingBox())!;
    expect(third.y + third.height,
      'the third option should sit inside the open menu, not below its edge')
      .toBeLessThanOrEqual(box.y + box.height + 1);
  }
});

test('picking an option still works, and the menu closes', async ({ page }) => {
  await page.goto(`/cutting?order=${COSTED_ORDER}`);
  await expect(page.locator('table.bulk')).toBeVisible();

  const colour = page.locator('table.bulk tbody tr').first().getByRole('combobox').first();
  await colour.click();

  const first = page.locator('.combo-menu').getByRole('option').first();
  // An option carries the value and, once it has been used, a count badge on
  // its own line. Only the first line is the value.
  const chosen = (await first.innerText()).split('\n')[0].trim();
  await first.click();

  await expect(page.locator('.combo-menu')).toHaveCount(0);
  await expect(colour).toHaveValue(chosen);
});

test('a dropdown inside a dialog is not hidden behind it', async ({ page }) => {
  await page.goto('/orders');
  await page.getByRole('button', { name: 'New order' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  await dialog.getByLabel('Buyer').click();

  const menu = page.locator('.combo-menu');
  await expect(menu).toBeVisible();

  // Portalled to the end of the document, the menu is a sibling of the dialog
  // rather than a child, so only z-index keeps it on top.
  const box = (await menu.boundingBox())!;
  const onTop = await page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y);
    return Boolean(el && el.closest('.combo-menu'));
  }, [box.x + box.width / 2, box.y + 12] as const);

  expect(onTop, 'the dialog must not paint over the open list').toBe(true);
});
