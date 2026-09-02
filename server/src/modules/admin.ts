import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { all, one, run, tx } from '../db/index.js';
import { audit, queryAudit } from '../audit/index.js';
import { assertPermission } from '../rbac/guard.js';
import { checkPasswordStrength, hashPassword, newToken } from '../auth/password.js';
import { revokeAllForUser } from '../auth/session.js';
import { ALL_PERMISSIONS, MODULES, isKnownPermission } from '../rbac/permissions.js';
import { HttpError, parse, sendCsv, zText } from '../lib/http.js';
import { runBackup, listBackups, backupStatus } from '../jobs/backup.js';
import { sweepAlerts } from './notifications.js';

/**
 * Users, roles, the audit log and the settings screen.
 *
 * Two rules are enforced here rather than left to good manners:
 * nobody can grant a permission they do not themselves hold, and the last
 * administrator cannot be disabled or stripped of their role. Both are the
 * kind of thing that is discovered at the worst possible moment otherwise.
 */

function assertNotEscalating(req: FastifyRequest, perms: string[]): void {
  const mine = req.principal!.permissions;
  const beyond = perms.filter((p) => !mine.has(p));
  if (beyond.length > 0) {
    throw new HttpError(
      403,
      `You cannot grant access you do not have yourself: ${beyond.slice(0, 5).join(', ')}${beyond.length > 5 ? ` and ${beyond.length - 5} more` : ''}`,
      'escalation',
    );
  }
}

function adminCount(excludeUserId?: number): number {
  return one<{ c: number }>(
    `SELECT COUNT(DISTINCT u.id) AS c FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
      WHERE r.code = 'admin' AND u.is_active = 1 AND (? IS NULL OR u.id <> ?)`,
    [excludeUserId ?? null, excludeUserId ?? null],
  )!.c;
}

export function registerAdmin(app: FastifyInstance): void {
  // ------------------------------------------------------------------ users
  app.get('/api/users', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'users.view');
    const rows = all(
      `SELECT u.id, u.username, u.full_name, u.email, u.is_active, u.totp_enabled,
              u.must_change_pw, u.last_login_at, u.created_at, u.locked_until,
              COALESCE(GROUP_CONCAT(r.code), '') AS roles,
              COALESCE(GROUP_CONCAT(r.name, ' · '), '') AS role_names
         FROM users u
         LEFT JOIN user_roles ur ON ur.user_id = u.id
         LEFT JOIN roles r ON r.id = ur.role_id
        GROUP BY u.id ORDER BY u.is_active DESC, u.full_name`,
    ).map((u) => ({
      ...(u as Record<string, unknown>),
      roles: String((u as { roles: string }).roles).split(',').filter(Boolean),
    }));
    return reply.send({ rows });
  });

  app.get('/api/users/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'users.view');
    const id = Number((req.params as { id: string }).id);
    const user = one('SELECT id, username, full_name, email, is_active, totp_enabled, must_change_pw, last_login_at FROM users WHERE id = ?', [id]);
    if (!user) throw new HttpError(404, 'No such user', 'not_found');
    return reply.send({
      user,
      roles: all('SELECT r.id, r.code, r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?', [id]),
      overrides: all('SELECT perm_key, effect FROM user_permission_overrides WHERE user_id = ?', [id]),
      sessions: all('SELECT id, created_at, last_seen_at, ip, user_agent FROM sessions WHERE user_id = ? AND revoked_at IS NULL', [id]),
    });
  });

  const UserBody = z.object({
    username: zText(80).min(3, 'at least 3 characters').regex(/^[a-zA-Z0-9._-]+$/, 'letters, numbers, dot, dash and underscore only'),
    full_name: zText(160).min(1, 'what is their name?'),
    email: z.union([z.string().email(), z.literal('')]).default(''),
    password: z.string().optional(),
    is_active: z.coerce.number().int().min(0).max(1).default(1),
    must_change_pw: z.coerce.number().int().min(0).max(1).default(1),
    roles: z.array(z.string()).default([]),
  });

  app.post('/api/users', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'users.create');
    const body = parse(UserBody, req.body);
    if (one('SELECT id FROM users WHERE username = ? COLLATE NOCASE', [body.username])) {
      throw new HttpError(409, `Someone already uses the username "${body.username}"`, 'duplicate_user');
    }
    const password = body.password || newToken(9);
    const strength = checkPasswordStrength(password, body.username);
    if (body.password && !strength.ok) throw new HttpError(400, `That password ${strength.problems.join(', ')}`, 'weak_password');

    const rolePerms = body.roles.flatMap((code) =>
      all<{ perm_key: string }>(
        'SELECT perm_key FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.code = ?', [code],
      ).map((p) => p.perm_key));
    assertNotEscalating(req, rolePerms);

    const hash = await hashPassword(password);
    const id = tx(() => {
      const info = run(
        `INSERT INTO users (username, full_name, email, password_hash, is_active, must_change_pw)
         VALUES (?,?,?,?,?,?)`,
        [body.username, body.full_name, body.email, hash, body.is_active, body.must_change_pw],
      );
      const uid = info.lastInsertRowid as number;
      for (const code of body.roles) {
        const role = one<{ id: number }>('SELECT id FROM roles WHERE code = ?', [code]);
        if (role) run('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?,?)', [uid, role.id]);
      }
      return uid;
    });

    audit(req, {
      action: 'create', entity: 'users', entityId: id,
      summary: `Created user ${body.username} with roles ${body.roles.join(', ') || 'none'}`,
      after: { ...body, password: '***' }, severity: 'notice',
    });
    // The generated password is returned once and never stored in the clear.
    return reply.code(201).send({ id, username: body.username, temporary_password: body.password ? undefined : password });
  });

  app.patch('/api/users/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'users.edit');
    const id = Number((req.params as { id: string }).id);
    const before = one<Record<string, unknown>>('SELECT * FROM users WHERE id = ?', [id]);
    if (!before) throw new HttpError(404, 'No such user', 'not_found');
    const body = parse(UserBody.partial().extend({ password: z.string().optional() }), req.body);

    if (body.is_active === 0 && adminCount(id) === 0) {
      throw new HttpError(409, 'That is the last administrator. Give someone else the role first.', 'last_admin');
    }
    if (body.roles) {
      const rolePerms = body.roles.flatMap((code) =>
        all<{ perm_key: string }>(
          'SELECT perm_key FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.code = ?', [code],
        ).map((p) => p.perm_key));
      assertNotEscalating(req, rolePerms);
      if (!body.roles.includes('admin') && adminCount(id) === 0) {
        throw new HttpError(409, 'That is the last administrator. Give someone else the role first.', 'last_admin');
      }
    }

    const hash = body.password ? await hashPassword(body.password) : null;
    if (body.password) {
      const strength = checkPasswordStrength(body.password, String(body.username ?? before.username));
      if (!strength.ok) throw new HttpError(400, `That password ${strength.problems.join(', ')}`, 'weak_password');
    }

    tx(() => {
      const sets: string[] = [];
      const params: unknown[] = [];
      for (const key of ['username', 'full_name', 'email', 'is_active', 'must_change_pw'] as const) {
        if (body[key] !== undefined) { sets.push(`${key} = ?`); params.push(body[key]); }
      }
      if (hash) { sets.push('password_hash = ?'); params.push(hash); sets.push('must_change_pw = 1'); }
      if (sets.length) {
        run(`UPDATE users SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`, [...params, id]);
      }
      if (body.roles) {
        run('DELETE FROM user_roles WHERE user_id = ?', [id]);
        for (const code of body.roles) {
          const role = one<{ id: number }>('SELECT id FROM roles WHERE code = ?', [code]);
          if (role) run('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?,?)', [id, role.id]);
        }
      }
    });

    if (hash || body.is_active === 0 || body.roles) revokeAllForUser(id);
    const after = one<Record<string, unknown>>('SELECT * FROM users WHERE id = ?', [id]);
    audit(req, {
      action: body.roles ? 'role_change' : 'update', entity: 'users', entityId: id,
      summary: `Edited user ${after?.username}`, before, after, severity: 'notice',
    });
    return reply.send({ ok: true });
  });

  app.put('/api/users/:id/overrides', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'users.edit');
    const id = Number((req.params as { id: string }).id);
    const body = parse(z.object({
      overrides: z.array(z.object({ perm_key: z.string(), effect: z.enum(['allow', 'deny']) })),
    }), req.body);
    const unknown = body.overrides.filter((o) => !isKnownPermission(o.perm_key));
    if (unknown.length) throw new HttpError(400, `Unknown permission: ${unknown[0].perm_key}`, 'unknown_permission');
    assertNotEscalating(req, body.overrides.filter((o) => o.effect === 'allow').map((o) => o.perm_key));

    const before = all('SELECT perm_key, effect FROM user_permission_overrides WHERE user_id = ?', [id]);
    tx(() => {
      run('DELETE FROM user_permission_overrides WHERE user_id = ?', [id]);
      for (const o of body.overrides) {
        run('INSERT INTO user_permission_overrides (user_id, perm_key, effect) VALUES (?,?,?)', [id, o.perm_key, o.effect]);
      }
    });
    revokeAllForUser(id);
    audit(req, {
      action: 'permission_change', entity: 'user_permission_overrides', entityId: id,
      summary: `Set ${body.overrides.length} personal permission overrides`,
      before, after: body.overrides, severity: 'notice',
    });
    return reply.send({ ok: true });
  });

  app.post('/api/users/:id/reset-password', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'users.edit');
    const id = Number((req.params as { id: string }).id);
    const user = one<{ username: string }>('SELECT username FROM users WHERE id = ?', [id]);
    if (!user) throw new HttpError(404, 'No such user', 'not_found');
    const password = newToken(9);
    run(
      `UPDATE users SET password_hash = ?, must_change_pw = 1, failed_attempts = 0,
              locked_until = NULL, updated_at = datetime('now') WHERE id = ?`,
      [await hashPassword(password), id],
    );
    revokeAllForUser(id);
    audit(req, {
      action: 'password_change', entity: 'users', entityId: id,
      summary: `Reset the password for ${user.username}`, severity: 'warning',
    });
    return reply.send({ temporary_password: password });
  });

  app.post('/api/users/:id/unlock', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'users.edit');
    const id = Number((req.params as { id: string }).id);
    run('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?', [id]);
    audit(req, { action: 'update', entity: 'users', entityId: id, summary: 'Unlocked the account', severity: 'notice' });
    return reply.send({ ok: true });
  });

  // ------------------------------------------------------------------ roles
  app.get('/api/roles', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'users.view');
    const roles = all<{ id: number; code: string; name: string; description: string; is_system: number; rank: number }>(
      'SELECT * FROM roles ORDER BY rank, name',
    );
    return reply.send({
      rows: roles.map((r) => ({
        ...r,
        permissions: all<{ perm_key: string }>('SELECT perm_key FROM role_permissions WHERE role_id = ?', [r.id]).map((p) => p.perm_key),
        user_count: one<{ c: number }>('SELECT COUNT(*) AS c FROM user_roles WHERE role_id = ?', [r.id])!.c,
      })),
      catalogue: MODULES,
      all_permissions: ALL_PERMISSIONS,
    });
  });

  const RoleBody = z.object({
    code: zText(40).min(2).regex(/^[a-z0-9_]+$/, 'lower-case letters, numbers and underscore only'),
    name: zText(80).min(1),
    description: zText(400).default(''),
    rank: z.coerce.number().int().min(0).max(999).default(100),
    permissions: z.array(z.string()).default([]),
  });

  app.post('/api/roles', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'users.create');
    const body = parse(RoleBody, req.body);
    const unknown = body.permissions.filter((p) => !isKnownPermission(p));
    if (unknown.length) throw new HttpError(400, `Unknown permission: ${unknown[0]}`, 'unknown_permission');
    assertNotEscalating(req, body.permissions);
    if (one('SELECT id FROM roles WHERE code = ?', [body.code])) {
      throw new HttpError(409, `A role called "${body.code}" already exists`, 'duplicate_role');
    }
    const id = tx(() => {
      const info = run(
        'INSERT INTO roles (code, name, description, rank) VALUES (?,?,?,?)',
        [body.code, body.name, body.description, body.rank],
      );
      const rid = info.lastInsertRowid as number;
      for (const p of body.permissions) run('INSERT OR IGNORE INTO role_permissions (role_id, perm_key) VALUES (?,?)', [rid, p]);
      return rid;
    });
    audit(req, {
      action: 'create', entity: 'roles', entityId: id,
      summary: `Created role ${body.name} with ${body.permissions.length} permissions`,
      after: body, severity: 'notice',
    });
    return reply.code(201).send({ id });
  });

  app.put('/api/roles/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'users.edit');
    const id = Number((req.params as { id: string }).id);
    const role = one<{ id: number; code: string; is_system: number }>('SELECT * FROM roles WHERE id = ?', [id]);
    if (!role) throw new HttpError(404, 'No such role', 'not_found');
    const body = parse(RoleBody.partial(), req.body);
    if (body.permissions) {
      const unknown = body.permissions.filter((p) => !isKnownPermission(p));
      if (unknown.length) throw new HttpError(400, `Unknown permission: ${unknown[0]}`, 'unknown_permission');
      assertNotEscalating(req, body.permissions);
      if (role.code === 'admin' && !body.permissions.includes('users.edit')) {
        throw new HttpError(409, 'The administrator role has to keep user administration, or nobody can fix it afterwards.', 'admin_lockout');
      }
    }
    const before = {
      ...role,
      permissions: all<{ perm_key: string }>('SELECT perm_key FROM role_permissions WHERE role_id = ?', [id]).map((p) => p.perm_key),
    };

    tx(() => {
      const sets: string[] = [];
      const params: unknown[] = [];
      for (const key of ['name', 'description', 'rank'] as const) {
        if (body[key] !== undefined) { sets.push(`${key} = ?`); params.push(body[key]); }
      }
      if (sets.length) run(`UPDATE roles SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`, [...params, id]);
      if (body.permissions) {
        run('DELETE FROM role_permissions WHERE role_id = ?', [id]);
        for (const p of body.permissions) run('INSERT OR IGNORE INTO role_permissions (role_id, perm_key) VALUES (?,?)', [id, p]);
      }
    });

    // Anyone holding this role is signed out so the change takes effect at once.
    for (const u of all<{ user_id: number }>('SELECT user_id FROM user_roles WHERE role_id = ?', [id])) {
      revokeAllForUser(u.user_id);
    }
    const after = {
      ...one('SELECT * FROM roles WHERE id = ?', [id]),
      permissions: all<{ perm_key: string }>('SELECT perm_key FROM role_permissions WHERE role_id = ?', [id]).map((p) => p.perm_key),
    };
    audit(req, {
      action: 'permission_change', entity: 'roles', entityId: id,
      summary: `Changed role ${role.code}`, before, after, severity: 'notice',
    });
    return reply.send({ ok: true });
  });

  app.delete('/api/roles/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'users.delete');
    const id = Number((req.params as { id: string }).id);
    const role = one<{ code: string; is_system: number; name: string }>('SELECT * FROM roles WHERE id = ?', [id]);
    if (!role) throw new HttpError(404, 'No such role', 'not_found');
    if (role.is_system) throw new HttpError(409, `"${role.name}" is a built-in role and cannot be deleted. Edit its permissions instead.`, 'system_role');
    const users = one<{ c: number }>('SELECT COUNT(*) AS c FROM user_roles WHERE role_id = ?', [id])!.c;
    if (users > 0) throw new HttpError(409, `${users} user${users === 1 ? '' : 's'} still hold this role. Move them first.`, 'role_in_use');
    run('DELETE FROM roles WHERE id = ?', [id]);
    audit(req, { action: 'delete', entity: 'roles', entityId: id, summary: `Deleted role ${role.name}`, before: role, severity: 'warning' });
    return reply.send({ deleted: true });
  });

  // -------------------------------------------------------------- audit log
  app.get('/api/audit', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'audit.view');
    const q = req.query as Record<string, string>;
    const result = queryAudit({
      from: q.from, to: q.to, userId: q.user_id ? Number(q.user_id) : undefined,
      entity: q.entity, action: q.action, severity: q.severity, q: q.q,
      limit: Number(q.limit) || 100, offset: Number(q.offset) || 0,
    });
    return reply.send(result);
  });

  app.get('/api/audit/export', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'audit.export');
    const q = req.query as Record<string, string>;
    const { rows } = queryAudit({ from: q.from, to: q.to, entity: q.entity, action: q.action, limit: 500 });
    audit(req, { action: 'export', entity: 'audit_log', summary: `Exported ${rows.length} audit rows`, severity: 'notice' });
    return sendCsv(reply, `audit-${new Date().toISOString().slice(0, 10)}.csv`, rows as Record<string, unknown>[]);
  });

  app.get('/api/audit/entity/:entity/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'audit.view');
    const { entity, id } = req.params as { entity: string; id: string };
    return reply.send({
      rows: all('SELECT * FROM audit_log WHERE entity = ? AND entity_id = ? ORDER BY at DESC LIMIT 100', [entity, id]),
    });
  });

  // --------------------------------------------------------------- settings
  app.get('/api/settings', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'settings.view');
    return reply.send({
      settings: all('SELECT key, value, updated_at FROM settings ORDER BY key'),
      backup: backupStatus(),
      backups: listBackups().slice(0, 30),
    });
  });

  app.put('/api/settings', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'settings.edit');
    const body = parse(z.record(z.union([z.string(), z.number(), z.boolean()])), req.body);
    const before = Object.fromEntries(
      all<{ key: string; value: string }>('SELECT key, value FROM settings').map((r) => [r.key, r.value]),
    );
    tx(() => {
      for (const [key, value] of Object.entries(body)) {
        run(
          `INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?,?,?,datetime('now'))
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by,
                                          updated_at = datetime('now')`,
          [key, String(value), req.principal?.userId ?? null],
        );
      }
    });
    audit(req, {
      action: 'settings_change', entity: 'settings',
      summary: `Changed ${Object.keys(body).length} setting${Object.keys(body).length === 1 ? '' : 's'}`,
      before, after: body, severity: 'notice',
    });
    return reply.send({ ok: true });
  });

  // ---------------------------------------------------------------- backups
  app.post('/api/backup/run', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'settings.edit');
    const result = runBackup('manual');
    audit(req, {
      action: 'backup', entity: 'database',
      summary: `Backed up to ${result.file} (${(result.bytes / 1_048_576).toFixed(1)} MB)`,
      severity: 'notice',
    });
    return reply.send(result);
  });

  app.get('/api/backup', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'settings.view');
    return reply.send({ status: backupStatus(), files: listBackups() });
  });

  app.post('/api/maintenance/sweep-alerts', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'settings.edit');
    const sent = sweepAlerts();
    audit(req, { action: 'update', entity: 'notifications', summary: `Alert sweep sent ${sent} notifications` });
    return reply.send({ sent });
  });
}
