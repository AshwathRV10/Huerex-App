import { expect, test } from '@playwright/test';
import { USERS } from './config';

/**
 * Deleting an order — the one action in the application that destroys work
 * rather than recording it.
 *
 * What matters here is not that the button exists but that it is honest: it
 * says what will go before it goes, and an order carrying the floor's own
 * history cannot be removed by a misclick.
 */

test.describe('management, who may delete an order', () => {
  test.use({ storageState: USERS.manager.state });

  test('an order with history says exactly what would be lost, and holds the button',
    async ({ page }) => {
      await page.goto('/orders/HR-001');
      await page.getByRole('button', { name: 'Delete' }).click();

      const dialog = page.getByRole('dialog');
      await expect(dialog.getByText('This also deletes, permanently:')).toBeVisible();
      await expect(dialog.getByText(/\d+ cutting entries/)).toBeVisible();
      await expect(dialog.getByText(/no undo short of/)).toBeVisible();

      // Locked until the order number is typed back.
      const confirm = dialog.getByRole('button', { name: 'Delete permanently' });
      await expect(confirm).toBeDisabled();

      await dialog.getByLabel('Type HR-001 to confirm').fill('HR-00');
      await expect(confirm, 'a near-miss is not a confirmation').toBeDisabled();

      await dialog.getByLabel('Type HR-001 to confirm').fill('HR-001');
      await expect(confirm).toBeEnabled();

      // Leave it alone: the point was that it asks, not that it goes.
      await dialog.getByRole('button', { name: 'Keep the order' }).click();
      await expect(page.getByRole('heading', { name: 'HR-001' })).toBeVisible();
    });

  test('an order nobody has touched deletes without ceremony', async ({ page, request }) => {
    const made = await request.post('/api/orders', {
      data: {
        order_no: 'E2E-SPARE', buyer: 'BABY SHOP - VIGASH', style: 'never worked on',
        order_qty: 25, status: 'Active',
      },
    });
    expect(made.status(), await made.text()).toBe(201);

    await page.goto('/orders/E2E-SPARE');
    await page.getByRole('button', { name: 'Delete' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/only the order record itself goes/)).toBeVisible();
    await expect(dialog.getByLabel(/Type .* to confirm/)).toHaveCount(0);

    await dialog.getByRole('button', { name: 'Delete permanently' }).click();

    await expect(page).toHaveURL(/\/orders$/);
    expect((await request.get('/api/orders/E2E-SPARE')).status()).toBe(404);
  });
});

test.describe('a merchandiser, who runs the order book but may not delete', () => {
  test.use({ storageState: USERS.merch.state });

  test('is not offered the option at all', async ({ page }) => {
    await page.goto('/orders/HR-001');

    await expect(page.getByRole('heading', { name: 'HR-001' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0);
  });
});
