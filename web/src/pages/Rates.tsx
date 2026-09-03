import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { useToast } from '../lib/toast';
import { Confirm, Empty, Loading, Modal, PageHead } from '../components/ui';
import { Icon } from '../components/Icons';
import { ago, dateTime, money } from '../lib/format';

/**
 * The rate library.
 *
 * Everything the app has learned, in one place, with the trail of how each
 * number got there. This is the screen to open when somebody asks why this
 * order is dearer than the last one.
 */

const PLACEHOLDER_ORDER = 'starting point';

/** Shipped with the app, never used on a real order — see the banner below. */
const isPlaceholder = (r: RateRow) => r.use_count === 0 && r.last_order_no === PLACEHOLDER_ORDER;

interface RateRow {
  id: number; kind: string; buyer: string; style: string; fabric_type: string;
  colour: string; trim_item: string; process: string; vendor: string;
  component: string; operation: string; category: string; uom: string;
  rate: number; currency: string; use_count: number; last_used_at: string;
  last_order_no: string; first_seen_at: string;
}

const KINDS = [
  { value: '', label: 'Everything' },
  { value: 'fabric_component', label: 'Fabric components' },
  { value: 'fabric_flat', label: 'Fabric, one rate' },
  { value: 'trim', label: 'Trims' },
  { value: 'jobwork', label: 'Job work' },
  { value: 'cmt', label: 'CMT' },
  { value: 'overhead', label: 'Other costs' },
  { value: 'selling_price', label: 'Selling prices' },
  { value: 'consumption', label: 'Consumption' },
];

function subject(r: RateRow): string {
  return [r.fabric_type, r.trim_item, r.process, r.operation, r.category, r.component]
    .filter(Boolean).join(' · ') || '—';
}

/**
 * The unit column doubles as the basis for CMT and overhead rates, where the
 * stored value is `per_pc` or `pct_of_cost`. Printing those raw gives "per
 * per_pc", so they are spelled out.
 */
const UOM_LABELS: Record<string, string> = {
  per_pc: 'per piece',
  per_order: 'for the order',
  per_sam_min: 'per SAM minute',
  pct_of_cost: '% of cost',
  pct_of_revenue: '% of revenue',
  kg: 'per kg',
  pc: 'per piece',
  pcs: 'per piece',
  g: 'grams per piece',
  min: 'per minute',
};

function unit(uom: string): string {
  if (!uom) return '';
  return UOM_LABELS[uom] ?? `per ${uom}`;
}

function scope(r: RateRow): string {
  const parts = [r.style && `style ${r.style}`, r.buyer, r.colour, r.vendor && `at ${r.vendor}`]
    .filter(Boolean);
  return parts.length ? parts.join(' · ') : 'any order';
}

export function RatesPage() {
  const { can } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const [history, setHistory] = useState<RateRow | null>(null);
  const [editing, setEditing] = useState<RateRow | null>(null);
  const [removing, setRemoving] = useState<RateRow | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['rates', kind, q],
    queryFn: () => api.get<RateRow[]>('/api/rates', { kind: kind || undefined, q: q || undefined }),
  });

  const update = useMutation({
    mutationFn: ({ id, rate }: { id: number; rate: number }) => api.patch(`/api/rates/${id}`, { rate }),
    onSuccess: () => {
      toast.ok('Rate updated', 'Cost sheets built from now on will be offered the new figure.');
      setEditing(null);
      void qc.invalidateQueries({ queryKey: ['rates'] });
    },
    onError: (e) => toast.error(e),
  });

  const forget = useMutation({
    mutationFn: (id: number) => api.del(`/api/rates/${id}`),
    onSuccess: () => {
      toast.ok('Rate forgotten', 'Cost sheets already built keep the rate they were saved with.');
      setRemoving(null);
      void qc.invalidateQueries({ queryKey: ['rates'] });
    },
    onError: (e) => toast.error(e),
  });

  const rows = data ?? [];
  const placeholders = rows.filter(isPlaceholder).length;

  return (
    <>
      <PageHead
        title="Rate library"
        lede="Every rate the app has been taught, with where it came from. Nothing here is a fixed price list — it is what was actually used, so the next cost sheet can start from something real instead of a blank page."
        actions={can('rates.export') && (
          <button type="button" className="btn" onClick={() => api.download('/api/rates/export')}>
            <Icon.Download size={16} /> Export
          </button>
        )}
      />

      <div className="toolbar">
        <input className="input search" placeholder="Search a fabric, colour, vendor, buyer…"
          value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="select" style={{ width: 'auto' }} value={kind} onChange={(e) => setKind(e.target.value)}>
          {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
        <span className="grow" />
        <span className="tiny muted">{rows.length} remembered</span>
      </div>

      {placeholders > 0 && (
        <div className="banner banner-warn">
          <Icon.Alert size={18} />
          <div>
            <b>{placeholders} of these are starting points the app shipped with, not rates
            anyone here has quoted.</b>{' '}
            They exist so the first cost sheet has something to argue with instead of a page of
            zeroes. Replace them with your real rates — editing one here, or simply typing over
            it on a cost sheet, is enough. A rate stops being marked as a starting point the
            moment it is used on a real order.
          </div>
        </div>
      )}

      {isLoading ? <Loading rows={8} />
        : rows.length === 0 ? (
          <div className="card">
            <Empty title="Nothing remembered yet"
              body="Rates land here the moment a cost sheet is saved. Build one and this fills itself."
              icon={<Icon.Tag size={20} />} />
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data stack">
              <thead>
                <tr>
                  <th>What</th><th>Where it applies</th><th>Kind</th>
                  <th className="num">Rate</th><th className="num">Used</th>
                  <th className="num">Last used</th><th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="row-title" data-label="What">
                      <b>{subject(r)}</b>
                      {isPlaceholder(r) && (
                        <span className="badge badge-warn" style={{ marginLeft: 6 }}>starting point</span>
                      )}
                    </td>
                    <td data-label="Where">{scope(r)}</td>
                    <td data-label="Kind"><span className="badge">{r.kind.replace(/_/g, ' ')}</span></td>
                    <td className="num strong" data-label="Rate">
                      {r.currency === 'INR' ? money(r.rate) : `${r.rate} ${r.currency}`}
                      {r.uom && <span className="cell-sub">{unit(r.uom)}</span>}
                    </td>
                    <td className="num" data-label="Used">
                      {isPlaceholder(r) ? <span className="subtle">never</span> : `${r.use_count}×`}
                    </td>
                    <td className="num" data-label="Last used">
                      {isPlaceholder(r)
                        ? <span className="subtle">shipped with the app</span>
                        : (
                          <>
                            {ago(r.last_used_at)}
                            {r.last_order_no && <span className="cell-sub">{r.last_order_no}</span>}
                          </>
                        )}
                    </td>
                    <td data-label="">
                      <div className="row">
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setHistory(r)}>
                          History
                        </button>
                        {can('rates.edit') && (
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(r)}>
                            Edit
                          </button>
                        )}
                        {can('rates.delete') && (
                          <button type="button" className="btn btn-ghost btn-sm btn-icon"
                            aria-label={`Forget ${subject(r)}`} title="Forget this rate"
                            onClick={() => setRemoving(r)}>✕</button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

      {removing && (
        <Confirm
          title="Forget this rate?"
          danger
          confirmLabel="Forget it"
          busy={forget.isPending}
          onClose={() => setRemoving(null)}
          onConfirm={() => forget.mutate(removing.id)}
          body={
            <div className="col" style={{ gap: 'var(--s-3)' }}>
              <p>
                <b>{subject(removing)}</b> at{' '}
                <b>{removing.currency === 'INR' ? money(removing.rate) : `${removing.rate} ${removing.currency}`}</b>
                {removing.uom && <> {unit(removing.uom)}</>}, for {scope(removing)}.
              </p>
              <p className="muted tiny">
                {isPlaceholder(removing)
                  ? 'This is a starting point the app shipped with, so nothing here has ever depended on it.'
                  : `It has been used ${removing.use_count}×. Its history of changes goes with it, and that is the record of why an order was priced the way it was.`}
              </p>
              <p className="muted tiny">
                No cost sheet changes. Every sheet keeps the rate it was saved with — this only
                stops the figure being offered on the next one.
              </p>
            </div>
          }
        />
      )}

      {history && <HistoryModal rate={history} onClose={() => setHistory(null)} />}
      {editing && (
        <EditRateModal rate={editing} busy={update.isPending} onClose={() => setEditing(null)}
          onSave={(rate) => update.mutate({ id: editing.id, rate })} />
      )}
    </>
  );
}

function HistoryModal({ rate, onClose }: { rate: RateRow; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['rate-history', rate.id],
    queryFn: () => api.get<{
      memory: RateRow;
      history: { id: number; order_no: string; rate: number; previous_rate: number | null; at: string; changed_by: string | null }[];
    }>(`/api/rates/${rate.id}/history`),
  });

  return (
    <Modal title={subject(rate)} subtitle={scope(rate)} onClose={onClose}>
      {isLoading ? <Loading rows={4} /> : (
        <div className="col" style={{ gap: 'var(--s-3)' }}>
          {(data?.history.length ?? 0) === 0 ? (
            <p className="muted tiny">This rate has been used once and never changed.</p>
          ) : (
            <table className="data">
              <thead>
                <tr><th className="num">When</th><th>Order</th><th className="num">Was</th>
                  <th className="num">Became</th><th>Who</th></tr>
              </thead>
              <tbody>
                {data!.history.map((h) => (
                  <tr key={h.id}>
                    <td className="num">{dateTime(h.at)}</td>
                    <td>{h.order_no || '—'}</td>
                    <td className="num">{h.previous_rate === null ? '—' : money(h.previous_rate)}</td>
                    <td className="num strong">{money(h.rate)}</td>
                    <td>{h.changed_by ?? 'system'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </Modal>
  );
}

function EditRateModal({ rate, onClose, onSave, busy }: {
  rate: RateRow; onClose: () => void; onSave: (rate: number) => void; busy: boolean;
}) {
  const [value, setValue] = useState(rate.rate);
  return (
    <Modal
      title="Change a remembered rate"
      subtitle={`${subject(rate)} — ${scope(rate)}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onSave(value)}>
            {busy && <span className="spinner" />}Save
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 'var(--s-4)' }}>
        {isPlaceholder(rate) && (
          <div className="banner banner-warn">
            This is a starting point the app shipped with. Putting your real rate in is exactly
            what it is here for.
          </div>
        )}
        <p className="muted tiny">
          Changing it here does not touch any cost sheet that has already been built — those keep the
          rate they were saved with. It changes what the app offers next time.
        </p>
        <div className="field" style={{ maxWidth: 220 }}>
          <label>Rate {unit(rate.uom) || 'per unit'}</label>
          <input type="number" className="input input-num" step={0.01} value={value}
            onChange={(e) => setValue(Number(e.target.value))} autoFocus />
        </div>
      </div>
    </Modal>
  );
}
