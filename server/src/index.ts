import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { env } from './env.js';
import { migrate } from './db/migrate.js';
import { loadPrincipal, purgeExpiredSessions } from './auth/session.js';
import { HttpError } from './rbac/guard.js';
import { ALL_PERMISSIONS, assertKnownPermission } from './rbac/permissions.js';
import { scheduleBackups } from './jobs/backup.js';
import { registerAuth } from './modules/auth.js';
import { registerAdmin } from './modules/admin.js';
import { registerMasters } from './modules/masters.js';
import { registerOrders } from './modules/orders.js';
import { registerExecution } from './modules/execution.js';
import { registerReports } from './modules/reports.js';
import { registerCosting } from './modules/costing.js';
import { registerRates } from './modules/rates.js';
import { registerNotifications, sweepAlerts } from './modules/notifications.js';

const app = Fastify({
  logger: { level: env.logLevel, transport: env.isProd ? undefined : { target: 'pino-pretty' } },
  trustProxy: env.trustProxy,
  bodyLimit: 8 * 1024 * 1024,
});

// ---------------------------------------------------------------- security
await app.register(helmet, {
  // The SPA is served from the same origin and uses no third-party anything —
  // no CDN, no Google Fonts. That is what makes this policy tight enough to
  // be worth having, and it is why the fonts are self-hosted.
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      fontSrc: ["'self'"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],

      /**
       * Only behind TLS, and this one is not a nicety.
       *
       * Helmet adds `upgrade-insecure-requests` by default, which tells the
       * browser to rewrite every subresource request to https://. On a
       * plain-HTTP LAN the server does not speak https on that port, so the
       * page arrives, the tab title appears, and then every script and
       * stylesheet fails: a white screen with nothing to explain it.
       *
       * It does not happen on the machine running the server, because
       * browsers treat localhost as already secure and skip the upgrade — so
       * this breaks on every machine except the one it was tested on.
       */
      upgradeInsecureRequests: env.cookieSecure ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
  // HSTS is only meaningful behind TLS; on a plain LAN it would strand people.
  hsts: env.cookieSecure ? { maxAge: 31_536_000, includeSubDomains: true } : false,
});

await app.register(cookie, { parseOptions: { sameSite: 'lax' } });
await app.register(rateLimit, {
  global: false,
  max: 300,
  timeWindow: '1 minute',
  keyGenerator: (req) => req.ip,
});

// ------------------------------------------------------------ every request
app.addHook('onRequest', async (req) => {
  req.principal = loadPrincipal(req);
});

/**
 * A write with a session cookie must also carry a same-origin marker. Browsers
 * send SameSite=Lax cookies on top-level navigations, so a form post from
 * another site is the one hole worth closing explicitly.
 */
app.addHook('onRequest', async (req) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return;
  if (!req.url.startsWith('/api/')) return;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') {
    throw new HttpError(403, 'Cross-site request refused', 'cross_site');
  }
});

app.setErrorHandler((err, req, reply) => {
  if (err instanceof HttpError) {
    return reply.code(err.statusCode).send({ error: err.message, code: err.code });
  }
  const status = (err as { statusCode?: number }).statusCode ?? 500;
  if (status >= 500) req.log.error({ err }, 'request failed');
  return reply.code(status).send({
    error: status >= 500 ? 'Something went wrong at our end. The error has been logged.' : (err as Error).message,
    code: (err as { code?: string }).code,
  });
});

app.setNotFoundHandler((req, reply) => {
  if (req.url.startsWith('/api/')) {
    return reply.code(404).send({ error: 'No such endpoint', code: 'not_found' });
  }
  // Anything else is a client-side route: hand back the SPA shell.
  if (env.serveWeb && existsSync(join(env.webDist, 'index.html'))) {
    return reply.type('text/html').sendFile('index.html');
  }
  return reply.code(404).send({ error: 'Not found' });
});

// -------------------------------------------------------------------- routes
app.get('/api/health', async () => ({
  ok: true,
  version: '6.0.1',
  time: new Date().toISOString(),
}));

registerAuth(app);
registerMasters(app);
registerOrders(app);
registerExecution(app);
registerReports(app);
registerCosting(app);
registerRates(app);
registerNotifications(app);
registerAdmin(app);

// ------------------------------------------------------------- static files
if (env.serveWeb && existsSync(env.webDist)) {
  await app.register(fastifyStatic, {
    root: env.webDist,
    prefix: '/',
    // Hashed asset names can be cached hard; index.html must never be.
    setHeaders: (res, path) => {
      if (path.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
      else if (/\.[0-9a-f]{8,}\./.test(path)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    },
  });
}

// -------------------------------------------------------------------- start
async function start(): Promise<void> {
  console.log('HUEREX GFES v6');
  console.log('  database:', env.dbPath);
  migrate((m) => console.log(m));

  // Fail fast if a permission key was typo'd anywhere in the catalogue.
  for (const p of ALL_PERMISSIONS) assertKnownPermission(p);

  const purged = purgeExpiredSessions();
  if (purged) console.log(`  cleared ${purged} expired sessions`);

  scheduleBackups((m) => console.log(m));

  // Turn standing alerts into notifications, so a blocked order finds its
  // owner instead of waiting for somebody to open the alerts page.
  const sweep = setInterval(() => {
    try { sweepAlerts(); } catch (err) { app.log.error({ err }, 'alert sweep failed'); }
  }, 15 * 60_000);
  sweep.unref?.();
  setTimeout(() => { try { sweepAlerts(); } catch { /* first sweep is best effort */ } }, 5_000).unref?.();

  await app.listen({ host: env.host, port: env.port });
  console.log(`  listening on http://${env.host}:${env.port}`);
  if (env.serveWeb && !existsSync(env.webDist)) {
    console.log('  (web/dist not built yet — run "npm run build" to serve the app from this port)');
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    console.log(`\n${signal} — shutting down`);
    await app.close();
    process.exit(0);
  });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
