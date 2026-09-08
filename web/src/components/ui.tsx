import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './Icons';

/* Small pieces used on nearly every screen. */

export function PageHead({ title, lede, actions, badge }: {
  title: string; lede?: ReactNode; actions?: ReactNode; badge?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div className="grow">
        <div className="row" style={{ gap: 'var(--s-3)' }}>
          <h1>{title}</h1>
          {badge}
        </div>
        {lede && <p className="lede">{lede}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function Stat({ label, value, note, accent, locked }: {
  label: string; value: ReactNode; note?: ReactNode;
  accent?: 'brand' | 'ok' | 'warn' | 'danger'; locked?: boolean;
}) {
  const cls = accent === 'brand' ? 'accent'
    : accent === 'ok' ? 'accent-ok'
      : accent === 'warn' ? 'accent-warn'
        : accent === 'danger' ? 'accent-danger' : '';
  return (
    <div className={`stat ${cls}`}>
      <span className="stat-label">{label}</span>
      {locked
        ? <span className="locked" style={{ fontSize: 'var(--text-md)' }}>Not visible to you</span>
        : <span className="stat-value">{value}</span>}
      {note && <span className="stat-note">{note}</span>}
    </div>
  );
}

export function Empty({ title, body, action, icon }: {
  title: string; body?: ReactNode; action?: ReactNode; icon?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="glyph">{icon ?? <Icon.Search size={20} />}</div>
      <h3>{title}</h3>
      {body && <p>{body}</p>}
      {action}
    </div>
  );
}

export function Loading({ rows = 5, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div className="col" aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton" style={{ height: 40, opacity: 1 - i * 0.11 }} />
      ))}
    </div>
  );
}

export function Modal({ title, subtitle, onClose, children, footer, wide }: {
  title: string; subtitle?: ReactNode; onClose: () => void;
  children: ReactNode; footer?: ReactNode; wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Callers pass an inline `onClose={() => ...}`, a fresh function on every
  // render of whoever owns the modal. Reading it through a ref, updated every
  // render but never itself a dependency, means the effect below sees a stable
  // identity regardless of how often that owner re-renders.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    // Runs once, when the dialog opens. Keyed on `onClose` it re-ran whenever
    // the owning component re-rendered, calling ref.current?.focus() again and
    // throwing focus back onto the dialog shell, away from whatever field you
    // were typing in. That is how the vendor form — which used to keep its
    // state in the same component as this call — took one keystroke and then
    // went dead. Every modal now holds its own form state, so nothing hits
    // this path today; the empty dependency list is what keeps it that way.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseRef.current(); };
    document.addEventListener('keydown', onKey);
    // Focus the dialog so Escape works and screen readers announce it.
    ref.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, []);

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${wide ? 'modal-lg' : ''}`} role="dialog" aria-modal="true"
        aria-label={title} tabIndex={-1} ref={ref}>
        <div className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p className="muted tiny" style={{ marginTop: 2 }}>{subtitle}</p>}
          </div>
          <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Drawer({ title, subtitle, onClose, children, footer }: {
  title: string; subtitle?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <div className="grow">
            <h2>{title}</h2>
            {subtitle && <p className="muted tiny" style={{ marginTop: 2 }}>{subtitle}</p>}
          </div>
          <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body grow">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </aside>
    </>
  );
}

export function Confirm({ title, body, confirmLabel = 'Confirm', danger, onConfirm, onClose, busy }: {
  title: string; body: ReactNode; confirmLabel?: string; danger?: boolean;
  onConfirm: () => void; onClose: () => void; busy?: boolean;
}) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            onClick={onConfirm} disabled={busy}>
            {busy && <span className="spinner" />}{confirmLabel}
          </button>
        </>
      }
    >
      <div className="col">{typeof body === 'string' ? <p>{body}</p> : body}</div>
    </Modal>
  );
}

export function Tabs({ tabs, active, onChange }: {
  tabs: { id: string; label: string; count?: number }[];
  active: string; onChange: (id: string) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" className="tab"
          aria-selected={t.id === active} onClick={() => onChange(t.id)}>
          {t.label}
          {t.count !== undefined && <span className="count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Meter({ value, max = 100, tone }: { value: number; max?: number; tone?: 'ok' | 'warn' | 'danger' }) {
  const pctValue = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className={`meter ${tone ?? ''}`} role="progressbar"
      aria-valuenow={Math.round(pctValue)} aria-valuemin={0} aria-valuemax={100}>
      <span style={{ width: `${pctValue}%` }} />
    </div>
  );
}

export function LockedValue() {
  return <span className="locked" title="Your role does not include this figure">Restricted</span>;
}

export function SeverityBadge({ severity }: { severity: string }) {
  const map: Record<string, string> = {
    CRITICAL: 'badge-danger', HIGH: 'badge-warn', MEDIUM: 'badge-info', LOW: 'badge',
    critical: 'badge-danger', warning: 'badge-warn', info: 'badge-info', notice: 'badge-info',
  };
  return <span className={`badge ${map[severity] ?? ''}`}>{severity}</span>;
}

export function StatusBadge({ status }: { status: string }) {
  const s = status.toLowerCase();
  const cls =
    ['approved', 'pass', 'active', 'balanced', 'healthy', 'clean', 'ok'].some((k) => s.includes(k)) ? 'badge-ok'
      : ['rejected', 'fail', 'cancelled', 'behind', 'over', 'short'].some((k) => s.includes(k)) ? 'badge-danger'
        : ['pending', 'hold', 'watch', 'draft', 'submitted'].some((k) => s.includes(k)) ? 'badge-warn'
          : ['closed', 'locked', 'complete'].some((k) => s.includes(k)) ? 'badge-info'
            : '';
  return <span className={`badge ${cls}`}>{status}</span>;
}

export function RouteBar({ steps, here }: {
  steps: { step_no: number; process: string; type: string }[]; here?: string;
}) {
  if (!steps.length) return <span className="tiny subtle">No route set</span>;
  return (
    <div className="route-bar">
      {steps.map((s) => (
        <span key={s.step_no}
          className={`route-step ${s.type === 'Outsourced' ? 'out' : ''} ${here === s.process ? 'here' : ''}`}
          title={`Step ${s.step_no} · ${s.type}`}>
          <span className="n">{s.step_no}</span>{s.process}
        </span>
      ))}
    </div>
  );
}

/** A short definition shown under a heading, so nobody has to guess a term. */
export function Note({ children, tone }: { children: ReactNode; tone?: 'warn' | 'danger' | 'ok' | 'info' }) {
  return <div className={`banner ${tone ? `banner-${tone}` : ''}`}>{children}</div>;
}
