import type { FastifyReply, FastifyRequest } from 'fastify';
import { all } from '../db/index.js';
import { assertKnownPermission } from './permissions.js';

export interface Principal {
  userId: number;
  username: string;
  fullName: string;
  roles: string[];
  permissions: Set<string>;
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

/**
 * Effective permissions = union of role grants, minus per-user denies, plus
 * per-user allows. A deny always beats an allow — that is what makes
 * least-privilege carve-outs safe to hand to a manager.
 */
export function effectivePermissions(userId: number): Set<string> {
  const granted = all<{ perm_key: string }>(
    `SELECT DISTINCT rp.perm_key
       FROM user_roles ur
       JOIN role_permissions rp ON rp.role_id = ur.role_id
      WHERE ur.user_id = ?`,
    [userId],
  ).map((r) => r.perm_key);

  const overrides = all<{ perm_key: string; effect: string }>(
    'SELECT perm_key, effect FROM user_permission_overrides WHERE user_id = ?',
    [userId],
  );

  const set = new Set(granted);
  for (const o of overrides) if (o.effect === 'allow') set.add(o.perm_key);
  for (const o of overrides) if (o.effect === 'deny') set.delete(o.perm_key);
  return set;
}

export class HttpError extends Error {
  constructor(public statusCode: number, message: string, public code?: string) {
    super(message);
  }
}

export function can(req: FastifyRequest, perm: string): boolean {
  assertKnownPermission(perm);
  return req.principal?.permissions.has(perm) ?? false;
}

export function canAny(req: FastifyRequest, perms: string[]): boolean {
  return perms.some((p) => can(req, p));
}

/** Throws 401 when unauthenticated and 403 when merely unauthorized. */
export function requirePermission(perm: string) {
  assertKnownPermission(perm);
  return async function guard(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (!req.principal) throw new HttpError(401, 'Sign in to continue', 'unauthenticated');
    if (!req.principal.permissions.has(perm)) {
      throw new HttpError(403, 'You do not have access to this', 'forbidden');
    }
  };
}

export function requireAuth() {
  return async function guard(req: FastifyRequest): Promise<void> {
    if (!req.principal) throw new HttpError(401, 'Sign in to continue', 'unauthenticated');
  };
}

export function assertPermission(req: FastifyRequest, perm: string): void {
  if (!req.principal) throw new HttpError(401, 'Sign in to continue', 'unauthenticated');
  if (!can(req, perm)) throw new HttpError(403, 'You do not have access to this', 'forbidden');
}
