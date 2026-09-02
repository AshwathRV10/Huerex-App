import { defineConfig, devices } from '@playwright/test';
import { BASE, DB_PATH, PORT, USERS } from './tests/e2e/config';

/**
 * Browser tests, against the built application.
 *
 * These drive `server/dist/index.js` serving the built SPA — the same single
 * process the factory runs — rather than a dev server, so what passes here is
 * what ships. The engine tests prove the arithmetic and `test:rbac` proves
 * the permission model on the wire; this proves the part only a browser can:
 * that the screens work, and work on the device the floor actually holds.
 */

export default defineConfig({
  testDir: './tests/e2e',

  // One server, one database, so the specs run in a known order against known
  // seeded state rather than racing each other through it.
  fullyParallel: false,
  workers: 1,

  timeout: 30_000,
  expect: { timeout: 7_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: BASE,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: process.env.CI ? 'retain-on-failure' : 'off',
    // An escape hatch for a machine that already has a browser and cannot
    // download one — a locked-down factory box, or a sandbox.
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } }
      : {}),
  },

  projects: [
    { name: 'setup', testMatch: /users\.setup\.ts/ },
    {
      name: 'desk',
      dependencies: ['setup'],
      testIgnore: [/users\.setup\.ts/, /handheld\.spec\.ts/],
      use: { ...devices['Desktop Chrome'], storageState: USERS.manager.state },
    },
    {
      name: 'phone',
      dependencies: ['setup'],
      testMatch: /handheld\.spec\.ts/,
      // The breakpoint under test is 760px for the grid and 900px for the
      // action bar; 390 × 844 is a phone that is under both.
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        storageState: USERS.manager.state,
      },
    },
  ],

  webServer: {
    // The reseed is part of the launch, not a separate setup step: Playwright
    // starts the web server before any global setup runs, so anything that
    // replaced the database afterwards would leave the server holding a file
    // that no longer exists.
    command: 'node tests/e2e/seed.mjs && node server/dist/index.js',
    url: `${BASE}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      DB_PATH,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      // Plain HTTP: a Secure cookie would never come back and every sign-in
      // would fail for a reason that has nothing to do with the code.
      COOKIE_SECURE: 'false',
      SERVE_WEB: 'true',
      BACKUP_ENABLED: 'false',
      LOG_LEVEL: 'warn',
    },
  },
});
