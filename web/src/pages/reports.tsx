import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { useToast } from '../lib/toast';
import { OrderPicker } from '../components/OrderPicker';
import { Combobox } from '../components/Combobox';
import { Empty, Loading, Meter, Modal, PageHead, Stat, StatusBadge } from '../components/ui';
import { Icon } from '../components/Icons';
import { compactMoney, date, days, isLocked, money, pct, qty } from '../lib/format';

/* ==================================================================== WIP */

interface WipRow {
  order_no: string; buyer: string; style: string; colour: string; size: string;
  order_qty: number; planned_cut: number; cum_cut: number; bal_to_cut: number;
  awaiting_fusing: number; awaiting_jobwork: number; at_jobwork_vendor: number;
  ready_for_sewing: number; in_sewing: number; awaiting_checking: number;
  in_rework: number; awaiting_packing: number; packed_not_shipped: number;
  rejected: number; shipped: number; total_wip: number; imbalance: number;
  where_now: string; next_step: string; last_movement: string | null;
  ageing_days: number | null; flag: string;
}

const WIP_BUCKETS = [
  ['awaiting_fusing', 'Awaiting fusing'],
  ['awaiting_jobwork', 'Awaiting job work'],
  ['at_jobwork_vendor', 'At vendor'],
  ['ready_for_sewing', 'Ready to sew'],
  ['in_sewing', 'In sewing'],
  ['awaiting_checking', 'Awaiting checking'],
  ['in_rework', 'In rework'],
  ['awaiting_packing', 'Awaiting packing'],
  ['packed_not_shipped', 'Packed, not shipped'],
] as const;

export function WipPage() {
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const orderNo = params.get('order') ?? '';
  const [flag, setFlag] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['wip', orderNo, flag],
    queryFn: () => api.get<{ rows: WipRow[]; totals: Record<string, number> }>('/api/wip',
      { order_no: orderNo || undefined, flag: flag || undefined }),
  });

  const rows = data?.rows ?? [];
  const t = data?.totals ?? {};
  const broken = rows.filter((r) => r.imbalance !== 0).length;

  return (
    <>
      <PageHead
        title="WIP on the floor"
        lede="Every running piece, by order, colour and size. The buckets never overlap and they always add up to Cut − Shipped − Rejected, so nothing can fall through a gap."
        actions={can('wip.export') && (
          <button type="button" className="btn" onClick={() => api.download('/api/wip/export')}>
            <Icon.Download size={16} /> Export
          </button>
        )}
      />

      <div className="stat-grid">
        <Stat label="Total on floor" value={qty(t.total_wip)} note="cut but not shipped" accent="brand" />
        <Stat label="Still to cut" value={qty(t.bal_to_cut)} note="against plan" />
        <Stat label="At a vendor" value={qty(t.at_jobwork_vendor)} note="outside the factory"
          accent={t.at_jobwork_vendor > 0 ? 'warn' : undefined} />
        <Stat label="In rework" value={qty(t.in_rework)} note="checked and sent back"
          accent={t.in_rework > 0 ? 'warn' : undefined} />
        <Stat label="Packed, not shipped" value={qty(t.packed_not_shipped)} note="waiting at the gate" />
      </div>

      {broken > 0 && (
        <div className="banner banner-danger">
          <Icon.Alert size={18} />
          <span>
            <b>{broken} row{broken === 1 ? '' : 's'} do not balance.</b> The buckets disagree with
            Cut − Shipped − Rejected, which means an entry contradicts another one.{' '}
            <Link to="/reconciliation">Open reconciliation</Link>.
          </span>
        </div>
      )}

      <div className="toolbar">
        <div style={{ minWidth: 240, flex: '1 1 240px', maxWidth: 360 }}>
          <OrderPicker value={orderNo} onChange={(v) => setParams(v ? { order: v } : {})}
            label="Order (optional)" />
        </div>
        <div className="btn-group" style={{ alignSelf: 'flex-end' }}>
          {['', 'AGED', 'STALLED', 'OVER-CUT'].map((f) => (
            <button key={f || 'all'} type="button" className="btn btn-sm"
              aria-pressed={flag === f} onClick={() => setFlag(f)}>{f || 'All'}</button>
          ))}
        </div>
        <span className="grow" />
        <span className="tiny muted">{rows.length} rows</span>
      </div>

      {isLoading ? <Loading rows={8} />
        : rows.length === 0 ? (
          <div className="card">
            <Empty title="Nothing on the floor" body="Every piece is either not cut yet or already shipped."
              icon={<Icon.Layers size={20} />} />
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data stack">
              <thead>
                <tr>
                  <th>Order</th><th>Colour &amp; size</th>
                  <th className="num">Cut</th>
                  {WIP_BUCKETS.map(([k, label]) => <th key={k} className="num">{label}</th>)}
                  <th className="num">On floor</th>
                  <th>Where it is now</th>
                  <th className="num">Not moved</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className={r.imbalance !== 0 ? 'is-selected' : undefined}>
                    <td className="row-title" data-label="Order">
                      <Link to={`/orders/${encodeURIComponent(r.order_no)}`}>{r.order_no}</Link>
                      <span className="cell-sub stacked-only">{r.colour} · {r.size}</span>
                    </td>
                    <td data-label="Colour" className="desktop-only">{r.colour} <span className="muted">{r.size}</span></td>
                    <td className="num" data-label="Cut">{qty(r.cum_cut)}</td>
                    {WIP_BUCKETS.map(([k, label]) => (
                      <td key={k} className="num" data-label={label}>
                        {r[k] ? qty(r[k]) : <span className="subtle">·</span>}
                      </td>
                    ))}
                    <td className="num strong" data-label="On floor">{qty(r.total_wip)}</td>
                    <td data-label="Where">
                      {r.where_now}
                      {r.next_step && r.next_step !== '—' && <span className="cell-sub">next: {r.next_step}</span>}
                    </td>
                    <td className="num" data-label="Not moved">
                      {r.ageing_days === null ? '—' : (
                        <span className={`badge ${r.ageing_days >= 14 ? 'badge-danger'
                          : r.ageing_days >= 7 ? 'badge-warn' : ''}`}>
                          {r.ageing_days}d
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </>
  );
}

/* ========================================================= reconciliation */

interface ReconRow {
  order_no: string; buyer: string; status: string; order_qty: number;
  cum_cut: number; shipped: number; rejected: number; total_wip: number;
  accounted: number; difference: number; bucket_imbalance: number; verdict: string;
}

export function ReconciliationPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['reconciliation'],
    queryFn: () => api.get<{ rows: ReconRow[]; broken: number }>('/api/reconciliation'),
  });

  const rows = data?.rows ?? [];

  return (
    <>
      <PageHead
        title="Reconciliation"
        lede={<>The identity that must always hold: <b>Cut = Shipped + Rejected + WIP</b>. If a difference is anything other than zero, a piece has been counted twice or lost — fix the entry behind it before trusting any other screen.</>}
      />

      {data && (
        <div className={`banner ${data.broken === 0 ? 'banner-ok' : 'banner-danger'}`}>
          {data.broken === 0
            ? <><Icon.Check size={18} /><span>Every order balances. These numbers can be trusted.</span></>
            : <><Icon.Alert size={18} /><span><b>{data.broken} order{data.broken === 1 ? '' : 's'} out of balance.</b> Until they are fixed, the dashboard is reporting on entries that contradict each other.</span></>}
        </div>
      )}

      {isLoading ? <Loading rows={8} /> : (
        <div className="table-wrap">
          <table className="data stack">
            <thead>
              <tr>
                <th>Order</th><th>Buyer</th><th>Status</th>
                <th className="num">Order</th><th className="num">Cut</th>
                <th className="num">Shipped</th><th className="num">Rejected</th>
                <th className="num">WIP</th><th className="num">Accounted</th>
                <th className="num">Difference</th><th>Verdict</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.order_no}>
                  <td className="row-title" data-label="Order">
                    <Link to={`/orders/${encodeURIComponent(r.order_no)}`}>{r.order_no}</Link>
                  </td>
                  <td data-label="Buyer">{r.buyer}</td>
                  <td data-label="Status"><StatusBadge status={r.status} /></td>
                  <td className="num" data-label="Order">{qty(r.order_qty)}</td>
                  <td className="num" data-label="Cut">{qty(r.cum_cut)}</td>
                  <td className="num" data-label="Shipped">{qty(r.shipped)}</td>
                  <td className="num" data-label="Rejected">{qty(r.rejected)}</td>
                  <td className="num" data-label="WIP">{qty(r.total_wip)}</td>
                  <td className="num" data-label="Accounted">{qty(r.accounted)}</td>
                  <td className="num strong" data-label="Difference"
                    style={{ color: r.difference !== 0 ? 'var(--danger-fg)' : undefined }}>
                    {r.difference}
                  </td>
                  <td data-label="Verdict">
                    <span className={`badge ${r.verdict === 'Balanced' ? 'badge-ok' : 'badge-danger'}`}>
                      {r.verdict}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/* =============================================================== timeline */

interface TimelineRow {
  order_no: string; buyer: string; style: string; status: string;
  order_date: string | null; ex_factory_date: string | null;
  fabric_in: string | null; cut_start: string | null; cut_end: string | null;
  jw_out: string | null; jw_in: string | null; sew_start: string | null; sew_end: string | null;
  pack_start: string | null; pack_end: string | null; inspection: string | null;
  first_dispatch: string | null; last_dispatch: string | null;
  fabric_lead_time: number | null; cutting_duration: number | null;
  jobwork_turnaround: number | null; sewing_duration: number | null;
  total_cycle_time: number | null; delay_days: number | null;
  closed: boolean; delay_reason: string; delay_note: string;
}

export function TimelinePage() {
  const { can } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<TimelineRow | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['timeline'],
    queryFn: () => api.get<{ rows: TimelineRow[] }>('/api/timeline'),
  });

  const saveReason = useMutation({
    mutationFn: (row: { order_no: string; reason: string; note: string }) =>
      api.put(`/api/timeline/${encodeURIComponent(row.order_no)}/reason`, row),
    onSuccess: () => {
      toast.ok('Delay reason saved');
      setEditing(null);
      void qc.invalidateQueries({ queryKey: ['timeline'] });
    },
    onError: (e) => toast.error(e),
  });

  const rows = data?.rows ?? [];

  return (
    <>
      <PageHead
        title="Order timeline"
        lede="Every milestone comes from the transaction sheets — the only thing anyone types here is why an order slipped. Cycle time runs from the order date and freezes on the day the last piece ships. Delay is measured against ex-factory, which is a different question."
      />

      {isLoading ? <Loading rows={8} /> : (
        <div className="table-wrap">
          <table className="data stack">
            <thead>
              <tr>
                <th>Order</th><th className="num">Fabric in</th><th className="num">Cut</th>
                <th className="num">Job work</th><th className="num">Sewing</th>
                <th className="num">Packed</th><th className="num">Dispatch</th>
                <th className="num">Cycle</th><th className="num">Delay</th><th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.order_no}>
                  <td className="row-title" data-label="Order">
                    <Link to={`/orders/${encodeURIComponent(r.order_no)}`}>{r.order_no}</Link>
                    <span className="cell-sub">{r.buyer}</span>
                  </td>
                  <td className="num" data-label="Fabric in">
                    {date(r.fabric_in)}
                    {r.fabric_lead_time !== null && <span className="cell-sub">{r.fabric_lead_time}d lead</span>}
                  </td>
                  <td className="num" data-label="Cut">
                    {date(r.cut_start)}
                    {r.cutting_duration !== null && <span className="cell-sub">{r.cutting_duration}d</span>}
                  </td>
                  <td className="num" data-label="Job work">
                    {date(r.jw_out)}
                    {r.jobwork_turnaround !== null && <span className="cell-sub">{r.jobwork_turnaround}d out</span>}
                  </td>
                  <td className="num" data-label="Sewing">
                    {date(r.sew_start)}
                    {r.sewing_duration !== null && <span className="cell-sub">{r.sewing_duration}d</span>}
                  </td>
                  <td className="num" data-label="Packed">{date(r.pack_end)}</td>
                  <td className="num" data-label="Dispatch">{date(r.last_dispatch)}</td>
                  <td className="num" data-label="Cycle">
                    {r.total_cycle_time === null ? '—' : `${r.total_cycle_time}d`}
                    {!r.closed && <span className="cell-sub">running</span>}
                  </td>
                  <td className="num" data-label="Delay">
                    {r.delay_days === null ? '—' : (
                      <span className={`badge ${r.delay_days > 0 ? 'badge-danger' : 'badge-ok'}`}>
                        {r.delay_days > 0 ? `+${r.delay_days}d` : `${r.delay_days}d`}
                      </span>
                    )}
                  </td>
                  <td data-label="Reason">
                    {can('timeline.edit') ? (
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(r)}>
                        {r.delay_reason && r.delay_reason !== '-' ? r.delay_reason : 'Add a reason'}
                      </button>
                    ) : (r.delay_reason || '—')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <DelayReasonModal row={editing} onClose={() => setEditing(null)}
          onSave={(reason, note) => saveReason.mutate({ order_no: editing.order_no, reason, note })}
          busy={saveReason.isPending} />
      )}
    </>
  );
}

function DelayReasonModal({ row, onClose, onSave, busy }: {
  row: TimelineRow; onClose: () => void; onSave: (reason: string, note: string) => void; busy: boolean;
}) {
  const [reason, setReason] = useState(row.delay_reason ?? '-');
  const [note, setNote] = useState(row.delay_note ?? '');

  return (
    <Modal title={`Why did ${row.order_no} slip?`} onClose={onClose}
      subtitle="Recording the reason is what makes the pattern visible later — the buyer summary counts them."
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onSave(reason, note)}>
            {busy && <span className="spinner" />}Save
          </button>
        </>
      }>
      <div className="col" style={{ gap: 'var(--s-4)' }}>
        <Combobox list="delay_reasons" label="Reason" value={reason} onChange={setReason} />
        <div className="field">
          <label>Note</label>
          <textarea className="textarea" value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="What actually happened, in a sentence." />
        </div>
      </div>
    </Modal>
  );
}

/* ================================================================= alerts */

interface AlertRow {
  order_no: string; buyer: string; type: string; severity: string;
  qty: number; days: number; message: string; action: string; owner: string;
  suppressed: boolean; suppressed_until?: string; link: string;
}

export function AlertsPage() {
  const [type, setType] = useState('');
  const [showSuppressed, setShowSuppressed] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['alerts', type, showSuppressed],
    queryFn: () => api.get<{ rows: AlertRow[]; summary: { open: number; suppressed: number; byType: { type: string; count: number }[] } }>(
      '/api/alerts', { type: type || undefined, include_suppressed: showSuppressed ? 1 : undefined }),
  });

  const rows = data?.rows ?? [];

  return (
    <>
      <PageHead
        title="Alerts"
        lede="Everything the system thinks needs a decision, sharpest first. An alert management has accepted is suppressed until the date they set — it is silenced, not deleted, and it comes back on its own."
        actions={
          <label className="check">
            <span className="switch">
              <input type="checkbox" checked={showSuppressed} onChange={(e) => setShowSuppressed(e.target.checked)} />
            </span>
            <span className="tiny">Show accepted ones</span>
          </label>
        }
      />

      {data?.summary && (
        <div className="row-wrap">
          <span className="badge badge-lg badge-danger">{data.summary.open} open</span>
          {data.summary.suppressed > 0 && (
            <span className="badge badge-lg">{data.summary.suppressed} accepted by management</span>
          )}
          <span className="grow" />
          <div className="row-wrap" style={{ gap: 4 }}>
            <button type="button" className={`btn btn-sm ${type === '' ? 'btn-soft' : 'btn-ghost'}`}
              onClick={() => setType('')}>All types</button>
            {data.summary.byType.slice(0, 8).map((t) => (
              <button key={t.type} type="button"
                className={`btn btn-sm ${type === t.type ? 'btn-soft' : 'btn-ghost'}`}
                onClick={() => setType(type === t.type ? '' : t.type)}>
                {t.type} <span className="badge" style={{ marginLeft: 4 }}>{t.count}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {isLoading ? <Loading rows={6} />
        : rows.length === 0 ? (
          <div className="card">
            <Empty title="Nothing is blocked" body="Every live order is moving, in route and inside its dates."
              icon={<Icon.Check size={20} />} />
          </div>
        ) : (
          <div className="col" style={{ gap: 'var(--s-2)' }}>
            {rows.map((a, i) => (
              <div key={i} className="card card-pad"
                style={{ opacity: a.suppressed ? 0.6 : 1, borderLeft: `3px solid ${
                  a.severity === 'CRITICAL' ? 'var(--danger)'
                    : a.severity === 'HIGH' ? 'var(--warn)' : 'var(--info)'}` }}>
                <div className="between" style={{ flexWrap: 'wrap', gap: 'var(--s-3)' }}>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="row-wrap" style={{ gap: 'var(--s-2)' }}>
                      <span className={`badge ${a.severity === 'CRITICAL' ? 'badge-danger'
                        : a.severity === 'HIGH' ? 'badge-warn' : 'badge-info'}`}>{a.severity}</span>
                      <span className="badge">{a.type}</span>
                      <Link to={a.link}><b>{a.order_no}</b></Link>
                      <span className="tiny muted">{a.buyer}</span>
                      {a.suppressed && (
                        <span className="badge badge-ok">accepted until {date(a.suppressed_until)}</span>
                      )}
                    </div>
                    <p style={{ marginTop: 6 }}>{a.message}</p>
                    <p className="tiny muted" style={{ marginTop: 2 }}>→ {a.action}</p>
                  </div>
                  <div className="col" style={{ alignItems: 'flex-end', gap: 2 }}>
                    <b className="num">{qty(a.qty)} pcs</b>
                    {a.days > 0 && <span className="tiny muted">{days(a.days)}</span>}
                    {a.owner && <span className="tiny subtle">{a.owner}</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
    </>
  );
}

/* ============================================================= data audit */

interface AuditCheck { id: number; check: string; issues: number; detail: string[]; what_to_do: string }

export function DataAuditPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['data-audit'],
    queryFn: () => api.get<{ checks: AuditCheck[]; open: number }>('/api/data-audit'),
  });

  const checks = data?.checks ?? [];
  const failing = checks.filter((c) => c.issues > 0);
  const clean = checks.filter((c) => c.issues === 0);

  return (
    <>
      <PageHead
        title="Data audit"
        lede="Read this before you trust the dashboard. Every check counts real entries. A clean audit does not mean production is healthy — it means the numbers can be believed."
      />

      {data && (
        <div className={`banner ${data.open === 0 ? 'banner-ok' : 'banner-warn'}`}>
          {data.open === 0
            ? <><Icon.Check size={18} /><span>All {checks.length} checks are clean.</span></>
            : <><Icon.Alert size={18} /><span><b>{data.open} issue{data.open === 1 ? '' : 's'}</b> across {failing.length} of {checks.length} checks.</span></>}
        </div>
      )}

      {isLoading ? <Loading rows={6} /> : (
        <div className="col" style={{ gap: 'var(--s-3)' }}>
          {failing.map((c) => (
            <details key={c.id} className="cost-block">
              <summary>
                <span className="chev"><Icon.Chevron size={15} /></span>
                <span>{c.check}</span>
                <span className="totals">
                  <span className="badge badge-warn">{c.issues} open</span>
                </span>
              </summary>
              <div className="cost-lines">
                <p className="muted tiny">{c.what_to_do}</p>
                <div className="row-wrap" style={{ gap: 5 }}>
                  {c.detail.map((d) => <span key={d} className="badge badge-lg">{d}</span>)}
                  {c.issues > c.detail.length && (
                    <span className="badge">and {c.issues - c.detail.length} more</span>
                  )}
                </div>
              </div>
            </details>
          ))}

          {clean.length > 0 && (
            <div className="card card-pad">
              <div className="between">
                <b className="tiny">Clean checks</b>
                <span className="badge badge-ok">{clean.length}</span>
              </div>
              <div className="row-wrap" style={{ marginTop: 'var(--s-2)', gap: 5 }}>
                {clean.map((c) => <span key={c.id} className="badge">{c.check}</span>)}
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}

/* ================================================================ capacity */

export function CapacityPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['capacity'],
    queryFn: () => api.get<{
      rows: { line: string; entries: number; output: number; op_hours: number;
        avg_operators: number; pcs_per_op_hour: number; efficiency_pct: number;
        minutes_available_per_day: number }[];
      pending_sam_minutes: number; minutes_available_per_day: number;
      days_of_work: number | null; avg_efficiency_pct: number;
    }>('/api/capacity'),
  });

  if (isLoading) return <Loading rows={6} />;
  const rows = data?.rows ?? [];

  return (
    <>
      <PageHead
        title="Capacity &amp; load"
        lede="Minutes needed comes from each order's SAM and what is still unsewn. Minutes available comes from the operators and hours actually logged in the last 30 days — not from a plan."
      />

      <div className="stat-grid">
        <Stat label="Work in hand" value={`${Math.round((data?.pending_sam_minutes ?? 0) / 60).toLocaleString('en-IN')} hr`}
          note="SAM minutes still to sew" accent="brand" />
        <Stat label="Available a day" value={`${Math.round((data?.minutes_available_per_day ?? 0) / 60)} hr`}
          note="from what was really logged" />
        <Stat label="Running efficiency" value={pct(data?.avg_efficiency_pct ?? 0, 0)}
          note="SAM produced ÷ minutes paid for" />
        <Stat label="Days of work" value={data?.days_of_work === null ? '—' : `${data?.days_of_work}`}
          note="at the current pace"
          accent={(data?.days_of_work ?? 0) > 30 ? 'warn' : undefined} />
      </div>

      {rows.length === 0 ? (
        <div className="card">
          <Empty title="No sewing logged in the last 30 days"
            body="Capacity is measured from real output, so it appears once the lines start logging."
            icon={<Icon.Scale size={20} />} />
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data stack">
            <thead>
              <tr>
                <th>Line</th><th className="num">Days logged</th><th className="num">Output</th>
                <th className="num">Operator hours</th><th className="num">Avg operators</th>
                <th className="num">Pcs / op-hour</th><th className="num">Efficiency</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.line}>
                  <td className="row-title" data-label="Line"><b>{r.line}</b></td>
                  <td className="num" data-label="Days logged">{r.entries}</td>
                  <td className="num" data-label="Output">{qty(r.output)}</td>
                  <td className="num" data-label="Operator hours">{r.op_hours}</td>
                  <td className="num" data-label="Avg operators">{r.avg_operators}</td>
                  <td className="num" data-label="Pcs / op-hour">{r.pcs_per_op_hour}</td>
                  <td className="num" data-label="Efficiency">
                    <span className={`badge ${r.efficiency_pct >= 60 ? 'badge-ok'
                      : r.efficiency_pct >= 40 ? 'badge-warn' : 'badge-danger'}`}>
                      {pct(r.efficiency_pct, 0)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/* =========================================================== buyer summary */

interface BuyerRow {
  buyer: string; excess_pct: number; excess_billable: boolean; payment_terms: string;
  total_orders: number; live_orders: number; order_qty: number; cut: number;
  good: number; packed: number; shipped: number; wip: number; rejected: number;
  shipped_pct: number; overdue_orders: number; on_time_pct: number | null;
  avg_cycle_days: number | null; avg_approval_turnaround: number | null;
  approvals_pending: number; open_alerts: number; dhu_pct: number; reject_pct: number;
  order_value?: number; total_cost?: number; margin?: number; margin_pct?: number;
  avg_price?: number; avg_cost?: number; free_excess_cost?: number;
  costed_orders?: number; verdict: string;
  margin__locked?: boolean;
}

export function BuyerSummaryPage() {
  const { can } = useSession();
  const { data, isLoading } = useQuery({
    queryKey: ['buyer-summary'],
    queryFn: () => api.get<{ rows: BuyerRow[] }>('/api/buyer-summary'),
  });

  const rows = data?.rows ?? [];
  const seeMoney = can('buyersummary.commercials.view');

  return (
    <>
      <PageHead
        title="Buyer summary"
        lede="How each buyer's book is running: the quantity, the clock, the quality — and, for those allowed to see it, the money. Approval turnaround is the average of every completed approval, so you can see who is slow before it costs a delivery."
      />

      {isLoading ? <Loading rows={6} />
        : rows.length === 0 ? <div className="card"><Empty title="No buyers yet" icon={<Icon.Users size={20} />} /></div>
          : (
            <div className="col" style={{ gap: 'var(--s-3)' }}>
              {rows.map((b) => (
                <div key={b.buyer} className="card">
                  <div className="card-head">
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="row-wrap" style={{ gap: 'var(--s-2)' }}>
                        <Link to={`/buyer-summary/${encodeURIComponent(b.buyer)}`}>
                          <b style={{ fontSize: 'var(--text-md)' }}>{b.buyer}</b>
                        </Link>
                        <span className={`badge ${b.verdict === 'Healthy' ? 'badge-ok'
                          : b.verdict === 'Behind' ? 'badge-danger'
                            : b.verdict === 'Watch' ? 'badge-warn' : ''}`}>{b.verdict}</span>
                        {b.excess_pct > 0 && (
                          <span className="badge badge-info"
                            title={b.excess_billable ? 'Excess is invoiced' : 'Excess is shipped free'}>
                            +{b.excess_pct}% excess {b.excess_billable ? '' : '(free)'}
                          </span>
                        )}
                      </div>
                      <span className="hint">
                        {b.live_orders} live of {b.total_orders} orders
                        {b.payment_terms && ` · ${b.payment_terms}`}
                      </span>
                    </div>
                  </div>
                  <div className="card-body col" style={{ gap: 'var(--s-4)' }}>
                    <div className="stat-grid">
                      <Stat label="Committed" value={qty(b.order_qty)} note="pieces" />
                      <Stat label="Shipped" value={qty(b.shipped)} note={pct(b.shipped_pct, 0)} />
                      <Stat label="On floor" value={qty(b.wip)} note="cut, not shipped" />
                      <Stat label="Overdue" value={b.overdue_orders}
                        note={b.on_time_pct === null ? 'none closed yet' : `${pct(b.on_time_pct, 0)} on time`}
                        accent={b.overdue_orders ? 'danger' : 'ok'} />
                      <Stat label="Cycle time" value={b.avg_cycle_days === null ? '—' : `${b.avg_cycle_days}d`}
                        note="order to last dispatch" />
                      <Stat label="Approval turnaround"
                        value={b.avg_approval_turnaround === null ? '—' : `${b.avg_approval_turnaround}d`}
                        note={b.approvals_pending ? `${b.approvals_pending} still open` : 'nothing pending'}
                        accent={b.approvals_pending ? 'warn' : undefined} />
                      <Stat label="DHU" value={pct(b.dhu_pct)} note={`${pct(b.reject_pct)} rejected`}
                        accent={b.dhu_pct > 5 ? 'warn' : undefined} />
                      {seeMoney && (
                        <>
                          <Stat label="Order value" value={compactMoney(b.order_value)}
                            note={`${b.costed_orders ?? 0} of ${b.total_orders} costed`}
                            locked={isLocked(b as unknown as Record<string, unknown>, 'margin')} />
                          <Stat label="Margin" value={compactMoney(b.margin)} note={pct(b.margin_pct ?? 0)}
                            accent={(b.margin ?? 0) >= 0 ? 'ok' : 'danger'}
                            locked={isLocked(b as unknown as Record<string, unknown>, 'margin')} />
                          <Stat label="Avg price / pc" value={money(b.avg_price)}
                            note={`costs ${money(b.avg_cost)}`}
                            locked={isLocked(b as unknown as Record<string, unknown>, 'margin')} />
                        </>
                      )}
                    </div>
                    {seeMoney && (b.free_excess_cost ?? 0) > 0 && (
                      <div className="banner banner-warn">
                        <Icon.Alert size={16} />
                        <span>
                          Excess for this buyer is shipped free, which costs about{' '}
                          <b>{money(b.free_excess_cost, 0)}</b> across their book with no revenue against it.
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

      {!seeMoney && (
        <div className="banner">
          <Icon.Lock size={16} />
          <span>Value, cost and margin columns are restricted to authorised roles.</span>
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------ one buyer, in depth */

export function BuyerDetailPage() {
  const { buyer = '' } = useParams();
  const { data, isLoading } = useQuery({
    queryKey: ['buyer-detail', buyer],
    queryFn: () => api.get<{
      buyer: string;
      orders: TimelineRow[];
      monthly: { month: string; shipped: number; orders: number }[];
      styles: { style: string; orders: number; qty: number }[];
      vendors: { vendor: string; process: string; sent: number; orders: number }[];
      approvals: { approval_type: string; raised: number; avg_days: number | null; pending: number }[];
      delays: { reason: string; orders: number }[];
    }>(`/api/buyer-summary/${encodeURIComponent(buyer)}`),
  });

  if (isLoading || !data) return <Loading rows={8} />;
  const maxShipped = Math.max(...data.monthly.map((m) => m.shipped), 1);

  return (
    <>
      <PageHead title={data.buyer} lede="Everything this buyer's book has done, and where the time goes."
        actions={<Link className="btn" to="/buyer-summary">All buyers</Link>} />

      <div className="grid-2">
        <div className="card">
          <div className="card-head"><h3>Shipped by month</h3></div>
          <div className="card-body col" style={{ gap: 6 }}>
            {data.monthly.length === 0 && <p className="tiny muted">Nothing shipped yet.</p>}
            {data.monthly.map((m) => (
              <div key={m.month} className="col" style={{ gap: 3 }}>
                <div className="between tiny">
                  <span className="muted">{m.month}</span>
                  <b className="num">{qty(m.shipped)}</b>
                </div>
                <Meter value={m.shipped} max={maxShipped} />
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h3>Approval turnaround</h3>
            <span className="hint">where the buyer's own time goes</span>
          </div>
          <div className="card-body">
            {data.approvals.length === 0 ? <p className="tiny muted">No approvals recorded.</p> : (
              <table className="data">
                <thead>
                  <tr><th>Approval</th><th className="num">Raised</th><th className="num">Avg days</th><th className="num">Open</th></tr>
                </thead>
                <tbody>
                  {data.approvals.map((a) => (
                    <tr key={a.approval_type}>
                      <td>{a.approval_type}</td>
                      <td className="num">{a.raised}</td>
                      <td className="num">{a.avg_days === null ? '—' : a.avg_days.toFixed(1)}</td>
                      <td className="num">{a.pending || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-head"><h3>Styles</h3></div>
          <div className="card-body">
            <table className="data">
              <thead><tr><th>Style</th><th className="num">Orders</th><th className="num">Pieces</th></tr></thead>
              <tbody>
                {data.styles.map((s) => (
                  <tr key={s.style}>
                    <td className="truncate" style={{ maxWidth: 300 }}>{s.style || '—'}</td>
                    <td className="num">{s.orders}</td>
                    <td className="num">{qty(s.qty)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="card-head"><h3>Vendors used</h3></div>
          <div className="card-body">
            {data.vendors.length === 0 ? <p className="tiny muted">Nothing outsourced.</p> : (
              <table className="data">
                <thead><tr><th>Vendor</th><th>Process</th><th className="num">Pieces sent</th></tr></thead>
                <tbody>
                  {data.vendors.map((v, i) => (
                    <tr key={i}><td>{v.vendor}</td><td>{v.process}</td><td className="num">{qty(v.sent)}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h3>Orders</h3></div>
        <div className="table-wrap flush">
          <table className="data stack">
            <thead>
              <tr><th>Order</th><th className="num">Ex-factory</th><th className="num">Cycle</th>
                <th className="num">Delay</th><th>Reason</th><th>State</th></tr>
            </thead>
            <tbody>
              {data.orders.map((o) => (
                <tr key={o.order_no}>
                  <td className="row-title" data-label="Order">
                    <Link to={`/orders/${encodeURIComponent(o.order_no)}`}>{o.order_no}</Link>
                    <span className="cell-sub truncate" style={{ maxWidth: 280 }}>{o.style}</span>
                  </td>
                  <td className="num" data-label="Ex-factory">{date(o.ex_factory_date)}</td>
                  <td className="num" data-label="Cycle">{o.total_cycle_time === null ? '—' : `${o.total_cycle_time}d`}</td>
                  <td className="num" data-label="Delay">
                    {o.delay_days === null ? '—' : (
                      <span className={`badge ${o.delay_days > 0 ? 'badge-danger' : 'badge-ok'}`}>
                        {o.delay_days > 0 ? `+${o.delay_days}d` : `${o.delay_days}d`}
                      </span>
                    )}
                  </td>
                  <td data-label="Reason">{o.delay_reason && o.delay_reason !== '-' ? o.delay_reason : '—'}</td>
                  <td data-label="State">
                    <span className={`badge ${o.closed ? 'badge-ok' : ''}`}>{o.closed ? 'Shipped' : o.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
