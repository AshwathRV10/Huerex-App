import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { useToast } from '../lib/toast';
import { Combobox } from '../components/Combobox';
import { NumField, TextField } from '../components/RateField';
import { Confirm, Empty, Loading, Modal, PageHead, Tabs } from '../components/ui';
import { Icon } from '../components/Icons';
import { ago, dateTime, initials, longDate } from '../lib/format';

/* ================================================================== users */

interface UserRow {
  id: number; username: string; full_name: string; email: string;
  is_active: number; totp_enabled: number; must_change_pw: number;
  last_login_at: string | null; locked_until: string | null;
  roles: string[]; role_names: string;
}

interface RoleRow {
  id: number; code: string; name: string; description: string;
  is_system: number; rank: number; permissions: string[]; user_count: number;
}

interface ModuleDef {
  key: string; label: string; group: string; actions: string[];
  description?: string;
  sensitiveFields?: { key: string; label: string; actions: string[] }[];
}

export function UsersPage() {
  const [tab, setTab] = useState('users');
  return (
    <>
      <PageHead
        title="Users &amp; roles"
        lede="Who can sign in, and exactly what each of them can see. Permissions run at module, screen, field and action level, and they are enforced on the server — hiding a button is a courtesy, not the control."
      />
      <Tabs
        tabs={[{ id: 'users', label: 'People' }, { id: 'roles', label: 'Roles' }]}
        active={tab} onChange={setTab}
      />
      {tab === 'users' ? <UsersTab /> : <RolesTab />}
    </>
  );
}

function UsersTab() {
  const { can, user: me } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<UserRow | 'new' | null>(null);
  const [tempPassword, setTempPassword] = useState<{ username: string; password: string } | null>(null);

  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<{ rows: UserRow[] }>('/api/users') });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<{ rows: RoleRow[] }>('/api/roles') });

  const reset = useMutation({
    mutationFn: (u: UserRow) => api.post<{ temporary_password: string }>(`/api/users/${u.id}/reset-password`),
    onSuccess: (res, u) => {
      setTempPassword({ username: u.username, password: res.temporary_password });
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (e) => toast.error(e),
  });

  const unlock = useMutation({
    mutationFn: (u: UserRow) => api.post(`/api/users/${u.id}/unlock`),
    onSuccess: () => { toast.ok('Account unlocked'); void qc.invalidateQueries({ queryKey: ['users'] }); },
    onError: (e) => toast.error(e),
  });

  if (users.isLoading) return <Loading rows={6} />;

  return (
    <>
      <div className="toolbar">
        <span className="grow tiny muted">
          {users.data?.rows.filter((u) => u.is_active).length} active ·{' '}
          {users.data?.rows.filter((u) => !u.is_active).length} disabled
        </span>
        {can('users.create') && (
          <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
            <Icon.Plus size={16} /> Add someone
          </button>
        )}
      </div>

      <div className="table-wrap">
        <table className="data stack">
          <thead>
            <tr><th>Name</th><th>Username</th><th>Roles</th><th>Sign-in</th><th>Last seen</th><th /></tr>
          </thead>
          <tbody>
            {users.data!.rows.map((u) => (
              <tr key={u.id} style={{ opacity: u.is_active ? 1 : 0.55 }}>
                <td className="row-title" data-label="Name">
                  <span className="row">
                    <span className="avatar" style={{ width: 26, height: 26, fontSize: 10 }}>
                      {initials(u.full_name)}
                    </span>
                    <b>{u.full_name}</b>
                    {u.id === me?.id && <span className="badge">you</span>}
                  </span>
                </td>
                <td data-label="Username" className="mono">{u.username}</td>
                <td data-label="Roles">
                  {u.roles.length === 0
                    ? <span className="badge badge-warn">no role</span>
                    : u.roles.map((r) => <span key={r} className="badge" style={{ marginRight: 4 }}>{r}</span>)}
                </td>
                <td data-label="Sign-in">
                  {!u.is_active && <span className="badge">disabled</span>}
                  {u.locked_until && <span className="badge badge-danger">locked</span>}
                  {u.totp_enabled ? <span className="badge badge-ok">2FA</span> : null}
                  {u.must_change_pw ? <span className="badge badge-warn">temp password</span> : null}
                </td>
                <td data-label="Last seen">{u.last_login_at ? ago(u.last_login_at) : <span className="subtle">never</span>}</td>
                <td data-label="">
                  {can('users.edit') && (
                    <div className="row">
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(u)}>Edit</button>
                      {u.locked_until && (
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => unlock.mutate(u)}>Unlock</button>
                      )}
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => reset.mutate(u)}>
                        Reset password
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && roles.data && (
        <UserModal user={editing === 'new' ? null : editing} roles={roles.data.rows}
          onClose={() => setEditing(null)}
          onCreated={(u, pw) => { if (pw) setTempPassword({ username: u, password: pw }); }} />
      )}

      {tempPassword && (
        <Modal title="Temporary password" onClose={() => setTempPassword(null)}
          subtitle="Shown once and never stored in the clear. Give it to them directly; they will be asked to change it as soon as they sign in."
          footer={<button type="button" className="btn btn-primary" onClick={() => setTempPassword(null)}>Done</button>}>
          <div className="col" style={{ gap: 'var(--s-3)' }}>
            <div className="field">
              <label>Username</label>
              <div className="input mono">{tempPassword.username}</div>
            </div>
            <div className="field">
              <label>Password</label>
              <div className="row">
                <div className="input mono grow" style={{ fontSize: 'var(--text-md)' }}>{tempPassword.password}</div>
                <button type="button" className="btn" onClick={() => {
                  void navigator.clipboard?.writeText(tempPassword.password);
                }}><Icon.Copy size={15} /> Copy</button>
              </div>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

function UserModal({ user, roles, onClose, onCreated }: {
  user: UserRow | null; roles: RoleRow[]; onClose: () => void;
  onCreated: (username: string, password?: string) => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState({
    username: user?.username ?? '', full_name: user?.full_name ?? '',
    email: user?.email ?? '', is_active: user ? user.is_active : 1,
    roles: user?.roles ?? [] as string[],
  });
  const set = (n: Partial<typeof form>) => setForm((f) => ({ ...f, ...n }));

  const save = useMutation({
    mutationFn: () => user
      ? api.patch(`/api/users/${user.id}`, form)
      : api.post<{ username: string; temporary_password?: string }>('/api/users', form),
    onSuccess: (res) => {
      toast.ok(user ? 'User saved' : 'User created');
      if (!user) {
        const r = res as { username: string; temporary_password?: string };
        onCreated(r.username, r.temporary_password);
      }
      void qc.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
    onError: (e) => toast.error(e),
  });

  const toggleRole = (code: string) => set({
    roles: form.roles.includes(code) ? form.roles.filter((r) => r !== code) : [...form.roles, code],
  });

  return (
    <Modal
      title={user ? `Edit ${user.full_name}` : 'Add someone'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={save.isPending}
            onClick={() => save.mutate()}>
            {save.isPending && <span className="spinner" />}{user ? 'Save' : 'Create'}
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 'var(--s-4)' }}>
        <div className="line-grid">
          <TextField label="Full name" value={form.full_name} onChange={(v) => set({ full_name: v })} required />
          <TextField label="Username" value={form.username} onChange={(v) => set({ username: v })} required
            help="letters, numbers, dot, dash, underscore" />
          <TextField label="Email" type="email" value={form.email} onChange={(v) => set({ email: v })} />
        </div>

        <div className="field">
          <label>Roles</label>
          <p className="help" style={{ marginBottom: 4 }}>
            Someone with several roles gets everything all of them allow.
          </p>
          <div className="col" style={{ gap: 6 }}>
            {roles.map((r) => (
              <label key={r.code} className="check" style={{ alignItems: 'flex-start' }}>
                <input type="checkbox" checked={form.roles.includes(r.code)}
                  onChange={() => toggleRole(r.code)} style={{ marginTop: 4 }} />
                <span>
                  <b>{r.name}</b>
                  <span className="cell-sub">{r.description}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <label className="check">
          <span className="switch">
            <input type="checkbox" checked={Boolean(form.is_active)}
              onChange={(e) => set({ is_active: e.target.checked ? 1 : 0 })} />
          </span>
          <span>{form.is_active ? 'Can sign in' : 'Disabled — cannot sign in'}</span>
        </label>

        {!user && (
          <div className="banner">
            <Icon.Lock size={16} />
            <span>A temporary password is generated and shown once. They must change it on first sign-in.</span>
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ================================================================== roles */

function RolesTab() {
  const { can } = useSession();
  const [editing, setEditing] = useState<RoleRow | 'new' | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['roles'],
    queryFn: () => api.get<{ rows: RoleRow[]; catalogue: ModuleDef[]; all_permissions: string[] }>('/api/roles'),
  });

  if (isLoading || !data) return <Loading rows={6} />;

  return (
    <>
      <div className="toolbar">
        <span className="grow tiny muted">
          Built-in roles track the permission catalogue and cannot be deleted. Make your own for
          anything the factory needs that these do not cover.
        </span>
        {can('users.create') && (
          <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
            <Icon.Plus size={16} /> New role
          </button>
        )}
      </div>

      <div className="grid-2">
        {data.rows.map((r) => (
          <div key={r.id} className="card">
            <div className="card-head">
              <div>
                <h3>{r.name}</h3>
                <span className="hint">{r.description}</span>
              </div>
              <div className="row">
                <span className="badge">{r.user_count} {r.user_count === 1 ? 'person' : 'people'}</span>
                {r.is_system ? <span className="badge badge-info">built-in</span> : null}
              </div>
            </div>
            <div className="card-body">
              <div className="between tiny muted">
                <span>{r.permissions.length} permissions</span>
                {can('users.edit') && (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(r)}>
                    Review access
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <RoleModal
          role={editing === 'new' ? null : editing}
          catalogue={data.catalogue}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function RoleModal({ role, catalogue, onClose }: {
  role: RoleRow | null; catalogue: ModuleDef[]; onClose: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const { can } = useSession();
  const [form, setForm] = useState({
    code: role?.code ?? '', name: role?.name ?? '', description: role?.description ?? '',
    rank: role?.rank ?? 100,
  });
  const [perms, setPerms] = useState<Set<string>>(new Set(role?.permissions ?? []));
  const [filter, setFilter] = useState('');

  const groups = useMemo(() => {
    const byGroup = new Map<string, ModuleDef[]>();
    for (const m of catalogue) {
      if (filter && !`${m.label} ${m.key} ${m.group}`.toLowerCase().includes(filter.toLowerCase())) continue;
      byGroup.set(m.group, [...(byGroup.get(m.group) ?? []), m]);
    }
    return [...byGroup.entries()];
  }, [catalogue, filter]);

  const toggle = (key: string) => {
    const next = new Set(perms);
    if (next.has(key)) next.delete(key); else next.add(key);
    setPerms(next);
  };

  const toggleModule = (m: ModuleDef, on: boolean) => {
    const next = new Set(perms);
    for (const a of m.actions) { const k = `${m.key}.${a}`; if (on) next.add(k); else next.delete(k); }
    for (const f of m.sensitiveFields ?? []) {
      for (const a of f.actions) { const k = `${m.key}.${f.key}.${a}`; if (on) next.add(k); else next.delete(k); }
    }
    setPerms(next);
  };

  const save = useMutation({
    mutationFn: () => role
      ? api.put(`/api/roles/${role.id}`, { ...form, permissions: [...perms] })
      : api.post('/api/roles', { ...form, permissions: [...perms] }),
    onSuccess: () => {
      toast.ok(role ? 'Role saved' : 'Role created',
        'Anyone holding it is signed out so the change takes effect at once.');
      void qc.invalidateQueries({ queryKey: ['roles'] });
      void qc.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
    onError: (e) => toast.error(e),
  });

  const editable = can('users.edit');

  return (
    <Modal
      wide
      title={role ? `Access for ${role.name}` : 'New role'}
      subtitle="A field-level permission narrows a screen someone can already open: they see the page, but a restricted figure never leaves the server."
      onClose={onClose}
      footer={
        <>
          <span className="grow tiny muted">{perms.size} permissions selected</span>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          {editable && (
            <button type="button" className="btn btn-primary" disabled={save.isPending}
              onClick={() => save.mutate()}>
              {save.isPending && <span className="spinner" />}Save
            </button>
          )}
        </>
      }
    >
      <div className="col" style={{ gap: 'var(--s-4)' }}>
        <div className="line-grid">
          <TextField label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} required />
          {!role && (
            <TextField label="Code" value={form.code} onChange={(v) => setForm({ ...form, code: v })}
              required help="lower case, no spaces" />
          )}
          <NumField label="Rank" value={form.rank} onChange={(v) => setForm({ ...form, rank: v })}
            help="lower sorts first" />
        </div>
        <TextField label="Description" value={form.description}
          onChange={(v) => setForm({ ...form, description: v })}
          placeholder="What this role is for, in one sentence" />

        <input className="input" placeholder="Filter screens…" value={filter}
          onChange={(e) => setFilter(e.target.value)} />

        <div className="col" style={{ gap: 'var(--s-4)' }}>
          {groups.map(([group, modules]) => (
            <div key={group} className="col" style={{ gap: 'var(--s-2)' }}>
              <span className="label">{group}</span>
              {modules.map((m) => {
                const moduleKeys = [
                  ...m.actions.map((a) => `${m.key}.${a}`),
                  ...(m.sensitiveFields ?? []).flatMap((f) => f.actions.map((a) => `${m.key}.${f.key}.${a}`)),
                ];
                const held = moduleKeys.filter((k) => perms.has(k)).length;
                return (
                  <div key={m.key} className="card card-pad col" style={{ gap: 'var(--s-2)', background: 'var(--bg-sunken)' }}>
                    <div className="between">
                      <div>
                        <b className="tiny">{m.label}</b>
                        {m.description && <span className="cell-sub">{m.description}</span>}
                      </div>
                      {editable && (
                        <div className="btn-group">
                          <button type="button" className="btn btn-sm"
                            aria-pressed={held === moduleKeys.length}
                            onClick={() => toggleModule(m, true)}>All</button>
                          <button type="button" className="btn btn-sm"
                            aria-pressed={held === 0}
                            onClick={() => toggleModule(m, false)}>None</button>
                        </div>
                      )}
                    </div>
                    <div className="row-wrap" style={{ gap: 5 }}>
                      {m.actions.map((a) => {
                        const key = `${m.key}.${a}`;
                        return (
                          <label key={key} className="check" style={{ minHeight: 26 }}>
                            <input type="checkbox" checked={perms.has(key)} disabled={!editable}
                              onChange={() => toggle(key)} />
                            <span className="tiny">{a}</span>
                          </label>
                        );
                      })}
                    </div>
                    {(m.sensitiveFields ?? []).length > 0 && (
                      <div className="col" style={{ gap: 4, paddingTop: 6, borderTop: '1px dashed var(--line)' }}>
                        <span className="tiny subtle">Restricted fields on this screen</span>
                        {m.sensitiveFields!.map((f) => (
                          <div key={f.key} className="row-wrap" style={{ gap: 5 }}>
                            <span className="tiny" style={{ minWidth: 180 }}>{f.label}</span>
                            {f.actions.map((a) => {
                              const key = `${m.key}.${f.key}.${a}`;
                              return (
                                <label key={key} className="check" style={{ minHeight: 24 }}>
                                  <input type="checkbox" checked={perms.has(key)} disabled={!editable}
                                    onChange={() => toggle(key)} />
                                  <span className="tiny">{a}</span>
                                </label>
                              );
                            })}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}

/* ============================================================== audit log */

interface AuditRow {
  id: number; at: string; username: string; action: string; entity: string;
  entity_id: string | null; summary: string; before_json: string | null;
  after_json: string | null; ip: string; severity: string;
}

export function AuditPage() {
  const [filters, setFilters] = useState({ q: '', action: '', entity: '', severity: '', from: '', to: '' });
  const [open, setOpen] = useState<AuditRow | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['audit', filters],
    queryFn: () => api.get<{ rows: AuditRow[]; total: number }>('/api/audit',
      Object.fromEntries(Object.entries(filters).filter(([, v]) => v))),
  });

  return (
    <>
      <PageHead
        title="Audit log"
        lede="Who did what, when, and what the value was before they did it. Sensitive actions — cost sheets, rates, permissions, approvals, exports — are always recorded."
        actions={
          <button type="button" className="btn"
            onClick={() => api.download('/api/audit/export', filters)}>
            <Icon.Download size={16} /> Export
          </button>
        }
      />

      <div className="toolbar">
        <input className="input search" placeholder="Search the summary, user or record…"
          value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} />
        <select className="select" style={{ width: 'auto' }} value={filters.severity}
          onChange={(e) => setFilters({ ...filters, severity: e.target.value })}>
          <option value="">Any severity</option>
          <option value="critical">Critical</option>
          <option value="warning">Warning</option>
          <option value="notice">Notice</option>
          <option value="info">Info</option>
        </select>
        <input type="date" className="input" style={{ width: 'auto' }} value={filters.from}
          onChange={(e) => setFilters({ ...filters, from: e.target.value })} aria-label="From" />
        <input type="date" className="input" style={{ width: 'auto' }} value={filters.to}
          onChange={(e) => setFilters({ ...filters, to: e.target.value })} aria-label="To" />
        <span className="grow" />
        <span className="tiny muted">{data?.total ?? 0} entries</span>
      </div>

      {isLoading ? <Loading rows={8} /> : (
        <div className="table-wrap">
          <table className="data stack">
            <thead>
              <tr><th className="num">When</th><th>Who</th><th>Action</th><th>What</th><th>Where from</th><th /></tr>
            </thead>
            <tbody>
              {data!.rows.map((r) => (
                <tr key={r.id}>
                  <td className="num" data-label="When">{dateTime(r.at)}</td>
                  <td data-label="Who" className="row-title"><b>{r.username}</b></td>
                  <td data-label="Action">
                    <span className={`badge ${r.severity === 'critical' ? 'badge-danger'
                      : r.severity === 'warning' ? 'badge-warn'
                        : r.severity === 'notice' ? 'badge-info' : ''}`}>
                      {r.action}
                    </span>
                  </td>
                  <td data-label="What">
                    {r.summary}
                    <span className="cell-sub">{r.entity}{r.entity_id ? ` #${r.entity_id}` : ''}</span>
                  </td>
                  <td data-label="Where from" className="mono tiny">{r.ip || '—'}</td>
                  <td data-label="">
                    {(r.before_json || r.after_json) && (
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(r)}>
                        What changed
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && (
        <Modal title={open.summary} wide onClose={() => setOpen(null)}
          subtitle={`${open.username} · ${dateTime(open.at)} · ${open.entity}${open.entity_id ? ` #${open.entity_id}` : ''}`}>
          <div className="grid-2">
            <div className="col" style={{ gap: 6 }}>
              <span className="label">Before</span>
              <pre className="card card-pad mono tiny" style={{ overflow: 'auto', maxHeight: 400, whiteSpace: 'pre-wrap' }}>
                {open.before_json ? JSON.stringify(JSON.parse(open.before_json), null, 2) : '—'}
              </pre>
            </div>
            <div className="col" style={{ gap: 6 }}>
              <span className="label">After</span>
              <pre className="card card-pad mono tiny" style={{ overflow: 'auto', maxHeight: 400, whiteSpace: 'pre-wrap' }}>
                {open.after_json ? JSON.stringify(JSON.parse(open.after_json), null, 2) : '—'}
              </pre>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

/* =============================================================== settings */

interface BackupStatus {
  enabled: boolean; directory: string; scheduled_at: string;
  retention: { daily: number; weekly: number; monthly: number };
  last_run: { file: string; bytes: number; at: string } | null;
  last_error: string | null; count: number; total_bytes: number;
  newest: { file: string; bytes: number; at: string } | null;
}

const SETTING_LABELS: Record<string, { label: string; help: string; suffix?: string }> = {
  'factory.name': { label: 'Factory name', help: 'Shown on exports' },
  'alert.jobwork_days': { label: 'Job work escalation', help: 'Days at a vendor before it is an alert', suffix: 'days' },
  'alert.aged_wip_days': { label: 'Aged WIP', help: 'Days without movement before it is an alert', suffix: 'days' },
  'alert.dhu_pct': { label: 'DHU limit', help: 'Defects per hundred units before it is an alert', suffix: '%' },
  'alert.wastage_pct': { label: 'Fabric wastage limit', help: 'Unaccounted kilograms before it is an alert', suffix: '%' },
  'alert.fabric_lead_days': { label: 'Default fabric lead', help: 'Used when an order does not set its own', suffix: 'days' },
  'costing.default_rejection_pct': { label: 'Default rejection allowance', help: 'Starting value on a new cost sheet', suffix: '%' },
  'costing.default_fabric_wastage_pct': { label: 'Default fabric wastage', help: 'Starting value on a new fabric line', suffix: '%' },
  'costing.currency': { label: 'Default currency', help: 'For new orders and cost sheets' },
};

export function SettingsPage() {
  const { can } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Record<string, string>>({});

  const { data, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<{
      settings: { key: string; value: string; updated_at: string }[];
      backup: BackupStatus;
      backups: { file: string; bytes: number; at: string }[];
    }>('/api/settings'),
  });

  const save = useMutation({
    mutationFn: () => api.put('/api/settings', draft),
    onSuccess: () => {
      toast.ok('Settings saved');
      setDraft({});
      void qc.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (e) => toast.error(e),
  });

  const backupNow = useMutation({
    mutationFn: () => api.post<{ file: string; bytes: number }>('/api/backup/run'),
    onSuccess: (res) => {
      toast.ok('Backup written', `${res.file} · ${(res.bytes / 1_048_576).toFixed(1)} MB`);
      void qc.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (e) => toast.error(e),
  });

  const sweep = useMutation({
    mutationFn: () => api.post<{ sent: number }>('/api/maintenance/sweep-alerts'),
    onSuccess: (res) => toast.ok(`Sent ${res.sent} notification${res.sent === 1 ? '' : 's'}`),
    onError: (e) => toast.error(e),
  });

  if (isLoading || !data) return <Loading rows={6} />;

  const value = (k: string) => draft[k] ?? data.settings.find((s) => s.key === k)?.value ?? '';
  const dirty = Object.keys(draft).length > 0;
  const editable = can('settings.edit');

  return (
    <>
      <PageHead
        title="Settings &amp; backup"
        lede="The thresholds that decide when the system speaks up, and where the nightly copy of everything is written."
        actions={editable && (
          <button type="button" className="btn btn-primary" disabled={!dirty || save.isPending}
            onClick={() => save.mutate()}>
            {save.isPending && <span className="spinner" />}{dirty ? 'Save changes' : 'Saved'}
          </button>
        )}
      />

      <div className="grid-2">
        <div className="card">
          <div className="card-head"><h3>When the system speaks up</h3></div>
          <div className="card-body col" style={{ gap: 'var(--s-3)' }}>
            {Object.entries(SETTING_LABELS).map(([key, meta]) => (
              <div className="field" key={key}>
                <label htmlFor={key}>{meta.label}</label>
                <div className="input-affix">
                  <input id={key} className="input" disabled={!editable}
                    value={value(key)}
                    onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
                  {meta.suffix && <span className="suffix">{meta.suffix}</span>}
                </div>
                <span className="help">{meta.help}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="col" style={{ gap: 'var(--s-4)' }}>
          <div className="card">
            <div className="card-head">
              <h3>Nightly backup</h3>
              <span className={`badge ${data.backup.enabled ? 'badge-ok' : 'badge-warn'}`}>
                {data.backup.enabled ? `every night at ${data.backup.scheduled_at}` : 'off'}
              </span>
            </div>
            <div className="card-body col" style={{ gap: 'var(--s-3)' }}>
              <div className="field">
                <label>Written to</label>
                <div className="input mono tiny" style={{ overflowX: 'auto' }}>{data.backup.directory}</div>
                <span className="help">
                  Point this at a folder that leaves the machine — a NAS mount, a synced folder,
                  or a disk somebody takes home. A backup on the same disk is not a backup.
                </span>
              </div>

              <div className="row-wrap tiny muted">
                <span><b>{data.backup.count}</b> copies on disk</span>
                <span>· {(data.backup.total_bytes / 1_048_576).toFixed(1)} MB total</span>
                <span>· keeps {data.backup.retention.daily} daily, {data.backup.retention.weekly} weekly,
                  {' '}{data.backup.retention.monthly} monthly</span>
              </div>

              {data.backup.last_error && (
                <div className="banner banner-danger">
                  <Icon.Alert size={16} />
                  <span>The last backup failed: {data.backup.last_error}</span>
                </div>
              )}

              {data.backup.newest ? (
                <div className="banner banner-ok">
                  <Icon.Check size={16} />
                  <span>Newest copy {ago(data.backup.newest.at)} · {data.backup.newest.file}</span>
                </div>
              ) : (
                <div className="banner banner-warn">
                  <Icon.Alert size={16} />
                  <span>No backup has been written yet.</span>
                </div>
              )}

              {editable && (
                <div className="row">
                  <button type="button" className="btn" disabled={backupNow.isPending}
                    onClick={() => backupNow.mutate()}>
                    {backupNow.isPending && <span className="spinner" />}Back up now
                  </button>
                  <button type="button" className="btn btn-ghost" disabled={sweep.isPending}
                    onClick={() => sweep.mutate()}>
                    Re-send alert notifications
                  </button>
                </div>
              )}
            </div>
          </div>

          {data.backups.length > 0 && (
            <div className="card">
              <div className="card-head"><h3>Recent copies</h3></div>
              <div className="table-wrap flush">
                <table className="data">
                  <thead><tr><th>File</th><th className="num">Size</th><th className="num">Written</th></tr></thead>
                  <tbody>
                    {data.backups.slice(0, 10).map((b) => (
                      <tr key={b.file}>
                        <td className="mono tiny">{b.file}</td>
                        <td className="num">{(b.bytes / 1_048_576).toFixed(1)} MB</td>
                        <td className="num">{ago(b.at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/* ================================================================ masters */

export function MastersPage() {
  const { can } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const [active, setActive] = useState('colours');
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState('');
  const [retiring, setRetiring] = useState<{ id: number; value: string } | null>(null);

  const lists = useQuery({
    queryKey: ['master-lists'],
    queryFn: () => api.get<{ code: string; label: string; count: number }[]>('/api/masters/lists'),
  });

  const values = useQuery({
    queryKey: ['master-values', active, q],
    queryFn: () => api.get<{ value: string; use_count: number }[]>(`/api/masters/${active}`,
      { q: q || undefined, limit: 200 }),
  });

  const add = useMutation({
    mutationFn: (value: string) => api.post('/api/masters', { list_code: active, value }),
    onSuccess: () => {
      toast.ok('Added');
      setAdding('');
      void qc.invalidateQueries({ queryKey: ['master-values'] });
      void qc.invalidateQueries({ queryKey: ['master-lists'] });
    },
    onError: (e) => toast.error(e),
  });

  return (
    <>
      <PageHead
        title="Master data"
        lede="Every dropdown in the app reads from here. Values are also created wherever they are needed — typing a new colour on a cutting entry adds it — so this screen is mostly for tidying up."
      />

      <div className="split">
        <div className="card">
          <div className="card-head">
            <h3>{lists.data?.find((l) => l.code === active)?.label ?? active}</h3>
            <span className="hint">most used first</span>
          </div>
          <div className="card-body col" style={{ gap: 'var(--s-3)' }}>
            <div className="row">
              <input className="input grow" placeholder="Search…" value={q}
                onChange={(e) => setQ(e.target.value)} />
              {can('masters.create') && (
                <>
                  <input className="input" placeholder="Add a value…" value={adding}
                    onChange={(e) => setAdding(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && adding.trim()) add.mutate(adding.trim()); }} />
                  <button type="button" className="btn btn-primary" disabled={!adding.trim() || add.isPending}
                    onClick={() => add.mutate(adding.trim())}>Add</button>
                </>
              )}
            </div>

            {values.isLoading ? <Loading rows={4} />
              : (values.data?.length ?? 0) === 0
                ? <Empty title="Nothing in this list yet" icon={<Icon.Grid size={20} />} />
                : (
                  <div className="row-wrap" style={{ gap: 5 }}>
                    {values.data!.map((v) => (
                      <span key={v.value} className="badge badge-lg">
                        {v.value}
                        {v.use_count > 0 && <span className="subtle"> · {v.use_count}×</span>}
                      </span>
                    ))}
                  </div>
                )}
          </div>
        </div>

        <div className="card">
          <div className="card-head"><h3>Lists</h3></div>
          <div className="card-body col" style={{ gap: 2 }}>
            {lists.data?.map((l) => (
              <button key={l.code} type="button"
                className={`nav-item ${active === l.code ? 'active' : ''}`}
                style={{ border: 0, background: active === l.code ? undefined : 'none', cursor: 'pointer', width: '100%' }}
                onClick={() => { setActive(l.code); setQ(''); }}>
                <span className="grow" style={{ textAlign: 'left' }}>{l.label}</span>
                <span className="pill quiet">{l.count}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {retiring && (
        <Confirm title={`Retire “${retiring.value}”?`} danger confirmLabel="Retire"
          onClose={() => setRetiring(null)} onConfirm={() => setRetiring(null)}
          body="It disappears from every dropdown but stays on the entries that already use it, so no history is lost." />
      )}
    </>
  );
}

/* ====================================================== buyers & vendors */

interface Buyer {
  id: number; name: string; short_code: string; excess_pct: number;
  excess_billable: number; shortfall_tolerance_pct: number; default_currency: string;
  payment_terms: string; contact: string; notes: string; order_count: number;
}

export function BuyersPage() {
  const { can } = useSession();
  const [tab, setTab] = useState('buyers');
  return (
    <>
      <PageHead
        title="Buyers &amp; vendors"
        lede="A buyer's excess rule lives here, and it is what every cost sheet and every planned-cut figure uses. Getting it right once saves arguing about it on every order."
      />
      <Tabs tabs={[{ id: 'buyers', label: 'Buyers' }, { id: 'vendors', label: 'Vendors' }]}
        active={tab} onChange={setTab} />
      {tab === 'buyers' ? <BuyersTab canEdit={can('buyers.edit')} /> : <VendorsTab canEdit={can('vendors.edit')} />}
    </>
  );
}

function BuyersTab({ canEdit }: { canEdit: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Buyer | 'new' | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['buyers'],
    queryFn: () => api.get<{ rows: Buyer[] }>('/api/buyers'),
  });

  const save = useMutation({
    mutationFn: (b: Partial<Buyer>) => b.id ? api.patch(`/api/buyers/${b.id}`, b) : api.post('/api/buyers', b),
    onSuccess: () => {
      toast.ok('Buyer saved', 'New cost sheets will use this excess rule.');
      setEditing(null);
      void qc.invalidateQueries({ queryKey: ['buyers'] });
    },
    onError: (e) => toast.error(e),
  });

  if (isLoading) return <Loading rows={5} />;

  return (
    <>
      {canEdit && (
        <div className="toolbar">
          <span className="grow" />
          <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
            <Icon.Plus size={16} /> Add a buyer
          </button>
        </div>
      )}
      <div className="table-wrap">
        <table className="data stack">
          <thead>
            <tr><th>Buyer</th><th className="num">Excess</th><th>Excess billable</th>
              <th>Currency</th><th>Terms</th><th className="num">Orders</th><th /></tr>
          </thead>
          <tbody>
            {data!.rows.map((b) => (
              <tr key={b.id}>
                <td className="row-title" data-label="Buyer"><b>{b.name}</b></td>
                <td className="num" data-label="Excess">{b.excess_pct}%</td>
                <td data-label="Excess billable">
                  <span className={`badge ${b.excess_billable ? 'badge-ok' : 'badge-warn'}`}>
                    {b.excess_billable ? 'invoiced' : 'shipped free'}
                  </span>
                </td>
                <td data-label="Currency">{b.default_currency}</td>
                <td data-label="Terms">{b.payment_terms || '—'}</td>
                <td className="num" data-label="Orders">{b.order_count}</td>
                <td data-label="">
                  {canEdit && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(b)}>Edit</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <BuyerModal buyer={editing === 'new' ? null : editing} busy={save.isPending}
          onClose={() => setEditing(null)} onSave={(b) => save.mutate(b)} />
      )}
    </>
  );
}

function BuyerModal({ buyer, onClose, onSave, busy }: {
  buyer: Buyer | null; onClose: () => void; onSave: (b: Partial<Buyer>) => void; busy: boolean;
}) {
  const [form, setForm] = useState<Partial<Buyer>>(buyer ?? {
    name: '', excess_pct: 0, excess_billable: 1, default_currency: 'INR',
    payment_terms: '', contact: '', notes: '', short_code: '', shortfall_tolerance_pct: 0,
  });
  const set = (n: Partial<Buyer>) => setForm((f) => ({ ...f, ...n }));

  return (
    <Modal
      title={buyer ? `Edit ${buyer.name}` : 'Add a buyer'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy || !form.name}
            onClick={() => onSave(form)}>
            {busy && <span className="spinner" />}Save
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 'var(--s-4)' }}>
        <div className="line-grid">
          <TextField label="Name" value={form.name ?? ''} onChange={(v) => set({ name: v })} required
            disabled={Boolean(buyer)} />
          <TextField label="Short code" value={form.short_code ?? ''} onChange={(v) => set({ short_code: v })} />
          <Combobox list="currencies" label="Currency" value={form.default_currency ?? 'INR'}
            onChange={(v) => set({ default_currency: v })} />
        </div>

        <div className="card card-pad col" style={{ gap: 'var(--s-3)', background: 'var(--bg-sunken)' }}>
          <b className="tiny">Excess</b>
          <p className="tiny muted">
            Excess ships in the same cartons as the order, so it is made, costed and dispatched.
            Whether the buyer pays for it decides whether it is revenue or a gift.
          </p>
          <div className="line-grid">
            <NumField label="Excess %" suffix="%" value={form.excess_pct ?? 0} step={0.5}
              onChange={(v) => set({ excess_pct: v })} />
            <div className="field">
              <label>Paid for</label>
              <label className="check">
                <span className="switch">
                  <input type="checkbox" checked={Boolean(form.excess_billable)}
                    onChange={(e) => set({ excess_billable: e.target.checked ? 1 : 0 })} />
                </span>
                <span className="tiny">{form.excess_billable ? 'Invoiced with the order' : 'Shipped free'}</span>
              </label>
            </div>
            <NumField label="Shortfall tolerance" suffix="%" value={form.shortfall_tolerance_pct ?? 0} step={0.5}
              onChange={(v) => set({ shortfall_tolerance_pct: v })}
              help="how short they will accept" />
          </div>
        </div>

        <TextField label="Payment terms" value={form.payment_terms ?? ''}
          onChange={(v) => set({ payment_terms: v })} placeholder="60 days from B/L" />
        <TextField label="Contact" value={form.contact ?? ''} onChange={(v) => set({ contact: v })} />
      </div>
    </Modal>
  );
}

function VendorsTab({ canEdit }: { canEdit: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: '', processes: '', contact: '', gst_no: '', notes: '' });
  const [adding, setAdding] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['vendors'],
    queryFn: () => api.get<{ rows: { id: number; name: string; processes: string; contact: string; gst_no: string }[] }>('/api/vendors'),
  });

  const save = useMutation({
    mutationFn: () => api.post('/api/vendors', form),
    onSuccess: () => {
      toast.ok('Vendor saved');
      setAdding(false);
      setForm({ name: '', processes: '', contact: '', gst_no: '', notes: '' });
      void qc.invalidateQueries({ queryKey: ['vendors'] });
    },
    onError: (e) => toast.error(e),
  });

  if (isLoading) return <Loading rows={5} />;

  return (
    <>
      {canEdit && (
        <div className="toolbar">
          <span className="grow" />
          <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
            <Icon.Plus size={16} /> Add a vendor
          </button>
        </div>
      )}
      <div className="table-wrap">
        <table className="data stack">
          <thead><tr><th>Vendor</th><th>Processes</th><th>Contact</th><th>GST</th></tr></thead>
          <tbody>
            {data!.rows.map((v) => (
              <tr key={v.id}>
                <td className="row-title" data-label="Vendor"><b>{v.name}</b></td>
                <td data-label="Processes">{v.processes || '—'}</td>
                <td data-label="Contact">{v.contact || '—'}</td>
                <td data-label="GST" className="mono tiny">{v.gst_no || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {adding && (
        <Modal title="Add a vendor" onClose={() => setAdding(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setAdding(false)}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={!form.name || save.isPending}
                onClick={() => save.mutate()}>
                {save.isPending && <span className="spinner" />}Save
              </button>
            </>
          }>
          <div className="col" style={{ gap: 'var(--s-4)' }}>
            <TextField label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} required />
            <TextField label="Processes" value={form.processes}
              onChange={(v) => setForm({ ...form, processes: v })}
              placeholder="Print, Embroidery" help="comma separated" />
            <div className="line-grid">
              <TextField label="Contact" value={form.contact} onChange={(v) => setForm({ ...form, contact: v })} />
              <TextField label="GST number" value={form.gst_no} onChange={(v) => setForm({ ...form, gst_no: v })} />
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

/* ================================================================ account */

export function AccountPage() {
  const { user, refresh } = useSession();
  const toast = useToast();
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [totpSetup, setTotpSetup] = useState<{ secret: string; url: string } | null>(null);
  const [code, setCode] = useState('');

  const sessions = useQuery({
    queryKey: ['my-sessions'],
    queryFn: () => api.get<{ rows: { id: string; created_at: string; last_seen_at: string; ip: string; user_agent: string; is_current: number }[] }>('/api/auth/sessions'),
  });

  const changePw = useMutation({
    mutationFn: () => api.post('/api/auth/password', { current_password: pw.current, new_password: pw.next }),
    onSuccess: () => {
      toast.ok('Password changed', 'Every other device has been signed out.');
      setPw({ current: '', next: '', confirm: '' });
    },
    onError: (e) => toast.error(e),
  });

  const startTotp = useMutation({
    mutationFn: () => api.post<{ secret: string; url: string }>('/api/auth/totp/start'),
    onSuccess: (res) => setTotpSetup(res),
    onError: (e) => toast.error(e),
  });

  const confirmTotp = useMutation({
    mutationFn: () => api.post('/api/auth/totp/confirm', { code }),
    onSuccess: () => {
      toast.ok('Two-factor sign-in is on');
      setTotpSetup(null);
      setCode('');
      void refresh();
    },
    onError: (e) => toast.error(e),
  });

  const revokeOthers = useMutation({
    mutationFn: () => api.post('/api/auth/sessions/revoke-others'),
    onSuccess: () => {
      toast.ok('Signed out everywhere else');
      void sessions.refetch();
    },
    onError: (e) => toast.error(e),
  });

  return (
    <>
      <PageHead title="Account &amp; security" lede={`Signed in as ${user?.full_name} (${user?.username})`} />

      <div className="grid-2">
        <div className="card">
          <div className="card-head"><h3>Change your password</h3></div>
          <div className="card-body col" style={{ gap: 'var(--s-3)' }}>
            <TextField label="Current password" type="password" value={pw.current}
              onChange={(v) => setPw({ ...pw, current: v })} />
            <TextField label="New password" type="password" value={pw.next}
              onChange={(v) => setPw({ ...pw, next: v })}
              help="At least 10 characters, with an upper-case letter and a digit" />
            <TextField label="New password again" type="password" value={pw.confirm}
              onChange={(v) => setPw({ ...pw, confirm: v })}
              error={pw.confirm && pw.next !== pw.confirm ? 'These do not match' : undefined} />
            <div>
              <button type="button" className="btn btn-primary"
                disabled={!pw.current || !pw.next || pw.next !== pw.confirm || changePw.isPending}
                onClick={() => changePw.mutate()}>
                {changePw.isPending && <span className="spinner" />}Change password
              </button>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h3>Two-factor sign-in</h3>
            <span className={`badge ${user?.totp_enabled ? 'badge-ok' : ''}`}>
              {user?.totp_enabled ? 'on' : 'off'}
            </span>
          </div>
          <div className="card-body col" style={{ gap: 'var(--s-3)' }}>
            {user?.totp_enabled ? (
              <p className="muted tiny">
                A six-digit code from your authenticator app is asked for at every sign-in.
              </p>
            ) : totpSetup ? (
              <>
                <p className="muted tiny">
                  Add this to your authenticator app, then enter the code it shows.
                </p>
                <div className="field">
                  <label>Setup key</label>
                  <div className="input mono" style={{ wordBreak: 'break-all', height: 'auto' }}>{totpSetup.secret}</div>
                </div>
                <TextField label="Code from the app" value={code} onChange={(v) => setCode(v.replace(/\D/g, ''))} />
                <div>
                  <button type="button" className="btn btn-primary" disabled={code.length !== 6 || confirmTotp.isPending}
                    onClick={() => confirmTotp.mutate()}>
                    {confirmTotp.isPending && <span className="spinner" />}Turn it on
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="muted tiny">
                  Worth turning on for anyone who can see cost, margin or user administration —
                  particularly if the system is reachable from outside the factory.
                </p>
                <div>
                  <button type="button" className="btn" onClick={() => startTotp.mutate()}>Set it up</button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Where you are signed in</h3>
          <button type="button" className="btn btn-sm" onClick={() => revokeOthers.mutate()}>
            Sign out everywhere else
          </button>
        </div>
        <div className="table-wrap flush">
          <table className="data">
            <thead><tr><th>Device</th><th>Address</th><th className="num">Started</th><th className="num">Last used</th></tr></thead>
            <tbody>
              {sessions.data?.rows.map((s) => (
                <tr key={s.id}>
                  <td className="truncate" style={{ maxWidth: 320 }}>
                    {s.user_agent || 'unknown'}
                    {s.is_current ? <span className="badge badge-ok" style={{ marginLeft: 6 }}>this one</span> : null}
                  </td>
                  <td className="mono tiny">{s.ip || '—'}</td>
                  <td className="num">{longDate(s.created_at)}</td>
                  <td className="num">{ago(s.last_seen_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card card-pad">
        <span className="label">Your permissions</span>
        <p className="tiny muted" style={{ margin: '4px 0 8px' }}>
          {user?.permissions.length} in total, from {user?.role_names.join(' and ')}.
        </p>
        <div className="row-wrap" style={{ gap: 4 }}>
          {user?.permissions.slice(0, 60).map((p) => <span key={p} className="badge tiny">{p}</span>)}
          {(user?.permissions.length ?? 0) > 60 && (
            <span className="badge">and {(user!.permissions.length) - 60} more</span>
          )}
        </div>
      </div>
    </>
  );
}
