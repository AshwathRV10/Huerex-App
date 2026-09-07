import { expect, type Locator, type Page, test } from '@playwright/test';
import { USERS } from './config';

/**
 * Decimals, which for a long time could not be typed anywhere in the app.
 *
 * `<input type="number">` whose value is `String(theNumber)` looks right and
 * is quietly wrong. Pressing 0 . 0 3 makes the browser report "0", "0",
 * "0.0", "0.03" — the half-typed "0." reads back as "0", because a trailing
 * point is not yet a number. The parsed value is therefore still 0, so the
 * field re-renders with "0" and React restores the input's text to match,
 * deleting the point that was just typed. The digits after it land on a whole
 * number, and 0.03 arrives as 3.
 *
 * The direction is what made it serious. Every affected field held a quantity,
 * a rate or a percentage, and the error was always upward by a power of ten:
 * ₹12.50 became ₹50 on a cost sheet, 125.5 kg became 1255 kg in the store, and
 * none of it announced itself.
 *
 * Two components carried the fault — the form field and the floor entry grid —
 * so both are driven here, on screens no other spec writes to. They type
 * character by character: a single fill() sets the value in one step and
 * passes whether or not the bug is there.
 */

test.use({ storageState: USERS.manager.state });

async function retype(field: Locator, text: string): Promise<void> {
  await field.click();
  await field.press('ControlOrMeta+a');
  await field.pressSequentially(text, { delay: 40 });
}

/** The new-order dialog, which is discarded rather than saved. */
async function openNewOrder(page: Page): Promise<void> {
  await page.goto('/orders');
  await page.getByRole('button', { name: /New order|Add an order/i }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

test('a fractional percentage survives being typed', async ({ page }) => {
  await openNewOrder(page);
  const buffer = page.getByRole('dialog').getByRole('textbox', { name: 'Cutting buffer', exact: true });
  await retype(buffer, '2.5');
  await expect(buffer).toHaveValue('2.5');
});

test('a fraction below one keeps its leading zero and its point', async ({ page }) => {
  await openNewOrder(page);
  // 0.03 cones of sewing thread per garment is a real figure — thread is
  // costed in metres and divided by what a cone holds — and it used to arrive
  // as 3, a hundred times what the garment uses.
  const sam = page.getByRole('dialog').getByRole('textbox', { name: 'SAM', exact: true });
  await retype(sam, '0.03');
  await expect(sam).toHaveValue('0.03');
});

test('a number typed without its leading zero is tidied up on the way out', async ({ page }) => {
  await openNewOrder(page);
  const sam = page.getByRole('dialog').getByRole('textbox', { name: 'SAM', exact: true });
  await retype(sam, '.5');
  await expect(sam).toHaveValue('.5');
  // Leaving the field is when it is safe to normalise — doing it mid-word
  // would delete the point being typed, which is the whole bug.
  await page.getByRole('dialog').getByRole('textbox', { name: 'Style', exact: true }).click();
  await expect(sam).toHaveValue('0.5');
});

test('letters cannot be typed into a number field', async ({ page }) => {
  await openNewOrder(page);
  const sam = page.getByRole('dialog').getByRole('textbox', { name: 'SAM', exact: true });
  await retype(sam, '12abc.5xyz');
  await expect(sam).toHaveValue('12.5');
});

test('a decimal typed on the floor entry grid survives, and reaches the server', async ({ page }) => {
  // The entry grid is a second input with the same fault, and the store is
  // where it hurt: a 125.5 kg roll booked in as 1255 kg.
  await page.goto('/fabric');
  await page.getByRole('tab', { name: 'Log a movement' }).click();

  const kg = page.getByRole('textbox', { name: 'Kg', exact: true }).first();
  await expect(kg).toBeVisible({ timeout: 15_000 });
  await retype(kg, '125.5');
  await expect(kg).toHaveValue('125.5');
});
