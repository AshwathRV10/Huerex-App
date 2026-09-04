import { expect, test } from '@playwright/test';
import { USERS } from './config';

/**
 * Vendors, brought up to parity with buyers.
 *
 * Two defects, found on the same screen: no way to edit a vendor once saved,
 * and typing its name in the "Add a vendor" dialog accepted one character and
 * then stopped taking input until the field was clicked again.
 *
 * The typing defect came from where the form state lived. The vendor form was
 * the one modal in the app holding its state in the same component that
 * rendered the Modal, so every keystroke re-rendered that component, handed
 * Modal a fresh `onClose`, and retriggered the effect that focuses the dialog
 * shell — pulling focus off the field mid-word. Every other modal, buyers
 * included, keeps its form one component below; extracting VendorModal is
 * what fixes this screen. Modal was also changed to stop re-focusing on
 * re-render at all, so the trap is gone for good, but nothing left in the app
 * takes that path and no test here isolates it.
 *
 * `pressSequentially` is what catches the symptom: filling a field in one
 * call does not go through the character-by-character path a real keyboard
 * does, and passes either way.
 */

test.describe('someone who may manage vendors', () => {
  test.use({ storageState: USERS.manager.state });

  test('can type a full vendor name without the field losing focus mid-word', async ({ page }) => {
    await page.goto('/buyers');
    await page.getByRole('tab', { name: 'Vendors' }).click();
    await page.getByRole('button', { name: 'Add a vendor' }).click();

    const dialog = page.getByRole('dialog');
    // getByLabel matches a <label>'s raw text, which still includes the
    // aria-hidden asterisk on a required field ("Name *"); getByRole computes
    // the real accessible name, which correctly excludes it.
    const name = dialog.getByRole('textbox', { name: 'Name', exact: true });

    // A single fill() sets the value in one step; pressSequentially fires a
    // real keydown/input per character, which is the only way this bug shows.
    await name.pressSequentially('CRYSTAL EMBRO WORKS', { delay: 30 });
    await expect(name).toHaveValue('CRYSTAL EMBRO WORKS');
  });

  test('a saved vendor can be edited, and its name cannot', async ({ page, request }) => {
    const made = await request.post('/api/vendors', {
      data: { name: 'E2E VENDOR CO', processes: 'Print', contact: '9876543210' },
    });
    expect(made.status(), await made.text()).toBe(201);

    await page.goto('/buyers');
    await page.getByRole('tab', { name: 'Vendors' }).click();

    const row = page.locator('table.data tbody tr').filter({ hasText: 'E2E VENDOR CO' });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Edit' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Edit E2E VENDOR CO' })).toBeVisible();
    await expect(dialog.getByRole('textbox', { name: 'Name', exact: true })).toBeDisabled();

    await dialog.getByLabel('Processes').fill('Print, Embroidery');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await expect(
      page.locator('table.data tbody tr').filter({ hasText: 'E2E VENDOR CO' }),
    ).toContainText('Print, Embroidery');
  });
});

test.describe('a merchandiser, who may look but not touch', () => {
  test.use({ storageState: USERS.merch.state });

  test('sees the vendor list with no Add or Edit', async ({ page }) => {
    await page.goto('/buyers');
    await page.getByRole('tab', { name: 'Vendors' }).click();

    await expect(page.locator('table.data tbody tr').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add a vendor' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  });
});
