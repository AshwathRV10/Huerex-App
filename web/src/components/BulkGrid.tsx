import { useCallback, useMemo, useRef, useState } from 'react';
import { Combobox } from './Combobox';
import { useToast } from '../lib/toast';
import { today } from '../lib/format';
import { useHandheld } from '../lib/useMedia';

/**
 * Bulk entry.
 *
 * The floor does not enter one row at a time — a cutting table logs eight
 * sizes of the same colour in one go, and only the size and the quantity
 * change between them. So:
 *
 *   · fields marked `carry` are copied into every new row from the one above
 *   · a column can be filled down over every row in one click
 *   · Enter at the end of a row starts the next one, already carried forward
 *   · a block of cells pasted from a spreadsheet fills the grid
 *
 * Nothing is sent until the whole grid is valid, and the row that is wrong
 * says why in the row itself rather than in a message at the top.
 */

export type FieldType = 'text' | 'number' | 'date' | 'combo' | 'select' | 'check';

export interface GridColumn {
  key: string;
  label: string;
  type: FieldType;
  /** master list code when type is 'combo' */
  list?: string;
  options?: { value: string; label: string }[];
  width?: number;
  /** copied into the next row automatically */
  carry?: boolean;
  required?: boolean;
  min?: number;
  step?: number;
  placeholder?: string;
  /** short line under the header, shown on the entry screen only */
  hint?: string;
  align?: 'left' | 'right';
}

export type GridRow = Record<string, string | number | boolean>;

interface Props {
  columns: GridColumn[];
  rows: GridRow[];
  onChange: (rows: GridRow[]) => void;
  /** default values for a brand-new row (before carry-forward is applied) */
  blank: GridRow;
  minRows?: number;
  /** returns a message when the row cannot be saved */
  validate?: (row: GridRow) => string | null;
  disabled?: boolean;
}

export function makeBlank(columns: GridColumn[], seed: GridRow = {}): GridRow {
  const row: GridRow = {};
  for (const c of columns) {
    row[c.key] = c.type === 'number' ? 0 : c.type === 'check' ? false : c.type === 'date' ? today() : '';
  }
  return { ...row, ...seed };
}

/** What a new row looks like: the template, plus whatever carries forward. */
export function carriedTemplate(columns: GridColumn[], blank: GridRow, previous?: GridRow): GridRow {
  const fresh = { ...blank };
  if (!previous) return fresh;
  for (const c of columns) {
    if (c.carry && previous[c.key] !== undefined && previous[c.key] !== '') fresh[c.key] = previous[c.key];
  }
  return fresh;
}

/**
 * A row counts as blank while it still contains nothing the operator typed.
 *
 * That is not the same as "every field is empty". A screen seeds the date to
 * today and "counts as a garment" to true, and carry-forward copies the
 * colour and the fabric down from the row above — so an untouched row is
 * full of values that came from the app rather than from a person. Comparing
 * it against the row the app would have created is what tells the two apart;
 * without it a freshly carried row is offered for saving and then rejected
 * for missing the quantity nobody has typed yet.
 */
export function isBlankRow(
  row: GridRow, columns: GridColumn[], blank?: GridRow, previous?: GridRow,
): boolean {
  if (blank) {
    const template = carriedTemplate(columns, blank, previous);
    return columns.every((c) => String(row[c.key] ?? '') === String(template[c.key] ?? ''));
  }
  return columns.every((c) => {
    const v = row[c.key];
    if (c.type === 'number') return !v;
    if (c.type === 'check') return !v;
    if (c.type === 'date') return !v || v === today();
    return !v || String(v).trim() === '';
  });
}

/** The rows that carry something worth saving, in order. */
export function filledRows(rows: GridRow[], columns: GridColumn[], blank: GridRow): GridRow[] {
  return rows.filter((r, i) => !isBlankRow(r, columns, blank, i > 0 ? rows[i - 1] : undefined));
}

export function BulkGrid({ columns, rows, onChange, blank, minRows = 1, validate, disabled }: Props) {
  const toast = useToast();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [focusCell, setFocusCell] = useState<{ r: number; c: number } | null>(null);

  const untouched = useCallback(
    (row: GridRow, index: number) => isBlankRow(row, columns, blank, index > 0 ? rows[index - 1] : undefined),
    [rows, columns, blank],
  );

  const errors = useMemo(
    () => rows.map((r, i) => (untouched(r, i) ? null : validate?.(r) ?? null)),
    [rows, validate, untouched],
  );

  const carriedFrom = useCallback(
    (source: GridRow | undefined): GridRow => carriedTemplate(columns, blank, source),
    [blank, columns],
  );

  const setCell = useCallback((index: number, key: string, value: string | number | boolean) => {
    const next = rows.map((r, i) => (i === index ? { ...r, [key]: value } : r));
    // Typing in the last row starts the next one, so the grid never runs out.
    if (index === rows.length - 1 && !untouched(next[index], index)) {
      next.push(carriedFrom(next[index]));
    }
    onChange(next);
  }, [rows, onChange, carriedFrom, untouched]);

  const addRow = useCallback(() => {
    onChange([...rows, carriedFrom(rows[rows.length - 1])]);
  }, [rows, onChange, carriedFrom]);

  const removeRow = useCallback((index: number) => {
    const next = rows.filter((_, i) => i !== index);
    onChange(next.length >= minRows ? next : [...next, { ...blank }]);
  }, [rows, onChange, minRows, blank]);

  const fillDown = useCallback((key: string) => {
    const first = rows[0]?.[key];
    if (first === undefined || first === '') { toast.push({ kind: 'warn', title: 'Fill the first row first' }); return; }
    onChange(rows.map((r, i) => (untouched(r, i) ? r : { ...r, [key]: first })));
    toast.ok(`Filled ${key.replace(/_/g, ' ')} down`, 'Every row now matches the first.');
  }, [rows, onChange, toast, untouched]);

  /** Paste a block from a spreadsheet straight into the grid. */
  const onPaste = useCallback((e: React.ClipboardEvent, startRow: number, startCol: number) => {
    const text = e.clipboardData.getData('text/plain');
    if (!text.includes('\t') && !text.includes('\n')) return; // a single value pastes normally
    e.preventDefault();
    const matrix = text.replace(/\r/g, '').split('\n').filter((l) => l.length).map((l) => l.split('\t'));
    const next = [...rows];
    matrix.forEach((line, ri) => {
      const target = startRow + ri;
      while (next.length <= target) next.push(carriedFrom(next[next.length - 1]));
      const row = { ...next[target] };
      line.forEach((cell, ci) => {
        const col = columns[startCol + ci];
        if (!col) return;
        const raw = cell.trim();
        row[col.key] = col.type === 'number' ? Number(raw.replace(/[^0-9.\-]/g, '')) || 0
          : col.type === 'check' ? /^(y|yes|true|1)$/i.test(raw)
            : raw;
      });
      next[target] = row;
    });
    if (!isBlankRow(next[next.length - 1], columns, blank, next[next.length - 2])) {
      next.push(carriedFrom(next[next.length - 1]));
    }
    onChange(next);
    toast.ok(`Pasted ${matrix.length} row${matrix.length === 1 ? '' : 's'}`, 'Check them before saving.');
  }, [rows, columns, onChange, carriedFrom, toast, blank]);

  function onKeyDown(e: React.KeyboardEvent, r: number, c: number) {
    if (e.key === 'Enter' && !e.shiftKey && !(e.metaKey || e.ctrlKey)) {
      const isLastCol = c === columns.length - 1;
      if (isLastCol) {
        e.preventDefault();
        if (r === rows.length - 1) addRow();
        setTimeout(() => focus(r + 1, 0), 0);
      }
      return;
    }
    if (e.key === 'ArrowDown' && !e.shiftKey) { e.preventDefault(); focus(r + 1, c); }
    if (e.key === 'ArrowUp' && !e.shiftKey) { e.preventDefault(); focus(r - 1, c); }
  }

  function focus(r: number, c: number) {
    const el = wrapRef.current?.querySelector<HTMLElement>(`[data-cell="${r}-${c}"] input, [data-cell="${r}-${c}"] select`);
    el?.focus();
    if (el instanceof HTMLInputElement) el.select?.();
    setFocusCell({ r, c });
  }

  const filled = rows.filter((r, i) => !untouched(r, i)).length;
  const bad = errors.filter(Boolean).length;
  const handheld = useHandheld();

  /**
   * On a phone the grid becomes one card per row.
   *
   * A twelve-column table on a 390px screen means scrolling sideways to fill
   * in a single entry, which is exactly what makes a floor system get filled
   * in later, from memory, at a desk. Carry-forward, validation and paste all
   * behave the same — only the arrangement changes.
   */
  if (handheld) {
    return (
      <div className="col" style={{ gap: 'var(--s-3)' }}>
        {rows.map((row, r) => {
          const err = errors[r];
          const empty = untouched(row, r);
          if (empty && r < rows.length - 1) return null;
          return (
            <div key={r} className={`card card-pad col entry-card ${err ? 'invalid' : ''}`}
              style={{ gap: 'var(--s-3)' }}>
              <div className="between">
                <span className="label">
                  {empty ? 'New entry' : `Entry ${r + 1}`}
                </span>
                {!disabled && !empty && (
                  <button type="button" className="btn btn-ghost btn-sm"
                    onClick={() => removeRow(r)}>Remove</button>
                )}
              </div>
              <div className="line-grid">
                {columns.map((col) => (
                  <div key={col.key} className="field">
                    <label>
                      {col.label}
                      {col.required && <span aria-hidden="true" style={{ color: 'var(--danger)' }}> *</span>}
                    </label>
                    <Cell col={col} value={row[col.key]} disabled={disabled}
                      onChange={(v) => setCell(r, col.key, v)} />
                    {col.hint && <span className="help">{col.hint}</span>}
                  </div>
                ))}
              </div>
              {err && <div className="banner banner-danger">{err}</div>}
            </div>
          );
        })}

        <div className="between">
          <button type="button" className="btn" onClick={addRow} disabled={disabled}>
            + Add another
          </button>
          <span className="tiny muted">
            {filled} ready{bad > 0 ? ` · ${bad} to fix` : ''}
          </span>
        </div>
        <p className="tiny subtle">
          The next entry keeps this one's date, colour and fabric — only what
          changes has to be typed.
        </p>
      </div>
    );
  }

  return (
    <div className="col" style={{ gap: 'var(--s-3)' }}>
      <div className="bulk-wrap" ref={wrapRef}>
        <table className="bulk">
          <thead>
            <tr>
              <th className="bulk-rowno" aria-label="Row" />
              {columns.map((col) => (
                <th key={col.key} style={{ width: col.width, minWidth: col.width ?? 110 }}>
                  <div className="row" style={{ gap: 4 }}>
                    <span>{col.label}{col.required && <span style={{ color: 'var(--danger)' }}> *</span>}</span>
                    {rows.length > 1 && !disabled && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm btn-icon"
                        title={`Copy the first ${col.label} down every row`}
                        aria-label={`Fill ${col.label} down`}
                        onClick={() => fillDown(col.key)}
                        style={{ width: 22, minHeight: 22, opacity: 0.6 }}
                      >
                        ↓
                      </button>
                    )}
                  </div>
                  {col.hint && <div className="tiny subtle" style={{ fontWeight: 400 }}>{col.hint}</div>}
                </th>
              ))}
              <th style={{ width: 40 }} aria-label="Remove" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => {
              const err = errors[r];
              const empty = untouched(row, r);
              return (
                <tr key={r} className={`${err ? 'invalid' : ''} ${!empty && !err ? 'filled' : ''}`}>
                  <td className="bulk-rowno">{r + 1}</td>
                  {columns.map((col, c) => (
                    <td key={col.key} data-cell={`${r}-${c}`}
                      onPaste={(e) => onPaste(e, r, c)}
                      onKeyDown={(e) => onKeyDown(e, r, c)}>
                      <Cell
                        col={col}
                        value={row[col.key]}
                        disabled={disabled}
                        onChange={(v) => setCell(r, col.key, v)}
                        autoFocus={focusCell?.r === r && focusCell?.c === c}
                      />
                    </td>
                  ))}
                  <td>
                    {!disabled && (rows.length > minRows || !empty) && (
                      <button type="button" className="btn btn-ghost btn-sm btn-icon"
                        aria-label={`Remove row ${r + 1}`} title="Remove this row"
                        onClick={() => removeRow(r)}>✕</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="between">
        <div className="row-wrap tiny muted">
          <button type="button" className="btn btn-sm" onClick={addRow} disabled={disabled}>+ Add row</button>
          <span>{filled} row{filled === 1 ? '' : 's'} ready</span>
          {bad > 0 && <span className="badge badge-danger">{bad} need{bad === 1 ? 's' : ''} fixing</span>}
        </div>
        <span className="tiny subtle desktop-only">
          Enter for the next row · ↓ to move down · paste a block from a spreadsheet
        </span>
      </div>

      {bad > 0 && (
        <div className="banner banner-danger">
          <div>
            {errors.map((e, i) => (e ? <div key={i}><b>Row {i + 1}:</b> {e}</div> : null))}
          </div>
        </div>
      )}
    </div>
  );
}

function Cell({ col, value, onChange, disabled, autoFocus }: {
  col: GridColumn;
  value: string | number | boolean | undefined;
  onChange: (v: string | number | boolean) => void;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  if (col.type === 'combo' && col.list) {
    return (
      <Combobox
        list={col.list}
        value={String(value ?? '')}
        onChange={onChange}
        disabled={disabled}
        placeholder={col.placeholder ?? '—'}
      />
    );
  }
  if (col.type === 'select') {
    return (
      <select className="select" value={String(value ?? '')} disabled={disabled}
        onChange={(e) => onChange(e.target.value)}>
        {(col.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  }
  if (col.type === 'check') {
    return (
      <label className="check" style={{ justifyContent: 'center' }}>
        <input type="checkbox" checked={Boolean(value)} disabled={disabled}
          onChange={(e) => onChange(e.target.checked)} />
        <span className="sr-only">{col.label}</span>
      </label>
    );
  }
  if (col.type === 'number') {
    return (
      <input
        type="number" inputMode="decimal" className="input input-num"
        min={col.min ?? 0} step={col.step ?? 1} disabled={disabled} autoFocus={autoFocus}
        placeholder={col.placeholder ?? '0'}
        value={value === 0 || value === undefined || value === '' ? (value === 0 ? '0' : '') : String(value)}
        onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))}
      />
    );
  }
  return (
    <input
      type={col.type === 'date' ? 'date' : 'text'}
      className="input" disabled={disabled} autoFocus={autoFocus}
      placeholder={col.placeholder}
      style={col.align === 'right' ? { textAlign: 'right' } : undefined}
      value={String(value ?? '')}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
