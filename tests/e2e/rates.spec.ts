import { expect, test } from '@playwright/test';
import { PROPOSAL_ORDER, USERS } from './config';

/**
 * Starting-point rates, and the fact that they are never quietly mistaken for
 * quotes.
 *
 * A dozen rates ship with the application so the first cost sheet is not a
 * page of zeroes. Nobody has quoted them. The whole value of that convenience
 * depends on them being marked wherever they surface, which is what these
 * tests hold in place.
 */

test.use({ storageState: USERS.manager.state });

test('the rate library says which rates nobody has quoted', async ({ page }) => {
  await page.goto('/rates');

  await expect(page.getByRole('heading', { name: 'Rate library' })).toBeVisible();
  await expect(
    page.getByText(/starting points the app shipped with, not rates\s+anyone here has quoted/),
  ).toBeVisible();

  const badges = page.getByText('starting point', { exact: true });
  expect(await badges.count()).toBeGreaterThan(0);

  // A starting point has never been used, so it has no date to show and says
  // so, rather than showing a misleading "just now".
  await expect(page.getByText('shipped with the app').first()).toBeVisible();
});

test('the proposal counts the starting points before the sheet is built', async ({ page }) => {
  await page.goto(`/costing/${PROPOSAL_ORDER}`);

  await expect(page.getByText('This order has never been costed')).toBeVisible();
  await expect(page.getByText(/starting point/).first()).toBeVisible();
});

test('a field still holding a starting point is marked inside the sheet', async ({ page }) => {
  await page.goto(`/costing/${PROPOSAL_ORDER}`);
  await page.getByRole('button', { name: 'Start a cost sheet' }).click();

  await expect(page.getByText('Ordered', { exact: true })).toBeVisible();
  await expect(
    page.getByText('A starting point — replace with your real rate').first(),
  ).toBeVisible();
});
