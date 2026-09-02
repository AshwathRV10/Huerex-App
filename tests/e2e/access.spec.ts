import { expect, test } from '@playwright/test';
import { USERS } from './config';

/**
 * What the browser does with a permission it does not have.
 *
 * The server-side proof lives in `npm run test:rbac`, which checks that
 * restricted figures never leave the machine. These tests check the other
 * half: that the screen a person actually gets is an honest one — a plain
 * explanation rather than a blank page, and the word "Restricted" rather than
 * an empty cell that reads like a zero.
 */

test.describe('a merchandiser, who sees no money', () => {
  test.use({ storageState: USERS.merch.state });

  test('is told plainly that costing is not part of their role', async ({ page }) => {
    await page.goto('/costing');

    await expect(page.getByRole('heading', { name: 'Restricted' })).toBeVisible();
    await expect(page.getByText('No access to this screen')).toBeVisible();
    // Not a dead end: it says who can change it.
    await expect(page.getByText(/an administrator\s+can add it to your role/)).toBeVisible();
  });

  test('gets the operational half of the buyer summary and none of the commercial half',
    async ({ page }) => {
      await page.goto('/buyer-summary');

      await expect(page.getByRole('heading', { name: 'Buyer summary' })).toBeVisible();
      await expect(page.getByText('Committed', { exact: true }).first()).toBeVisible();
      await expect(page.getByText('Shipped', { exact: true }).first()).toBeVisible();

      // The money is not hidden with CSS — it is not on the page.
      await expect(page.getByText('Margin', { exact: true })).toHaveCount(0);
      await expect(page.getByText('Order value', { exact: true })).toHaveCount(0);
    });

  test('cannot reach the rate library by typing its address', async ({ page }) => {
    await page.goto('/rates');
    await expect(page.getByText('No access to this screen')).toBeVisible();
  });
});

test.describe('a store keeper, who may see fabric but not what it cost', () => {
  test.use({ storageState: USERS.store.state });

  test('sees the stock, with the rate shown as restricted rather than blank',
    async ({ page }) => {
      await page.goto('/fabric');

      await expect(page.getByRole('heading', { name: /fabric/i }).first()).toBeVisible();
      await expect(page.getByText('Restricted').first()).toBeVisible();
    });
});
