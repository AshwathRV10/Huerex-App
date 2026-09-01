import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

/**
 * Order picker.
 *
 * Orders are not a master list — they are live records with a buyer, a style
 * and a state — so this searches them properly and shows enough beside each
 * number that "HR-005-T" and "HR-005-B" can be told apart without opening
 * either of them.
 */

interface OrderHit {
  order_no: string; buyer: string; style: string; status: string;
  order_qty: number; ex_factory_date: string | null;
}

interface Props {
  value: string;
  onChange: (orderNo: string) => void;
  label?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  liveOnly?: boolean;
  help?: string;
  autoFocus?: boolean;
}

export function OrderPicker({
  value, onChange, label = 'Order', placeholder = 'Type an order number, buyer or style…',
  required, disabled, liveOnly = false, help, autoFocus,
}: Props) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  const { data, isFetching } = useQuery({
    queryKey: ['order-picker', query, liveOnly],
    queryFn: () => api.get<{ rows: OrderHit[] }>('/api/orders', {
      q: query || undefined, limit: 25, status: liveOnly ? 'Active' : undefined,
    }),
    enabled: open,
    staleTime: 30_000,
  });

  const rows = useMemo(() => data?.rows ?? [], [data]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) { setOpen(false); setQuery(''); }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => { setActive(0); }, [query]);

  function pick(index: number) {
    const hit = rows[index];
    if (!hit) return;
    onChange(hit.order_no);
    setOpen(false);
    setQuery('');
  }

  return (
    <div className="field">
      {label && (
        <label htmlFor={id}>
          {label}{required && <span aria-hidden="true" style={{ color: 'var(--danger)' }}> *</span>}
        </label>
      )}
      <div className="combo" ref={boxRef}>
        <input
          id={id}
          className="input combo-input"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          autoFocus={autoFocus}
          value={open ? query : value}
          placeholder={value || placeholder}
          onFocus={() => { setOpen(true); setQuery(''); }}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % Math.max(rows.length, 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + rows.length) % Math.max(rows.length, 1)); }
            if (e.key === 'Enter' && open) { e.preventDefault(); pick(active); }
            if (e.key === 'Escape') { setOpen(false); setQuery(''); }
          }}
        />
        {open && (
          <div className="combo-menu" role="listbox">
            {rows.map((o, i) => (
              <div key={o.order_no} role="option" aria-selected={i === active} className="combo-opt"
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => { e.preventDefault(); pick(i); }}>
                <span className="grow" style={{ minWidth: 0 }}>
                  <b>{o.order_no}</b>
                  <span className="cell-sub truncate">{o.buyer} · {o.style || 'no style'}</span>
                </span>
                {o.status !== 'Active' && <span className="badge">{o.status}</span>}
              </div>
            ))}
            {rows.length === 0 && (
              <div className="combo-empty">{isFetching ? 'Looking…' : 'No order matches that.'}</div>
            )}
          </div>
        )}
      </div>
      {help && <span className="help">{help}</span>}
    </div>
  );
}
