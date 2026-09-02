import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../env.js';
import { one, run } from '../db/index.js';
import { hashToken, newToken } from './password.js';
import { effectivePermissions, type Principal } from '../rbac/guard.js';

export function createSession(userId: number, req: FastifyRequest): string {
  const token = newToken(32);
  const id = hashToken(token);
  const expires = new Date(Date.now() + env.sessionTtlHours * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
  run(
    `INSERT INTO sessions (id, user_id, expires_at, ip, user_agent) VALUES (?,?,?,?,?)`,
    [id, userId, expires, req.ip ?? '', String(req.headers['user-agent'] ?? '').slice(0, 300)],
  );
  run(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`, [userId]);
  return token;
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(env.sessionCookie, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.cookieSecure,
    path: '/',
    maxAge: env.sessionTtlHours * 3600,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(env.sessionCookie, { path: '/' });
}

export function revokeSession(token: string): void {
  run(`UPDATE sessions SET revoked_at = datetime('now') WHERE id = ?`, [hashToken(token)]);
}

export function revokeAllForUser(userId: number): void {
  run(`UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL`, [userId]);
}

interface SessionRow {
  id: string; user_id: number; expires_at: string; last_seen_at: string;
  username: string; full_name: string; is_active: number;
}

/** Resolves the caller on every request. Silent on failure — the guards 401. */
export function loadPrincipal(req: FastifyRequest): Principal | undefined {
  const token = req.cookies?.[env.sessionCookie];
  if (!token) return undefined;
  const id = hashToken(token);

  const row = one<SessionRow>(
    `SELECT s.id, s.user_id, s.expires_at, s.last_seen_at,
            u.username, u.full_name, u.is_active
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.revoked_at IS NULL`,
    [id],
  );
  if (!row || !row.is_active) return undefined;

  const now = Date.now();
  if (new Date(`${row.expires_at}Z`).getTime() < now) return undefined;

  // Idle timeout: an unattended terminal on the floor should not stay open.
  const idleMs = now - new Date(`${row.last_seen_at}Z`).getTime();
  if (idleMs > env.sessionIdleMinutes * 60_000) {
    run(`UPDATE sessions SET revoked_at = datetime('now') WHERE id = ?`, [id]);
    return undefined;
  }
  run(`UPDATE sessions SET last_seen_at = datetime('now') WHERE id = ?`, [id]);

  const roles = (one<{ codes: string }>(
    `SELECT COALESCE(GROUP_CONCAT(r.code), '') codes
       FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?`,
    [row.user_id],
  )?.codes ?? '').split(',').filter(Boolean);

  return {
    userId: row.user_id,
    username: row.username,
    fullName: row.full_name,
    roles,
    permissions: effectivePermissions(row.user_id),
    sessionId: row.id,
  };
}

export function purgeExpiredSessions(): number {
  const r = run(`DELETE FROM sessions WHERE expires_at < datetime('now', '-7 day')`);
  return r.changes;
}
