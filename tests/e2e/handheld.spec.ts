import { expect, test } from '@playwright/test';
import { COSTED_ORDER, USERS } from './config';

/**
 * The floor, on the device the floor actually has.
 *
 * A twelve-column table on a 390px screen means scrolling sideways to fill in
 * a single entry, which is how a floor system ends up being filled in later,
 * from memory, at a desk. Below the breakpoint the grid becomes one card per
 * entry and Save moves under the thumb — and this is the only test that can
 * prove it, because the choice is made in JavaScript rather than in CSS.
 */

test.use({ storageState: USERS.manager.state });

test('the cutting grid becomes one card per entry', async ({ page }) => {
  await page.goto(`/cutting?order=${COSTED_ORDER}`);

  await expect(page.getByRole('heading', { name: /cutting/i }).first()).toBeVisible();

  // One card, not a row in a wide table.
  await expect(page.locator('.entry-card').first()).toBeVisible();
  await expect(page.locator('table.bulk')).toHaveCount(0);

  // Every field of the entry is reachable without scrolling sideways.
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  const viewport = page.viewportSize()!.width;
  expect(width, 'the page must not scroll sideways on a phone').toBeLessThanOrEqual(viewport + 1);
});

test('Save sits in a fixed bar under the thumb', async ({ page }) => {
  await page.goto(`/cutting?order=${COSTED_ORDER}`);

  const bar = page.locator('.action-bar');
  await expect(bar).toBeVisible();

  const box = (await bar.boundingBox())!;
  const height = page.viewportSize()!.height;
  expect(box.y + box.height, 'the action bar should sit at the bottom of the screen')
    .toBeGreaterThan(height - 120);

  // The desk layout's own Clear/Save pair is not also on screen competing for
  // the thumb — there is exactly one Save on a phone.
  const visibleSaves = page.getByRole('button', { name: /^Save/ });
  await expect(visibleSaves).toHaveCount(1);
});
