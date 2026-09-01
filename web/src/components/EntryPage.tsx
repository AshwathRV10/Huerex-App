import { useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { useToast } from '../lib/toast';
import { BulkGrid, isBlankRow, makeBlank, type GridColumn, type GridRow } from './BulkGrid';
import { OrderPicker } from './OrderPicker';
import { Confirm, Empty, Loading, PageHead, Tabs } from './ui';
import { Icon } from './Icons';
import { date as fmtDate, today } from '../lib/format';

/**
 * Every transaction screen.
 *
 * The floor does the same thing on all of them: pick the order, log what
 * happened, and occasionally correct yesterday's entry. So they are one
 * component with a column declaration, which means bulk entry, carry-forward,
 * paste, validation, mobile layout and the audit trail all behave identically
 * wherever you are — and there is one place to improve them.
 */

export interface EntryColumn extends GridColumn {
  /** shown in the history table; defaults to the same key */
  listKey?: string;
  /** hide from the history table */
  listHide?: boolean;
  render?: (row: Record<string, unknown>) => ReactNode;
}

interface Props {
  module: string;
  endpoint: string;
  title: string;
  lede: ReactNode;
  columns: EntryColumn[];
  /** columns shown in the history table but never typed */
  derived?: { key: string; label: string; align?: 'right'; render?: (row: Record<string, unknown>) => ReactNode }[];
  /** panel above the grid: balances, route, whatever helps the person decide */
  context?: (orderNo: string) => ReactNode;
  validate?: (row: GridRow) => string | null;
  /** default row values before carry-forward */
  seed?: GridRow;
  /** most screens are per-order; a few (the store) are not */
  orderOptional?: boolean;
  /** extra buttons in the page header */
  actions?: ReactNode;
  entryTitle?: string;
}

export function EntryPage({
  module, endpoint, title, lede, columns, derived, context, validate, seed,
  orderOptional, actions, entryTitle,
}: Props) {
  const { can } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const orderNo = params.get('order') ?? '';
  const [tab, setTab] = useState<'log' | 'history'>(can(`${module}.create`) ? 'log' : 'history');
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

  const blank = useMemo(() => makeBlank(columns, { txn_date: today(), ...(seed ?? {}) }), [columns, seed]);
  const [rows, setRows] = useState<GridRow[]>(() => [makeBlank(columns, { txn_date: today(), ...(seed ?? {}) })]);
  const reset = () => setRows([makeBlank(columns, { txn_date: today(), ...(seed ?? {}) })]);

  const history = useQuery({
    queryKey: [module, 'list', orderNo],
    queryFn: () => api.get<{ rows: Record<string, unknown>[]; total: number }>(`/api/${endpoint}`,
      { order_no: orderNo || undefined, limit: 200 }),
    enabled: can(`${module}.view`),
  });

  const save = useMutation({
    mutationFn: async (payload: GridRow[]) => {
      const body = payload.map((r) => ({ ...r, order_no: orderNo || r.order_no }));
      return api.post<{ created: number }>(`/api/${endpoint}/bulk`, { rows: body });
    },
    onSuccess: (res) => {
      toast.ok(`Saved ${res.created} row${res.created === 1 ? '' : 's'}`,
        'They are counted everywhere the moment they land.');
      reset();
      void qc.invalidateQueries();
    },
    onError: (e) => toast.error(e),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/api/${endpoint}/${id}`),
    onSuccess: () => {
      toast.ok('Row removed', 'The change is in the audit log.');
      setConfirmDelete(null);
      void qc.invalidateQueries();
    },
    onError: (e) => { toast.error(e); setConfirmDelete(null); },
  });

  const ready = rows.filter((r) => !isBlankRow(r, columns, blank));
  const invalid = ready.some((r) => validate?.(r));
  const needsOrder = !orderOptional && !orderNo;

  const listColumns = columns.filter((c) => !c.listHide);

  return (
    <>
      <PageHead
        title={title}
        lede={lede}
        actions={
          <>
            {actions}
            {can(`${module}.export`) && (
              <button type="button" className="btn"
                onClick={() => api.download(`/api/${endpoint}/export`, { order_no: orderNo || undefined })}>
                <Icon.Download size={16} /> Export
              </button>
            )}
          </>
        }
      />

      <div className="toolbar">
        <div style={{ minWidth: 240, flex: '1 1 240px', maxWidth: 380 }}>
          <OrderPicker
            value={orderNo}
            onChange={(v) => setParams(v ? { order: v } : {}, { replace: true })}
            label={orderOptional ? 'Order (optional)' : 'Order'}
            required={!orderOptional}
          />
        </div>
        {orderNo && (
          <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-end' }}
            onClick={() => setParams({}, { replace: true })}>
            Clear
          </button>
        )}
      </div>

      {orderNo && context?.(orderNo)}

      <Tabs
        tabs={[
          ...(can(`${module}.create`) ? [{ id: 'log', label: entryTitle ?? 'Log entries' }] : []),
          { id: 'history', label: 'History', count: history.data?.total },
        ]}
        active={tab}
        onChange={(id) => setTab(id as 'log' | 'history')}
      />

      {tab === 'log' && can(`${module}.create`) && (
        <div className="col" style={{ gap: 'var(--s-3)' }}>
          {needsOrder && (
            <div className="banner banner-info">
              <Icon.Order size={16} />
              <span>Pick the order first — every entry is counted against it.</span>
            </div>
          )}
          <BulkGrid
            columns={columns}
            rows={rows}
            onChange={setRows}
            blank={blank}
            validate={validate}
            disabled={needsOrder}
          />
          <div className="between desktop-only">
            <span className="tiny subtle">
              Fields marked with ↓ carry forward to the next row automatically.
            </span>
            <div className="row">
              <button type="button" className="btn"
                onClick={reset}
                disabled={ready.length === 0}>
                Clear
              </button>
              <button type="button" className="btn btn-primary"
                disabled={ready.length === 0 || invalid || needsOrder || save.isPending}
                onClick={() => save.mutate(ready)}>
                {save.isPending && <span className="spinner" />}
                Save {ready.length || ''} {ready.length === 1 ? 'row' : 'rows'}
              </button>
            </div>
          </div>

          <div className="action-bar">
            <button type="button" className="btn"
              onClick={reset}
              disabled={ready.length === 0}>
              Clear
            </button>
            <button type="button" className="btn btn-primary"
              disabled={ready.length === 0 || invalid || needsOrder || save.isPending}
              onClick={() => save.mutate(ready)}>
              {save.isPending && <span className="spinner" />}
              Save {ready.length || ''}
            </button>
          </div>
        </div>
      )}

      {tab === 'history' && (
        history.isLoading ? <Loading />
          : (history.data?.rows.length ?? 0) === 0 ? (
            <div className="card">
              <Empty
                title={orderNo ? `Nothing logged for ${orderNo} yet` : 'Nothing logged yet'}
                body="Entries appear here the moment they are saved, newest first."
                icon={<Icon.Book size={20} />}
              />
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data stack">
                <thead>
                  <tr>
                    {!orderNo && <th>Order</th>}
                    {listColumns.map((c) => (
                      <th key={c.key} className={c.type === 'number' ? 'num' : ''}>{c.label}</th>
                    ))}
                    {derived?.map((d) => <th key={d.key} className={d.align === 'right' ? 'num' : ''}>{d.label}</th>)}
                    {can(`${module}.delete`) && <th style={{ width: 44 }} />}
                  </tr>
                </thead>
                <tbody>
                  {history.data!.rows.map((row) => (
                    <tr key={String(row.id)}>
                      {!orderNo && (
                        <td className="row-title" data-label="Order">
                          <b>{String(row.order_no ?? '—')}</b>
                        </td>
                      )}
                      {listColumns.map((c) => (
                        <td key={c.key} data-label={c.label} className={c.type === 'number' ? 'num' : ''}>
                          {c.render ? c.render(row) : formatCell(row[c.listKey ?? c.key], c)}
                        </td>
                      ))}
                      {derived?.map((d) => (
                        <td key={d.key} data-label={d.label} className={d.align === 'right' ? 'num' : ''}>
                          {d.render ? d.render(row) : String(row[d.key] ?? '—')}
                        </td>
                      ))}
                      {can(`${module}.delete`) && (
                        <td data-label="">
                          <button type="button" className="btn btn-ghost btn-sm btn-icon"
                            aria-label="Delete this row" title="Delete this row"
                            onClick={() => setConfirmDelete(Number(row.id))}>✕</button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
      )}

      {confirmDelete !== null && (
        <Confirm
          title="Delete this entry?"
          danger
          confirmLabel="Delete"
          busy={remove.isPending}
          onClose={() => setConfirmDelete(null)}
          onConfirm={() => remove.mutate(confirmDelete)}
          body={
            <>
              <p>Every figure that counted this row will change. The deletion itself is recorded in the audit log with your name against it.</p>
              <p className="muted tiny">If the entry is merely wrong, it is usually better to log a correcting entry than to remove the history.</p>
            </>
          }
        />
      )}
    </>
  );
}

function formatCell(value: unknown, col: EntryColumn): ReactNode {
  if (value === null || value === undefined || value === '') return <span className="subtle">—</span>;
  if (col.type === 'date') return fmtDate(value);
  if (col.type === 'check') return value ? <span className="badge badge-ok">Yes</span> : <span className="subtle">No</span>;
  if (col.type === 'number') return Number(value).toLocaleString('en-IN');
  return String(value);
}
