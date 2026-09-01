import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { all, one, run } from '../db/index.js';
import { env } from '../env.js';
import { audit, auditAnon } from '../audit/index.js';
import { checkPasswordStrength, hashPassword, verifyPassword } from '../auth/password.js';
import { clearSessionCookie, createSession, revokeAllForUser, revokeSession, setSessionCookie } from '../auth/session.js';
import { generateSecret, otpauthUrl, verifyTotp } from '../auth/totp.js';
import { MODULES } from '../rbac/permissions.js';
import { effectivePermissions, requireAuth } from '../rbac/guard.js';
import { HttpError, clientIp, parse, zText } from '../lib/http.js';

interface UserRow {
  id: number; username: string; full_name: string; email: string | null;
  password_hash: string; totp_secret: string | null; totp_enabled: number;
  must_change_pw: number; is_active: number; failed_attempts: number; locked_until: string | null;
}

const Login = z.object({
  username: zText(80).min(1, 'enter your username'),
  password: z.string().min(1, 'enter your password'),
  totp: z.string().optional(),
});

function lockedFor(user: UserRow): number {
  if (!user.locked_until) return 0;
  const ms = new Date(`${user.locked_until}Z`).getTime() - Date.now();
  return ms > 0 ? Math.ceil(ms / 60_000) : 0;
}

export function registerAuth(app: FastifyInstance): void {
  app.post('/api/auth/login', {
    config: { rateLimit: { max: 20, timeWindow: '5 minutes' } },
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const body = parse(Login, req.body);
    const ip = clientIp(req);
    const user = one<UserRow>('SELECT * FROM users WHERE username = ? COLLATE NOCASE', [body.username]);

    // The same message and roughly the same work either way, so a wrong
    // username cannot be told apart from a wrong password.
    const fail = (reason: string): never => {
      auditAnon(body.username, 'login_failed', 'users', reason, ip);
      throw new HttpError(401, 'That username and password do not match', 'bad_credentials');
    };

    if (!user) {
      await verifyPassword('$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', body.password);
      return fail('no such user');
    }
    if (!user.is_active) return fail('account disabled');

    const minutes = lockedFor(user);
    if (minutes > 0) {
      auditAnon(body.username, 'login_failed', 'users', 'locked out', ip);
      throw new HttpError(423, `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`, 'locked');
    }

    const ok = await verifyPassword(user.password_hash, body.password);
    if (!ok) {
      const attempts = user.failed_attempts + 1;
      if (attempts >= env.maxLoginAttempts) {
        run(
          `UPDATE users SET failed_attempts = 0, locked_until = datetime('now', ?) WHERE id = ?`,
          [`+${env.lockoutMinutes} minutes`, user.id],
        );
        auditAnon(body.username, 'lockout', 'users', `Locked for ${env.lockoutMinutes} minutes`, ip, 'critical');
        throw new HttpError(423, `Too many attempts. Try again in ${env.lockoutMinutes} minutes.`, 'locked');
      }
      run('UPDATE users SET failed_attempts = ? WHERE id = ?', [attempts, user.id]);
      return fail('wrong password');
    }

    if (user.totp_enabled) {
      if (!body.totp) {
        return reply.code(200).send({ needsTotp: true });
      }
      if (!user.totp_secret || !verifyTotp(user.totp_secret, body.totp)) {
        auditAnon(body.username, 'login_failed', 'users', 'bad 2FA code', ip);
        throw new HttpError(401, 'That code is not right. Check the app and try the next one.', 'bad_totp');
      }
    }

    run('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?', [user.id]);
    const token = createSession(user.id, req);
    setSessionCookie(reply, token);
    audit({ ...req, principal: { userId: user.id, username: user.username, fullName: user.full_name, roles: [], permissions: new Set(), sessionId: '' } } as FastifyRequest, {
      action: 'login', entity: 'users', entityId: user.id, summary: `${user.username} signed in`,
    });

    return reply.send({
      user: sessionPayload(user.id),
      mustChangePassword: Boolean(user.must_change_pw),
    });
  });

  app.post('/api/auth/logout', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.cookies?.[env.sessionCookie];
    if (token) revokeSession(token);
    if (req.principal) {
      audit(req, { action: 'logout', entity: 'users', entityId: req.principal.userId, summary: `${req.principal.username} signed out` });
    }
    clearSessionCookie(reply);
    return reply.send({ ok: true });
  });

  app.get('/api/auth/me', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.principal) return reply.code(401).send({ error: 'Not signed in', code: 'unauthenticated' });
    return reply.send(sessionPayload(req.principal.userId));
  });

  /** The permission catalogue, so the UI can lay out the roles screen. */
  app.get('/api/auth/catalogue', { preHandler: requireAuth() }, async (_req, reply) =>
    reply.send({ modules: MODULES }));

  app.post('/api/auth/password', { preHandler: requireAuth() }, async (req: FastifyRequest, reply: FastifyReply) => {
    const body = parse(z.object({
      current_password: z.string().min(1),
      new_password: z.string().min(1),
    }), req.body);
    const user = one<UserRow>('SELECT * FROM users WHERE id = ?', [req.principal!.userId])!;
    if (!await verifyPassword(user.password_hash, body.current_password)) {
      throw new HttpError(401, 'Your current password is not right', 'bad_credentials');
    }
    const strength = checkPasswordStrength(body.new_password, user.username);
    if (!strength.ok) throw new HttpError(400, `The new password ${strength.problems.join(', ')}`, 'weak_password');

    run(
      `UPDATE users SET password_hash = ?, must_change_pw = 0, updated_at = datetime('now') WHERE id = ?`,
      [await hashPassword(body.new_password), user.id],
    );
    // Everything except the session doing the changing is signed out.
    run(
      `UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ? AND id <> ? AND revoked_at IS NULL`,
      [user.id, req.principal!.sessionId],
    );
    audit(req, { action: 'password_change', entity: 'users', entityId: user.id, summary: 'Changed own password', severity: 'notice' });
    return reply.send({ ok: true });
  });

  // ------------------------------------------------------------------- 2FA
  app.post('/api/auth/totp/start', { preHandler: requireAuth() }, async (req: FastifyRequest, reply: FastifyReply) => {
    const user = one<UserRow>('SELECT * FROM users WHERE id = ?', [req.principal!.userId])!;
    const secret = generateSecret();
    run('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?', [secret, user.id]);
    return reply.send({ secret, url: otpauthUrl(user.username, secret) });
  });

  app.post('/api/auth/totp/confirm', { preHandler: requireAuth() }, async (req: FastifyRequest, reply: FastifyReply) => {
    const body = parse(z.object({ code: z.string().min(6).max(6) }), req.body);
    const user = one<UserRow>('SELECT * FROM users WHERE id = ?', [req.principal!.userId])!;
    if (!user.totp_secret || !verifyTotp(user.totp_secret, body.code)) {
      throw new HttpError(400, 'That code is not right. Try the next one the app shows.', 'bad_totp');
    }
    run('UPDATE users SET totp_enabled = 1 WHERE id = ?', [user.id]);
    audit(req, { action: 'update', entity: 'users', entityId: user.id, summary: 'Turned on two-factor sign-in', severity: 'notice' });
    return reply.send({ ok: true });
  });

  app.post('/api/auth/totp/off', { preHandler: requireAuth() }, async (req: FastifyRequest, reply: FastifyReply) => {
    const body = parse(z.object({ password: z.string().min(1) }), req.body);
    const user = one<UserRow>('SELECT * FROM users WHERE id = ?', [req.principal!.userId])!;
    if (!await verifyPassword(user.password_hash, body.password)) {
      throw new HttpError(401, 'That password is not right', 'bad_credentials');
    }
    run('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?', [user.id]);
    audit(req, { action: 'update', entity: 'users', entityId: user.id, summary: 'Turned off two-factor sign-in', severity: 'warning' });
    return reply.send({ ok: true });
  });

  app.get('/api/auth/sessions', { preHandler: requireAuth() }, async (req: FastifyRequest, reply: FastifyReply) => {
    const rows = all(
      `SELECT id, created_at, last_seen_at, expires_at, ip, user_agent,
              CASE WHEN id = ? THEN 1 ELSE 0 END AS is_current
         FROM sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY last_seen_at DESC`,
      [req.principal!.sessionId, req.principal!.userId],
    );
    return reply.send({ rows });
  });

  app.post('/api/auth/sessions/revoke-others', { preHandler: requireAuth() }, async (req: FastifyRequest, reply: FastifyReply) => {
    run(
      `UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ? AND id <> ? AND revoked_at IS NULL`,
      [req.principal!.userId, req.principal!.sessionId],
    );
    audit(req, { action: 'logout', entity: 'sessions', summary: 'Signed out every other device', severity: 'notice' });
    return reply.send({ ok: true });
  });
}

export function sessionPayload(userId: number) {
  const user = one<UserRow>('SELECT * FROM users WHERE id = ?', [userId])!;
  const roles = all<{ code: string; name: string }>(
    'SELECT r.code, r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?',
    [userId],
  );
  return {
    id: user.id,
    username: user.username,
    full_name: user.full_name,
    email: user.email,
    totp_enabled: Boolean(user.totp_enabled),
    must_change_password: Boolean(user.must_change_pw),
    roles: roles.map((r) => r.code),
    role_names: roles.map((r) => r.name),
    permissions: [...effectivePermissions(userId)],
  };
}

export { revokeAllForUser };
