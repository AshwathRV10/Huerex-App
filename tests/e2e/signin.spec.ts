import { expect, test } from '@playwright/test';
import { ADMIN_PW, USERS } from './config';

/**
 * Sign-in, driven the way a person does it.
 *
 * This is the one test that uses no banked session, because it is the thing
 * being tested — and because it proves the whole stack end to end: the SPA is
 * served by the same process as the API, the session cookie comes back, and
 * the browser is let through on the strength of it.
 */

test.use({ storageState: { cookies: [], origins: [] } });

test('a wrong password is refused, in words', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Username').fill(USERS.manager.username);
  await page.getByLabel('Password').fill('not the password');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByText('That username and password do not match')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});

test('signing in reaches a working screen', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Username').fill(USERS.manager.username);
  await page.getByLabel('Password').fill(USERS.manager.password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // The sign-in card carries its own h1, so the proof of being through is the
  // application shell: the navigation rail only exists once there is a session.
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

test('the temporary password has to be replaced before anything else', async ({ page }) => {
  // The seeded administrator is created with must_change_pw set, so the app
  // must refuse to show a single screen until it is changed. Everyone else in
  // this suite was created past that point deliberately.
  await page.goto('/');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password').fill(ADMIN_PW);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('heading', { name: 'Choose your own password' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Sections' })).toHaveCount(0);
});
