import type { FastifyRequest } from 'fastify';
import { run, all, scalar } from '../db/index.js';

export type AuditAction =
  | 'create' | 'update' | 'delete' | 'bulk_create' | 'bulk_update'
  | 'login' | 'login_failed' | 'logout' | 'lockout'
  | 'export' | 'approve' | 'reject' | 'submit' | 'waive'
  | 'password_change' | 'role_change' | 'permission_change'
  | 'backup' | 'restore' | 'settings_change' | 'seed';

export type Severity = 'info' | 'notice' | 'warning' | 'critical';

const SENSITIVE_ENTITIES = new Set([
  'cost_sheets', 'cost_fabric_lines', 'cost_trim_lines', 'cost_jobwork_lines',
  'cost_cmt_lines', 'cost_overhead_lines', 'rate_memory', 'users', 'roles',
  'role_permissions', 'user_roles', 'user_permission_overrides', 'buyers', 'settings',
]);

export interface AuditInput {
  action: AuditAction;
  entity: string;
  entityId?: string | number | null;
  summary?: string;
  before?: unknown;
  after?: unknown;
  severity?: Severity;
}

function pickSeverity(input: AuditInput): Severity {
  if (input.severity) return input.severity;
  if (input.action === 'login_failed' || input.action === 'lockout') return 'warning';
  if (input.action === 'delete') return 'warning';
  if (['approve', 'reject', 'role_change', 'permission_change', 'restore', 'settings_change']
    .includes(input.action)) return 'notice';
  if (SENSITIVE_ENTITIES.has(input.entity)) return 'notice';
  return 'info';
}

/** Values we never write to the audit trail even when they change. */
const NEVER_LOG = new Set(['password', 'password_hash', 'totp_secret', 'new_password', 'current_password']);

function sanitize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(sanitize);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = NEVER_LOG.has(k) ? '***' : sanitize(v);
    }
    return out;
  }
  return value;
}

/** Only the keys that actually changed, so the trail stays readable. */
export function diff(before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined) {
  if (!before || !after) return { before, after };
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      b[key] = before[key];
      a[key] = after[key];
    }
  }
  return { before: b, after: a };
}

export function audit(req: FastifyRequest | null, input: AuditInput): void {
  const p = req?.principal;
  const ip = (req?.ip ?? '').toString();
  const changed = input.action === 'update'
    ? diff(input.before as Record<string, unknown>, input.after as Record<string, unknown>)
    : { before: input.before, after: input.after };

  run(
    `INSERT INTO audit_log (user_id, username, action, entity, entity_id, summary,
                            before_json, after_json, ip, severity)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      p?.userId ?? null,
      p?.username ?? 'system',
      input.action,
      input.entity,
      input.entityId == null ? null : String(input.entityId),
      input.summary ?? '',
      changed.before === undefined ? null : JSON.stringify(sanitize(changed.before)),
      changed.after === undefined ? null : JSON.stringify(sanitize(changed.after)),
      ip,
      pickSeverity(input),
    ],
  );
}

export function auditAnon(
  username: string, action: AuditAction, entity: string, summary: string, ip = '', severity: Severity = 'warning',
): void {
  run(
    `INSERT INTO audit_log (user_id, username, action, entity, summary, ip, severity)
     VALUES (NULL,?,?,?,?,?,?)`,
    [username, action, entity, summary, ip, severity],
  );
}

export interface AuditQuery {
  from?: string; to?: string; userId?: number; entity?: string;
  action?: string; severity?: string; q?: string; limit?: number; offset?: number;
}

export function queryAudit(f: AuditQuery) {
  const where: string[] = ['1=1'];
  const params: unknown[] = [];
  if (f.from) { where.push('at >= ?'); params.push(f.from); }
  if (f.to) { where.push('at <= ?'); params.push(`${f.to} 23:59:59`); }
  if (f.userId) { where.push('user_id = ?'); params.push(f.userId); }
  if (f.entity) { where.push('entity = ?'); params.push(f.entity); }
  if (f.action) { where.push('action = ?'); params.push(f.action); }
  if (f.severity) { where.push('severity = ?'); params.push(f.severity); }
  if (f.q) {
    where.push('(summary LIKE ? OR username LIKE ? OR entity_id LIKE ?)');
    const like = `%${f.q}%`;
    params.push(like, like, like);
  }
  const sql = where.join(' AND ');
  const total = scalar<number>(`SELECT COUNT(*) c FROM audit_log WHERE ${sql}`, params);
  const rows = all(
    `SELECT * FROM audit_log WHERE ${sql} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`,
    [...params, Math.min(f.limit ?? 100, 500), f.offset ?? 0],
  );
  return { rows, total };
}
