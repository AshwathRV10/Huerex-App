import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { NAV, type NavEntry } from './nav';
import { Icon } from './Icons';
import { ago, initials } from '../lib/format';
import { useToast } from '../lib/toast';

type Theme = 'light' | 'dark' | 'system';

function readTheme(): Theme {
  const t = localStorage.getItem('huerex.theme');
  return t === 'light' || t === 'dark' ? t : 'system';
}

function applyTheme(t: Theme): void {
  const root = document.documentElement;
  if (t === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', t);
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, can, signOut } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const [railOpen, setRailOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('huerex.rail') === 'collapsed');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(readTheme);

  useEffect(() => { applyTheme(theme); }, [theme]);
  useEffect(() => { localStorage.setItem('huerex.rail', collapsed ? 'collapsed' : 'open'); }, [collapsed]);
  useEffect(() => { setRailOpen(false); setMenuOpen(false); setBellOpen(false); }, [location.pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
      if (e.key === 'Escape') { setMenuOpen(false); setBellOpen(false); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const { data: notifications } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<{ rows: NotificationRow[]; unread: number }>('/api/notifications', { limit: 25 }),
    refetchInterval: 60_000,
    enabled: Boolean(user),
  });

  const groups = useMemo(
    () => NAV.map((g) => ({ ...g, items: g.items.filter((i) => can(i.perm)) })).filter((g) => g.items.length),
    [can],
  );

  const current = useMemo(() => {
    const all = groups.flatMap((g) => g.items);
    return all.find((i) => i.to === location.pathname)
      ?? all.filter((i) => i.to !== '/').find((i) => location.pathname.startsWith(i.to));
  }, [groups, location.pathname]);

  const unread = notifications?.unread ?? 0;

  return (
    <div className={`shell ${collapsed ? 'collapsed' : ''} ${railOpen ? 'rail-open' : ''}`}>
      <a className="skip-link" href="#main">Skip to content</a>
      <div className="rail-scrim" onClick={() => setRailOpen(false)} />

      <nav className="rail" aria-label="Sections">
        <div className="rail-head">
          <Link to="/" className="row" style={{ textDecoration: 'none', color: 'inherit', gap: 'var(--s-3)' }}>
            <span className="brand-mark">HX</span>
            <span className="brand-text">
              <b>HUEREX</b>
              <span>Factory execution</span>
            </span>
          </Link>
        </div>

        <div className="rail-nav">
          {groups.map((g) => (
            <div className="nav-group" key={g.title}>
              <h4>{g.title}</h4>
              {g.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/'}
                  className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                  title={collapsed ? item.label : undefined}
                >
                  <NavIcon name={item.icon} />
                  <span className="label truncate">{item.label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </div>

        <div className="rail-foot">
          <button
            type="button"
            className="nav-item desktop-only"
            style={{ width: '100%', background: 'none', border: 0, cursor: 'pointer' }}
            onClick={() => setCollapsed((v) => !v)}
            aria-label={collapsed ? 'Expand the menu' : 'Collapse the menu'}
          >
            <span className="ico" style={{ transform: collapsed ? 'none' : 'rotate(180deg)', transition: 'transform var(--dur)' }}>
              <Icon.Chevron size={18} />
            </span>
            <span className="label">Collapse</span>
          </button>
        </div>
      </nav>

      <div className="main">
        <header className="topbar">
          <button type="button" className="btn btn-ghost btn-icon mobile-only"
            aria-label="Open the menu" onClick={() => setRailOpen(true)}>
            <Icon.Menu />
          </button>

          <div className="grow desktop-only" style={{ minWidth: 0 }}>
            <div className="page-title truncate">{current?.label ?? 'HUEREX'}</div>
          </div>

          <button type="button" className="omni" onClick={() => setPaletteOpen(true)}>
            <Icon.Search size={15} />
            <span className="truncate">Search or jump to…</span>
            <kbd>⌘K</kbd>
          </button>

          <div style={{ position: 'relative' }}>
            <button type="button" className="btn btn-ghost btn-icon bell"
              aria-label={unread ? `${unread} unread notifications` : 'Notifications'}
              onClick={() => { setBellOpen((v) => !v); setMenuOpen(false); }}>
              <Icon.Bell />
              {unread > 0 && <span className="count">{unread > 99 ? '99+' : unread}</span>}
            </button>
            {bellOpen && (
              <NotificationMenu
                rows={notifications?.rows ?? []}
                onClose={() => setBellOpen(false)}
                onOpen={(link) => { setBellOpen(false); if (link) navigate(link); }}
              />
            )}
          </div>

          <div style={{ position: 'relative' }}>
            <button type="button" className="avatar" aria-label="Your account"
              onClick={() => { setMenuOpen((v) => !v); setBellOpen(false); }}>
              {initials(user?.full_name ?? '?')}
            </button>
            {menuOpen && (
              <div className="menu" onMouseLeave={() => setMenuOpen(false)}>
                <div className="menu-label">{user?.full_name}</div>
                <div className="menu-item" style={{ cursor: 'default', paddingTop: 0 }}>
                  <span className="tiny muted">{user?.role_names.join(' · ')}</span>
                </div>
                <div className="menu-sep" />
                <Link className="menu-item" to="/account"><Icon.Settings size={16} /> Account &amp; security</Link>
                <button type="button" className="menu-item" onClick={() => {
                  const next: Theme = theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark';
                  setTheme(next);
                  localStorage.setItem('huerex.theme', next);
                }}>
                  {theme === 'dark' ? <Icon.Sun size={16} /> : <Icon.Moon size={16} />}
                  Theme: {theme === 'system' ? 'follow device' : theme}
                </button>
                <div className="menu-sep" />
                <button type="button" className="menu-item danger" onClick={() => void signOut()}>
                  <Icon.Logout size={16} /> Sign out
                </button>
              </div>
            )}
          </div>
        </header>

        <main id="main" className="page">{children}</main>
      </div>

      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}

function NavIcon({ name }: { name: NavEntry['icon'] }) {
  const C = Icon[name];
  return <span className="ico"><C size={18} /></span>;
}

/* -------------------------------------------------------------- palette -- */

interface OrderHit { order_no: string; buyer: string; style: string; status: string }

function CommandPalette({ onClose }: { onClose: () => void }) {
  const { can } = useSession();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const pages = useMemo(
    () => NAV.flatMap((g) => g.items)
      .filter((i) => can(i.perm))
      .filter((i) => {
        const t = q.trim().toLowerCase();
        if (!t) return true;
        return i.label.toLowerCase().includes(t) || (i.keywords ?? '').includes(t);
      })
      .slice(0, 8),
    [q, can],
  );

  // Orders are searched by number, style or buyer, because "where is HR-014"
  // is the single most common thing anyone wants from this box.
  const { data: orders } = useQuery({
    queryKey: ['palette-orders', q],
    queryFn: () => api.get<{ rows: OrderHit[] }>('/api/orders', { q, limit: 6 }),
    enabled: can('orders.view') && q.trim().length >= 2,
    staleTime: 20_000,
  });
  const orderHits = orders?.rows ?? [];

  const items = useMemo(() => [
    ...pages.map((p) => ({ kind: 'page' as const, key: p.to, label: p.label, sub: 'Go to', to: p.to })),
    ...orderHits.map((o) => ({
      kind: 'order' as const, key: o.order_no, label: o.order_no,
      sub: `${o.buyer} · ${o.style}`.slice(0, 70), to: `/orders/${encodeURIComponent(o.order_no)}`,
    })),
  ], [pages, orderHits]);

  useEffect(() => { setActive(0); }, [q]);

  function go(index: number) {
    const item = items[index];
    if (!item) return;
    navigate(item.to);
    onClose();
  }

  return (
    <div className="overlay" style={{ alignItems: 'flex-start', paddingTop: '10vh' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ width: 'min(600px, 100%)' }} role="dialog" aria-modal="true" aria-label="Search">
        <div style={{ padding: 'var(--s-3) var(--s-4)', borderBottom: '1px solid var(--line)' }}>
          <div className="row">
            <Icon.Search size={17} />
            <input
              ref={inputRef}
              className="input"
              style={{ border: 0, background: 'transparent', fontSize: 'var(--text-md)' }}
              placeholder="Search orders, or jump to a screen…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % Math.max(items.length, 1)); }
                if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + items.length) % Math.max(items.length, 1)); }
                if (e.key === 'Enter') { e.preventDefault(); go(active); }
                if (e.key === 'Escape') onClose();
              }}
            />
          </div>
        </div>
        <div className="modal-body" style={{ padding: 5, maxHeight: 400 }}>
          {items.length === 0 && <div className="combo-empty">Nothing matches “{q}”.</div>}
          {items.map((it, i) => (
            <div key={`${it.kind}-${it.key}`} className="combo-opt" aria-selected={i === active}
              role="option" onMouseEnter={() => setActive(i)} onMouseDown={() => go(i)}>
              {it.kind === 'order' ? <Icon.Order size={16} /> : <Icon.Chevron size={16} />}
              <span className="grow truncate">
                <b>{it.label}</b>
                <span className="cell-sub">{it.sub}</span>
              </span>
            </div>
          ))}
        </div>
        <div className="modal-foot" style={{ justifyContent: 'space-between' }}>
          <span className="tiny subtle">↑↓ to move · Enter to open · Esc to close</span>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------- notifications -- */

interface NotificationRow {
  id: number; created_at: string; kind: string; severity: string;
  title: string; body: string; link: string; read_by_me: number;
}

function NotificationMenu({ rows, onClose, onOpen }: {
  rows: NotificationRow[]; onClose: () => void; onOpen: (link: string) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();

  async function markAll() {
    try {
      await api.post('/api/notifications/read-all');
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    } catch (e) { toast.error(e); }
  }

  async function open(n: NotificationRow) {
    try { await api.post(`/api/notifications/${n.id}/read`); } catch { /* reading is best effort */ }
    void qc.invalidateQueries({ queryKey: ['notifications'] });
    onOpen(n.link);
  }

  return (
    <div className="menu" style={{ width: 'min(400px, 92vw)', maxHeight: 460, overflow: 'auto' }}
      onMouseLeave={onClose}>
      <div className="between" style={{ padding: 'var(--s-2) var(--s-3)' }}>
        <span className="menu-label" style={{ padding: 0 }}>Notifications</span>
        {rows.some((r) => !r.read_by_me) && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void markAll()}>
            Mark all read
          </button>
        )}
      </div>
      <div className="menu-sep" />
      {rows.length === 0 && (
        <div className="combo-empty">Nothing needs you right now.</div>
      )}
      {rows.map((n) => (
        <button key={n.id} type="button" className="menu-item" style={{ alignItems: 'flex-start' }}
          onClick={() => void open(n)}>
          <span className="dot" style={{
            marginTop: 6,
            color: n.severity === 'critical' ? 'var(--danger)'
              : n.severity === 'warning' ? 'var(--warn)' : 'var(--info)',
            opacity: n.read_by_me ? 0.3 : 1,
          }} />
          <span className="grow" style={{ minWidth: 0 }}>
            <b style={{ fontWeight: n.read_by_me ? 500 : 640, display: 'block' }}>{n.title}</b>
            <span className="tiny muted" style={{ display: 'block' }}>{n.body}</span>
            <span className="tiny subtle">{ago(n.created_at)}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
