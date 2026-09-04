import { expect, test } from '@playwright/test';
import { COSTED_ORDER, USERS } from './config';

/**
 * Header rows stay put while the rows scroll under them.
 *
 * The headers always declared `position: sticky`, and it did nothing: a
 * wrapper with `overflow` becomes the scrollport a sticky element answers to,
 * and these wrappers had no height, so the page scrolled instead and the
 * header went with it. These tests scroll a real table and check the header is
 * still there, which is the only way to tell the difference.
 */

test.use({ storageState: USERS.manager.state });

async function scrollAndCheck(page: import('@playwright/test').Page, wrap: string) {
  const container = page.locator(wrap).first();
  const header = container.locator('thead th').first();

  await expect(header).toBeVisible();
  const before = (await header.boundingBox())!;

  // Scroll inside the table, not the page.
  await container.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(150);

  const after = (await header.boundingBox())!;
  expect(after.y, 'the header should not move when the rows scroll under it')
    .toBeCloseTo(before.y, 0);
  await expect(header, 'and it should still be on screen').toBeVisible();
}

test('a history table keeps its headers while the rows scroll', async ({ page }) => {
  await page.goto(`/jobwork?order=${COSTED_ORDER}`);
  await page.getByRole('tab', { name: /History/ }).click();
  await expect(page.locator('table.data tbody tr').first()).toBeVisible();

  // The wrapper has to be a real scroller, or sticky has nothing to hold on to.
  const scrolls = await page.locator('.table-wrap').first()
    .evaluate((el) => el.scrollHeight > el.clientHeight);
  expect(scrolls, 'the table should scroll inside its own box').toBe(true);

  await scrollAndCheck(page, '.table-wrap');
});

test('the rate library keeps its headers too', async ({ page }) => {
  // A short window, so the library is certain to overflow its box. Without it
  // the seeded list fits on screen and the test proves nothing.
  await page.setViewportSize({ width: 1280, height: 560 });
  await page.goto('/rates');
  await expect(page.locator('table.data tbody tr').first()).toBeVisible();

  const scrolls = await page.locator('.table-wrap').first()
    .evaluate((el) => el.scrollHeight > el.clientHeight);
  expect(scrolls, 'the table should scroll inside its own box').toBe(true);

  await scrollAndCheck(page, '.table-wrap');
});

test('the entry grid keeps its headers', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 560 });
  await page.goto(`/cutting?order=${COSTED_ORDER}`);
  await expect(page.locator('table.bulk')).toBeVisible();

  // Enough rows that the grid has to scroll, the way it does after a morning
  // of cutting entries.
  const add = page.getByRole('button', { name: '+ Add row' });
  for (let i = 0; i < 12; i += 1) await add.click();

  const scrolls = await page.locator('.bulk-wrap')
    .evaluate((el) => el.scrollHeight > el.clientHeight);
  expect(scrolls, 'the grid should scroll inside its own box').toBe(true);

  await scrollAndCheck(page, '.bulk-wrap');
});

/**
 * The mobile-only subtitle stays on mobile.
 *
 * `.stacked-only` carries the colour and size on a phone, where the table has
 * collapsed to cards and its own column is gone. On a desk it must not appear,
 * or every row reads its colour out twice. It lost that argument once already:
 * `table.data .cell-sub` is the more specific selector, so it won on
 * specificity no matter the order of the files.
 */
test('a wide table does not repeat the colour and size on a desk screen', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/wip');
  await expect(page.locator('table.data tbody tr').first()).toBeVisible();

  const hidden = await page.locator('.stacked-only').first()
    .evaluate((el) => getComputedStyle(el).display);
  expect(hidden, 'the stacked-card subtitle belongs to phones').toBe('none');
});
