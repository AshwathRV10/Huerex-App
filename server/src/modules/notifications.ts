import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { all, one, run } from '../db/index.js';
import { assertPermission, requireAuth } from '../rbac/guard.js';
import { HttpError, parse, zText } from '../lib/http.js';
import { computeAlerts, type Alert } from '../engine/alerts.js';

/**
 * Notifications.
 *
 * The spreadsheet's weakness was that a blocked order waited until somebody
 * thought to open the approvals page. Here, anything that needs a decision
 * finds its owner: it lands in their bell, it is counted in the header, and
 * the sweep below turns standing alerts into notifications once — never once
 * per minute — using a dedupe key.
 */

export interface NotifyInput {
  userId?: number | null;
  roleCode?: string;
  kind: string;
  severity?: 'info' | 'warning' | 'critical';
  title: string;
  body?: string;
  link?: string;
  entity?: string;
  entityId?: string;
  dedupeKey?: string;
}

export function notify(input: NotifyInput): void {
  try {
    run(
      `INSERT INTO notifications (user_id, role_code, kind, severity, title, body, link,
                                  entity, entity_id, dedupe_key)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        input.userId ?? null, input.roleCode ?? null, input.kind,
        input.severity ?? 'info', input.title, input.body ?? '', input.link ?? '',
        input.entity ?? null, input.entityId ?? null, input.dedupeKey ?? null,
      ],
    );
  } catch (err) {
    // A duplicate dedupe_key is the normal case on a repeat sweep, not a fault.
    if (!(err instanceof Error) || !err.message.includes('UNIQUE')) throw err;
  }
}

/** Find the user behind a name typed into a Merchandiser or Planner box. */
function userIdForName(name: string): number | null {
  if (!name) return null;
  const row = one<{ id: number }>(
    'SELECT id FROM users WHERE is_active = 1 AND (full_name = ? COLLATE NOCASE OR username = ? COLLATE NOCASE)',
    [name, name],
  );
  return row?.id ?? null;
}

const SEVERITY_MAP: Record<string, 'info' | 'warning' | 'critical'> = {
  CRITICAL: 'critical', HIGH: 'warning', MEDIUM: 'info', LOW: 'info',
};

/**
 * Turn today's live alerts into notifications. Runs on a timer and on demand.
 * Suppressed alerts are skipped — that is the whole point of a waiver.
 */
export function sweepAlerts(alerts?: Alert[]): number {
  const live = (alerts ?? computeAlerts()).filter((a) => !a.suppressed);
  let sent = 0;
  const day = new Date().toISOString().slice(0, 10);
  for (const a of live) {
    // Only the sharp end gets pushed at people; the rest live on the alerts page.
    if (a.severity !== 'CRITICAL' && a.severity !== 'HIGH') continue;
    const owner = userIdForName(a.owner);
    const before = one<{ c: number }>('SELECT COUNT(*) AS c FROM notifications WHERE dedupe_key = ?', [`${a.dedupe_key}|${day}`]);
    if (before && before.c > 0) continue;
    notify({
      userId: owner,
      roleCode: owner ? undefined : 'management',
      kind: `alert:${a.type}`,
      severity: SEVERITY_MAP[a.severity] ?? 'info',
      title: `${a.type} · ${a.order_no}`,
      body: `${a.message}. ${a.action}.`,
      link: a.link,
      entity: 'alert',
      entityId: a.order_no,
      dedupeKey: `${a.dedupe_key}|${day}`,
    });
    sent += 1;
  }
  return sent;
}

/** Raised when an approval is created or turns overdue. */
export function notifyApprovalPending(orderNo: string, buyer: string, type: string, owner: string, days: number): void {
  const userId = userIdForName(owner);
  notify({
    userId,
    roleCode: userId ? undefined : 'merchandiser',
    kind: 'approval_pending',
    severity: days > 7 ? 'warning' : 'info',
    title: `${type} pending · ${orderNo}`,
    body: days > 0
      ? `${buyer} has had the ${type} for ${days} days and production is held on it.`
      : `${type} raised for ${buyer}. Production is held until it comes back.`,
    link: `/approvals?order=${encodeURIComponent(orderNo)}`,
    entity: 'buyer_approvals',
    entityId: orderNo,
    dedupeKey: `approval|${orderNo}|${type}|${new Date().toISOString().slice(0, 10)}`,
  });
}

interface NotificationRow {
  id: number; created_at: string; user_id: number | null; role_code: string | null;
  kind: string; severity: string; title: string; body: string; link: string;
  entity: string | null; entity_id: string | null; read_at: string | null; dismissed_at: string | null;
}

function visibleFor(userId: number, roles: string[], opts: { unreadOnly?: boolean; limit?: number } = {}) {
  const roleList = roles.length ? roles : ['__none__'];
  const placeholders = roleList.map(() => '?').join(',');
  const unread = opts.unreadOnly
    ? 'AND nr.notification_id IS NULL AND n.dismissed_at IS NULL'
    : '';
  return all<NotificationRow & { read_by_me: number }>(
    `SELECT n.*, CASE WHEN nr.notification_id IS NULL THEN 0 ELSE 1 END AS read_by_me
       FROM notifications n
       LEFT JOIN notification_reads nr ON nr.notification_id = n.id AND nr.user_id = ?
      WHERE (n.user_id = ? OR (n.user_id IS NULL AND n.role_code IN (${placeholders}))) ${unread}
      ORDER BY n.created_at DESC LIMIT ?`,
    [userId, userId, ...roleList, Math.min(opts.limit ?? 60, 200)],
  );
}

export function registerNotifications(app: FastifyInstance): void {
  app.get('/api/notifications', { preHandler: requireAuth() }, async (req: FastifyRequest, reply: FastifyReply) => {
    const p = req.principal!;
    const q = req.query as { unread?: string; limit?: string };
    const rows = visibleFor(p.userId, p.roles, {
      unreadOnly: q.unread === '1',
      limit: Number(q.limit) || 60,
    });
    const unread = visibleFor(p.userId, p.roles, { unreadOnly: true, limit: 200 }).length;
    return reply.send({ rows, unread });
  });

  app.post('/api/notifications/:id/read', { preHandler: requireAuth() }, async (req: FastifyRequest, reply: FastifyReply) => {
    const id = Number((req.params as { id: string }).id);
    run('INSERT OR IGNORE INTO notification_reads (notification_id, user_id) VALUES (?,?)', [id, req.principal!.userId]);
    return reply.send({ ok: true });
  });

  app.post('/api/notifications/read-all', { preHandler: requireAuth() }, async (req: FastifyRequest, reply: FastifyReply) => {
    const p = req.principal!;
    for (const n of visibleFor(p.userId, p.roles, { unreadOnly: true, limit: 200 })) {
      run('INSERT OR IGNORE INTO notification_reads (notification_id, user_id) VALUES (?,?)', [n.id, p.userId]);
    }
    return reply.send({ ok: true });
  });

  app.post('/api/notifications/:id/dismiss', { preHandler: requireAuth() }, async (req: FastifyRequest, reply: FastifyReply) => {
    const id = Number((req.params as { id: string }).id);
    const row = one<NotificationRow>('SELECT * FROM notifications WHERE id = ?', [id]);
    if (!row) throw new HttpError(404, 'That notification is gone', 'not_found');
    // A personal notification can be dismissed outright; a broadcast is only
    // marked read for this person, so it stays for everyone else.
    if (row.user_id === req.principal!.userId) {
      run(`UPDATE notifications SET dismissed_at = datetime('now') WHERE id = ?`, [id]);
    } else {
      run('INSERT OR IGNORE INTO notification_reads (notification_id, user_id) VALUES (?,?)', [id, req.principal!.userId]);
    }
    return reply.send({ ok: true });
  });

  // Manual sweep, for the settings screen and for testing the wiring.
  app.post('/api/notifications/sweep', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'settings.edit');
    return reply.send({ sent: sweepAlerts() });
  });

  // Send a note to a colleague — the small courtesy that stops people walking
  // to the other end of the factory.
  app.post('/api/notifications/send', async (req: FastifyRequest, reply: FastifyReply) => {
    assertPermission(req, 'alerts.view');
    const body = parse(z.object({
      to_user_id: z.coerce.number().int().positive().optional(),
      to_role: zText(40).optional(),
      title: zText(200).min(1),
      body: zText(1000).default(''),
      link: zText(300).default(''),
    }), req.body);
    if (!body.to_user_id && !body.to_role) throw new HttpError(400, 'Choose who this goes to', 'no_recipient');
    notify({
      userId: body.to_user_id, roleCode: body.to_role, kind: 'message',
      title: body.title, body: `${body.body}\n— ${req.principal?.fullName ?? 'A colleague'}`,
      link: body.link,
    });
    return reply.send({ ok: true });
  });
}
