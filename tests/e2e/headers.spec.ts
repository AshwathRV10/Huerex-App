import { expect, test } from '@playwright/test';

/**
 * The response headers a LAN deployment actually gets.
 *
 * These are asserted on the header rather than by looking at the rendered
 * page, deliberately. Browsers treat localhost as a secure origin, so a
 * policy that breaks every other machine on the network renders perfectly
 * here — which is exactly how `upgrade-insecure-requests` reached a factory
 * floor and showed a white screen on every machine but the server's own.
 */

test('a plain-HTTP deployment does not ask browsers to upgrade its own assets',
  async ({ request }) => {
    const res = await request.get('/');
    expect(res.status()).toBe(200);

    const csp = res.headers()['content-security-policy'] ?? '';
    expect(csp, 'the policy is still worth having').toContain("script-src 'self'");

    // With this directive the browser rewrites every asset request to https://,
    // which a plain-HTTP server does not answer: the shell loads, the scripts
    // do not, and there is nothing on screen to say why.
    expect(csp, 'upgrade-insecure-requests strands a plain-HTTP LAN')
      .not.toContain('upgrade-insecure-requests');

    // HSTS would do the same thing to the next visit, and survive the fix.
    expect(res.headers()['strict-transport-security']).toBeUndefined();
  });

test('the scripts the shell asks for are actually served', async ({ request }) => {
  const html = await (await request.get('/')).text();

  const sources = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  expect(sources.length, 'the built shell should reference at least one script').toBeGreaterThan(0);

  for (const src of sources) {
    const res = await request.get(src);
    expect(res.status(), `${src} should be served`).toBe(200);
    expect(res.headers()['content-type'] ?? '').toContain('javascript');
  }
});
