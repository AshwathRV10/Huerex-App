import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError } from './api';

export type ToastKind = 'ok' | 'error' | 'warn' | 'info';

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  body?: string;
  /** An action lets a mistake be taken back rather than merely reported. */
  action?: { label: string; run: () => void };
  ms: number;
}

interface ToastValue {
  push: (t: Omit<Toast, 'id' | 'ms'> & { ms?: number }) => number;
  ok: (title: string, body?: string) => void;
  error: (err: unknown, fallback?: string) => void;
  dismiss: (id: number) => void;
}

const Ctx = createContext<ToastValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setItems((cur) => cur.filter((t) => t.id !== id));
  }, []);

  const push = useCallback<ToastValue['push']>((t) => {
    const id = nextId.current;
    nextId.current += 1;
    const ms = t.ms ?? (t.kind === 'error' ? 9000 : t.action ? 8000 : 4000);
    setItems((cur) => [...cur.slice(-4), { ...t, id, ms }]);
    if (ms > 0) window.setTimeout(() => dismiss(id), ms);
    return id;
  }, [dismiss]);

  const value = useMemo<ToastValue>(() => ({
    push,
    dismiss,
    ok: (title, body) => { push({ kind: 'ok', title, body }); },
    error: (err, fallback = 'That did not work') => {
      const message = err instanceof ApiError ? err.message
        : err instanceof Error ? err.message : fallback;
      push({ kind: 'error', title: message });
    },
  }), [push, dismiss]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <div className="grow">
              <strong>{t.title}</strong>
              {t.body && <span className="muted tiny">{t.body}</span>}
            </div>
            {t.action && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => { t.action!.run(); dismiss(t.id); }}
              >
                {t.action.label}
              </button>
            )}
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-icon close"
              aria-label="Dismiss"
              onClick={() => dismiss(t.id)}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
