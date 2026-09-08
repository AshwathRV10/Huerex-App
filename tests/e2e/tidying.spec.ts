import { expect, test } from '@playwright/test';
import { USERS } from './config';

/**
 * Tidying the lists and the roles, which only an administrator does.
 *
 * A master value reaches every screen at once — a colour is carried as plain
 * text onto cutting rows, cost sheets and the rate library alike — so renaming
 * or retiring one changes what is offered everywhere. Adding is open to anyone
 * who plans or logs work; tidying is the administrator's.
 *
 * Both routes existed on the server from the start and no screen ever offered
 * them, which is the same gap that left orders, rates and vendors uneditable.
 */

test.describe('an administrator', () => {
  test.use({ storageState: USERS.admin.state });

  test('can retire a value, and is told what that does to the entries using it', async ({ page }) => {
    await page.goto('/masters');
    const row = page.locator('table.data tbody tr').first();
    const value = (await row.locator('td').first().innerText()).trim();

    await row.getByRole('button', { name: 'Retire' }).click();
    await expect(page.getByRole('dialog')).toContainText('stays on the entries that already use it');
    await page.getByRole('button', { name: 'Retire', exact: true }).last().click();

    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('table.data tbody')).not.toContainText(value);
  });

  test('renaming warns that saved entries keep the old wording', async ({ page, request }) => {
    // A value added through the app counts as used from the moment it is
    // created, which is what makes the warning appear.
    const value = `E2E Rename ${Date.now().toString(36)}`;
    const made = await request.post('/api/masters', { data: { list_code: 'colours', value } });
    expect(made.status(), await made.text()).toBe(201);

    await page.goto('/masters');
    await page.getByPlaceholder('Search…').fill(value);
    const row = page.locator('table.data tbody tr').filter({ hasText: value });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Rename' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Those keep the old wording');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });

  test('a role nobody holds can be deleted', async ({ page, request }) => {
    const name = `E2E Spare ${Date.now().toString(36)}`;
    const made = await request.post('/api/roles', {
      data: { name, code: `e2e_${Date.now().toString(36)}`, description: 'made by a test', rank: 80, permissions: ['orders.view'] },
    });
    expect(made.status(), await made.text()).toBe(201);

    await page.goto('/users');
    await page.getByRole('tab', { name: 'Roles' }).click();
    const card = page.locator('.card').filter({ hasText: name });
    await card.getByRole('button', { name: 'Delete' }).click();

    await expect(page.getByRole('dialog')).toContainText('Nobody holds this role');
    await page.getByRole('button', { name: 'Delete', exact: true }).last().click();
    await expect(page.locator('.card').filter({ hasText: name })).toHaveCount(0);
  });

  test('a built-in role offers no delete at all', async ({ page }) => {
    await page.goto('/users');
    await page.getByRole('tab', { name: 'Roles' }).click();
    const builtIn = page.locator('.card').filter({ hasText: 'built-in' }).first();
    await expect(builtIn.getByRole('button', { name: 'Delete' })).toHaveCount(0);
  });
});

test.describe('a merchandiser, who may add to the lists but not tidy them', () => {
  test.use({ storageState: USERS.merch.state });

  test('sees the values with no rename or retire', async ({ page }) => {
    await page.goto('/masters');
    await expect(page.getByRole('button', { name: 'Add' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Rename' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Retire' })).toHaveCount(0);
  });
});
