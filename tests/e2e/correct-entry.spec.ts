import { expect, test } from '@playwright/test';
import { COSTED_ORDER, USERS } from './config';

/**
 * Correcting an entry that is already saved.
 *
 * Some of what a sheet records only becomes known later: trims are required
 * and received on the day they arrive, and issued to the floor a week
 * afterwards. Without this the only way to add the later figure was to delete
 * the receipt and type the whole thing again, losing the original entry and
 * its date along with it.
 */

test.describe('someone who may edit the sheet', () => {
  test.use({ storageState: USERS.manager.state });

  test('can add the issued quantity to a trim receipt logged earlier', async ({ page, request }) => {
    const made = await request.post('/api/trims/bulk', {
      data: {
        rows: [{
          order_no: COSTED_ORDER, txn_date: '2026-08-18', trim_item: 'E2E Hang Tag',
          required_qty: 1200, received_qty: 1230, issued_qty: 0, uom: 'pcs', supplier: 'YMG',
        }],
      },
    });
    expect(made.status(), await made.text()).toBeLessThan(400);

    await page.goto(`/trims?order=${COSTED_ORDER}`);
    await page.getByRole('tab', { name: /History/ }).click();

    const row = page.locator('table.data tbody tr').filter({ hasText: 'E2E Hang Tag' }).first();
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Edit' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // What was already recorded comes back as it was, rather than blank.
    await expect(dialog.getByLabel('Required')).toHaveValue('1200');
    await expect(dialog.getByLabel('Received')).toHaveValue('1230');

    await dialog.getByLabel('Issued').fill('900');
    await dialog.getByRole('button', { name: 'Save the correction' }).click();

    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(
      page.locator('table.data tbody tr').filter({ hasText: 'E2E Hang Tag' }).first(),
    ).toContainText('900');

    // The receipt is still the same row, not a replacement typed from scratch.
    const rows = await request.get(`/api/trims?order_no=${COSTED_ORDER}`);
    const body = await rows.json();
    const kept = (body.rows ?? body).filter((r: { trim_item: string }) => r.trim_item === 'E2E Hang Tag');
    expect(kept).toHaveLength(1);
    expect(kept[0].received_qty).toBe(1230);
    expect(kept[0].issued_qty).toBe(900);
  });
});

test.describe('someone who may read a sheet but not change it', () => {
  test.use({ storageState: USERS.merch.state });

  test('sees the entries and is not offered Edit', async ({ page }) => {
    // A merchandiser may look at job work but holds neither jobwork.edit nor
    // jobwork.delete, so the row actions have nothing to put in them.
    await page.goto(`/jobwork?order=${COSTED_ORDER}`);
    await page.getByRole('tab', { name: /History/ }).click();

    await expect(page.locator('table.data tbody tr').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  });
});
