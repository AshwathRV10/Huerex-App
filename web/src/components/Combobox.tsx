import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Floating } from './Floating';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useToast } from '../lib/toast';
import { useSession } from '../lib/session';

/**
 * Type to search. Keep typing to add.
 *
 * The whole point is that nobody leaves a half-filled entry screen to go and
 * register a new colour somewhere else. If what you typed is not on the list,
 * the last option is "Add …" — press Enter and it exists from then on, for
 * everyone, attributed to you.
 *
 * Values are ordered by how often they are actually used, so the three colours
 * this factory cuts every week are the first three every time.
 */

export interface ComboOption { value: string; use_count?: number; meta?: Record<string, unknown> }

interface Props {
  /** master list code, e.g. "colours" */
  list: string;
  value: string;
  onChange: (value: string) => void;
  label?: string;
  placeholder?: string;
  /** turn off in-place creation for lists that must stay closed */
  allowCreate?: boolean;
  /** extra options merged in front of the remembered ones */
  extra?: string[];
  disabled?: boolean;
  required?: boolean;
  autoFocus?: boolean;
  className?: string;
  help?: string;
  error?: string;
  onEnterNext?: () => void;
  id?: string;
}

export function Combobox({
  list, value, onChange, label, placeholder, allowCreate = true, extra,
  disabled, required, autoFocus, className, help, error, onEnterNext, id,
}: Props) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // The menu is portalled out of the field, so "outside" has to mean outside
  // both of them or choosing an option would count as a click away.
  const menuRef = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const qc = useQueryClient();
  const { can } = useSession();

  const canCreate = allowCreate && can('masters.create');

  const { data = [], isFetching } = useQuery({
    queryKey: ['masters', list, query],
    queryFn: () => api.get<ComboOption[]>(`/api/masters/${list}`, { q: query, limit: 40 }),
    staleTime: 30_000,
    enabled: open,
  });

  const options = useMemo(() => {
    const seen = new Set<string>();
    const out: ComboOption[] = [];
    for (const e of extra ?? []) {
      if (e && !seen.has(e.toLowerCase())) { seen.add(e.toLowerCase()); out.push({ value: e }); }
    }
    for (const o of data) {
      if (!seen.has(o.value.toLowerCase())) { seen.add(o.value.toLowerCase()); out.push(o); }
    }
    return out;
  }, [data, extra]);

  const typed = query.trim();
  const exactMatch = options.some((o) => o.value.toLowerCase() === typed.toLowerCase());
  const showCreate = canCreate && typed.length > 0 && !exactMatch;
  const rowCount = options.length + (showCreate ? 1 : 0);

  const create = useMutation({
    mutationFn: (v: string) => api.post<{ value: string }>('/api/masters', { list_code: list, value: v }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['masters', list] });
      onChange(res.value);
      toast.ok(`Added “${res.value}”`, 'Everyone will see it from now on.');
      close();
      onEnterNext?.();
    },
    onError: (e) => toast.error(e),
  });

  function close() {
    setOpen(false);
    setQuery('');
    setActive(0);
  }

  function commit(index: number) {
    if (showCreate && index === options.length) {
      create.mutate(typed);
      return;
    }
    const opt = options[index];
    if (!opt) return;
    onChange(opt.value);
    close();
    onEnterNext?.();
  }

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!boxRef.current?.contains(t) && !menuRef.current?.contains(t)) close();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => { setActive(0); }, [query]);

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      setActive((a) => {
        const next = e.key === 'ArrowDown' ? a + 1 : a - 1;
        return (next + rowCount) % Math.max(rowCount, 1);
      });
      return;
    }
    if (e.key === 'Enter') {
      if (open && rowCount > 0) { e.preventDefault(); commit(active); }
      else if (!open) onEnterNext?.();
      return;
    }
    if (e.key === 'Escape') { if (open) { e.preventDefault(); close(); } return; }
    if (e.key === 'Tab' && open && rowCount > 0 && typed) { commit(active); }
  }

  const display = open ? query : value;

  return (
    <div className={`field ${className ?? ''}`}>
      {label && (
        <label htmlFor={inputId}>
          {label}{required && <span aria-hidden="true" style={{ color: 'var(--danger)' }}> *</span>}
        </label>
      )}
      <div className="combo" ref={boxRef}>
        <input
          id={inputId}
          ref={inputRef}
          className="input combo-input"
          role="combobox"
          aria-expanded={open}
          aria-controls={`${inputId}-menu`}
          aria-autocomplete="list"
          aria-invalid={error ? true : undefined}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          autoFocus={autoFocus}
          value={display}
          placeholder={placeholder ?? (value ? value : 'Type to search…')}
          onFocus={() => { setOpen(true); setQuery(''); }}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onKeyDown={onKeyDown}
        />
        {open && (
          <Floating anchor={boxRef.current} panelRef={menuRef}
            className="combo-menu" id={`${inputId}-menu`} role="listbox">
            {options.map((o, i) => (
              <div
                key={o.value}
                role="option"
                aria-selected={i === active}
                className="combo-opt"
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => { e.preventDefault(); commit(i); }}
              >
                <Highlight text={o.value} term={typed} />
                {o.use_count ? <span className="meta">{o.use_count}×</span> : null}
              </div>
            ))}

            {showCreate && (
              <div
                role="option"
                aria-selected={active === options.length}
                className="combo-opt combo-new"
                onMouseEnter={() => setActive(options.length)}
                onMouseDown={(e) => { e.preventDefault(); commit(options.length); }}
              >
                {create.isPending ? <span className="spinner" /> : <span aria-hidden="true">+</span>}
                <span>Add “{typed}”</span>
                <span className="meta">Enter</span>
              </div>
            )}

            {options.length === 0 && !showCreate && (
              <div className="combo-empty">
                {isFetching ? 'Looking…'
                  : canCreate ? 'Nothing matches. Type a new value to add it.'
                    : 'Nothing matches.'}
              </div>
            )}
          </Floating>
        )}
      </div>
      {error ? <span className="err">{error}</span> : help ? <span className="help">{help}</span> : null}
    </div>
  );
}

function Highlight({ text, term }: { text: string; term: string }) {
  if (!term) return <span>{text}</span>;
  const i = text.toLowerCase().indexOf(term.toLowerCase());
  if (i < 0) return <span>{text}</span>;
  return (
    <span>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + term.length)}</mark>
      {text.slice(i + term.length)}
    </span>
  );
}
