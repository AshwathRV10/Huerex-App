import { expect, test } from '@playwright/test';
import { USERS } from './config';

/**
 * Forgetting a remembered rate.
 *
 * The library fills itself from real work, so it also collects mistakes — a
 * rate typed against the wrong vendor, a starting point nobody will ever use.
 * Removing one changes nothing that has already been costed: every sheet keeps
 * the figure it was saved with. It only stops the number being offered again.
 */

test.describe('management, who may prune the library', () => {
  test.use({ storageState: USERS.manager.state });

  test('can forget a rate, and is told what that does and does not touch', async ({ page, request }) => {
    const before = await (await request.get('/api/rates')).json();
    const target = (before as { id: number; use_count: number }[])[0];
    expect(target, 'the seeded library should not be empty').toBeTruthy();

    await page.goto('/rates');
    const row = page.locator('table.data tbody tr').first();
    await expect(row).toBeVisible();

    await row.getByRole('button', { name: /^Forget/ }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/No cost sheet changes/)).toBeVisible();
    await expect(dialog.getByText(/keeps the rate it was saved with/)).toBeVisible();

    await dialog.getByRole('button', { name: 'Forget it' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    const after = await (await request.get('/api/rates')).json();
    expect((after as unknown[]).length).toBe((before as unknown[]).length - 1);
    expect((after as { id: number }[]).some((r) => r.id === target.id)).toBe(false);
  });
});

test.describe('a merchandiser, who sees no rates at all', () => {
  test.use({ storageState: USERS.merch.state });

  test('cannot reach the library, let alone empty it', async ({ page, request }) => {
    await page.goto('/rates');
    await expect(page.getByText('No access to this screen')).toBeVisible();

    const refused = await request.delete('/api/rates/1');
    expect(refused.status()).toBe(403);
  });
});
