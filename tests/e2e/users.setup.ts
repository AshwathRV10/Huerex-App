import { expect, request, test as setup } from '@playwright/test';
import { ADMIN_PW, BASE, USERS } from './config';

/**
 * Create the people the specs sign in as, and bank a signed-in session for
 * each so no test spends its time on a login form it is not testing.
 *
 * They are made through the real admin API, by an administrator, which means
 * the roles they end up with are the roles the application actually grants —
 * not a fixture's idea of them.
 */

setup('create the test users and bank their sessions', async () => {
  const admin = await request.newContext({ baseURL: BASE });

  const login = await admin.post('/api/auth/login', {
    data: { username: 'admin', password: ADMIN_PW },
  });
  expect(login.ok(), `admin sign-in failed: ${login.status()} ${await login.text()}`).toBeTruthy();

  for (const user of Object.values(USERS)) {
    const created = await admin.post('/api/users', {
      data: {
        username: user.username,
        full_name: user.full_name,
        email: '',
        roles: [user.role],
        is_active: 1,
        password: user.password,
        // The real first sign-in forces a password change, which is its own
        // screen. These accounts exist to reach the screens under test.
        must_change_pw: 0,
      },
    });
    expect(
      [201, 409].includes(created.status()),
      `could not create ${user.username}: ${created.status()} ${await created.text()}`,
    ).toBeTruthy();

    const ctx = await request.newContext({ baseURL: BASE });
    const signIn = await ctx.post('/api/auth/login', {
      data: { username: user.username, password: user.password },
    });
    expect(signIn.ok(), `${user.username} could not sign in`).toBeTruthy();
    await ctx.storageState({ path: user.state });
    await ctx.dispose();
  }

  await admin.dispose();
});
