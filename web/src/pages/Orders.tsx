import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { useToast } from '../lib/toast';
import { Combobox } from '../components/Combobox';
import { OrderPicker } from '../components/OrderPicker';
import { DateField, NumField, SelectField, TextField } from '../components/RateField';
import { BulkGrid, makeBlank, filledRows, type GridColumn, type GridRow } from '../components/BulkGrid';
import { Empty, Loading, Meter, Modal, PageHead, RouteBar, StatusBadge, Tabs } from '../components/ui';
import { Icon } from '../components/Icons';
import { date, days, longDate, qty, today } from '../lib/format';

/* ------------------------------------------------------------- order list */

interface OrderRow {
  id: number; order_no: string; buyer: string; style: string; order_qty: number;
  order_date: string | null; ex_factory_date: string | null; status: string;
  merchandiser: string; planner: string; sam: number; buffer_pct: number;
  excess_pct: number | null; matrix_qty: number; matrix_cells: number; steps: number;
  cut: number; shipped: number; progress_pct: number; days_to_ex_factory: number | null;
  setup_ok: boolean; set_group: string; set_role: string; currency: string;
  fabric_lead_days: number | null; sew_complete_by: string | null;
}

export function OrdersPage() {
  const { can } = useSession();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['orders', q, status],
    queryFn: () => api.get<{ rows: OrderRow[] }>('/api/orders', { q: q || undefined, status: status || undefined }),
  });

  const rows = data?.rows ?? [];

  return (
    <>
      <PageHead
        title="Orders"
        lede="The master record. Everything else in the system counts against one of these."
        actions={
          <>
            {can('orders.export') && (
              <button type="button" className="btn" onClick={() => api.download('/api/orders/export')}>
                <Icon.Download size={16} /> Export
              </button>
            )}
            {can('orders.create') && (
              <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
                <Icon.Plus size={16} /> New order
              </button>
            )}
          </>
        }
      />

      <div className="toolbar">
        <input className="input search" placeholder="Search by order number, style or buyer…"
          value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="btn-group">
          {['', 'Active', 'On Hold', 'Closed'].map((s) => (
            <button key={s || 'all'} type="button" className="btn btn-sm"
              aria-pressed={status === s} onClick={() => setStatus(s)}>
              {s || 'All'}
            </button>
          ))}
        </div>
        <span className="grow" />
        <span className="tiny muted">{rows.length} order{rows.length === 1 ? '' : 's'}</span>
      </div>

      {isLoading ? <Loading rows={8} />
        : rows.length === 0 ? (
          <div className="card">
            <Empty title="No orders match" body="Try a different search, or clear the status filter."
              icon={<Icon.Order size={20} />} />
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data stack">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Buyer &amp; style</th>
                  <th className="num">Qty</th>
                  <th>Progress</th>
                  <th className="num">Ex-factory</th>
                  <th>Owner</th>
                  <th>Setup</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => (
                  <tr key={o.id}>
                    <td className="row-title" data-label="Order">
                      <Link to={`/orders/${encodeURIComponent(o.order_no)}`}><b>{o.order_no}</b></Link>
                      {o.status !== 'Active' && <> <StatusBadge status={o.status} /></>}
                      {o.set_group && <span className="badge" style={{ marginLeft: 6 }}>set {o.set_group}</span>}
                    </td>
                    <td data-label="Buyer">
                      {o.buyer}
                      <span className="cell-sub truncate" style={{ maxWidth: 320 }}>{o.style}</span>
                    </td>
                    <td className="num" data-label="Qty">{qty(o.order_qty)}</td>
                    <td data-label="Progress" style={{ minWidth: 140 }}>
                      <Meter value={o.shipped} max={o.order_qty || 1} tone={o.progress_pct >= 100 ? 'ok' : undefined} />
                      <span className="cell-sub">
                        {qty(o.cut)} cut · {qty(o.shipped)} shipped
                      </span>
                    </td>
                    <td className="num" data-label="Ex-factory">
                      {date(o.ex_factory_date)}
                      {o.days_to_ex_factory !== null && o.status === 'Active' && (
                        <span className="cell-sub" style={{
                          color: o.days_to_ex_factory < 0 ? 'var(--danger-fg)'
                            : o.days_to_ex_factory < 7 ? 'var(--warn-fg)' : undefined,
                        }}>
                          {o.days_to_ex_factory < 0 ? `${-o.days_to_ex_factory} days over` : `in ${days(o.days_to_ex_factory)}`}
                        </span>
                      )}
                    </td>
                    <td data-label="Owner">
                      {o.merchandiser || '—'}
                      {o.planner && <span className="cell-sub">plan: {o.planner}</span>}
                    </td>
                    <td data-label="Setup">
                      {o.setup_ok
                        ? <span className="badge badge-ok">Ready</span>
                        : <span className="badge badge-warn" title="Matrix or route incomplete">Incomplete</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

      {creating && <NewOrderModal onClose={() => setCreating(false)} />}
    </>
  );
}

/* --------------------------------------------------------- new order form */

function NewOrderModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    order_no: '', buyer: '', style: '', order_qty: 0,
    order_date: today(), ex_factory_date: '', sam: 0, buffer_pct: 5,
    merchandiser: '', planner: '', status: 'Active', copy_route_from: '',
  });
  const set = (n: Partial<typeof form>) => setForm((f) => ({ ...f, ...n }));

  const create = useMutation({
    mutationFn: async () => {
      const order = await api.post<{ order_no: string }>('/api/orders', {
        ...form, buffer_pct: form.buffer_pct / 100,
      });
      if (form.copy_route_from) {
        await api.post(`/api/orders/${encodeURIComponent(order.order_no)}/route/copy`,
          { from: form.copy_route_from });
      }
      return order;
    },
    onSuccess: (order) => {
      toast.ok(`${order.order_no} created`, 'Next: the size breakdown and the route.');
      void qc.invalidateQueries({ queryKey: ['orders'] });
      navigate(`/orders/${encodeURIComponent(order.order_no)}`);
    },
    onError: (e) => toast.error(e),
  });

  const ok = form.order_no.trim() && form.buyer.trim() && form.order_qty > 0;

  return (
    <Modal
      title="New order"
      subtitle="Only the essentials here. The size breakdown and the route come next, on the order's own page."
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!ok || create.isPending}
            onClick={() => create.mutate()}>
            {create.isPending && <span className="spinner" />}Create
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 'var(--s-4)' }}>
        <div className="line-grid">
          <TextField label="Order number" value={form.order_no} required autoFocus
            onChange={(v) => set({ order_no: v })} placeholder="HR-017" />
          <Combobox list="buyers" label="Buyer" value={form.buyer} required
            onChange={(v) => set({ buyer: v })} />
          <NumField label="Order quantity" value={form.order_qty} onChange={(v) => set({ order_qty: v })} />
        </div>
        <TextField label="Style" value={form.style} onChange={(v) => set({ style: v })}
          placeholder="L66-B14-12-150 · GIRLS FULL SLEEVE" />
        <div className="line-grid">
          <DateField label="Order date" value={form.order_date} onChange={(v) => set({ order_date: v })} />
          <DateField label="Ex-factory date" value={form.ex_factory_date}
            onChange={(v) => set({ ex_factory_date: v })} />
          <NumField label="SAM" suffix="min" value={form.sam} step={0.5} onChange={(v) => set({ sam: v })}
            help="drives efficiency and capacity" />
          <NumField label="Cutting buffer" suffix="%" value={form.buffer_pct} step={0.5}
            onChange={(v) => set({ buffer_pct: v })} help="on top of excess" />
        </div>
        <div className="line-grid">
          <Combobox list="team" label="Merchandiser" value={form.merchandiser}
            onChange={(v) => set({ merchandiser: v })} />
          <Combobox list="team" label="Planner" value={form.planner} onChange={(v) => set({ planner: v })} />
          <Combobox list="order_status" label="Status" value={form.status} allowCreate={false}
            onChange={(v) => set({ status: v })} />
        </div>
        <div>
          <OrderPicker value={form.copy_route_from} label="Copy the route from"
            onChange={(v) => set({ copy_route_from: v })}
            help="Most orders for a buyer travel the same way. Pick one and its steps are copied." />
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------ order detail */

interface OrderDetailData {
  order: OrderRow;
  route: { id: number; step_no: number; process: string; type: string }[];
  matrix: { id: number; colour: string; size: string; order_qty: number; recut_decision: string; planned_cut: number }[];
  excess_pct: number;
  issues: string[];
  wip: { totals: Record<string, number> } | null;
}

export function OrderDetailPage() {
  const { orderNo = '' } = useParams();
  const { can } = useSession();
  const [tab, setTab] = useState('overview');

  const { data, isLoading, error } = useQuery({
    queryKey: ['order', orderNo],
    queryFn: () => api.get<OrderDetailData>(`/api/orders/${encodeURIComponent(orderNo)}`),
  });

  if (isLoading) return <Loading rows={8} />;
  if (error || !data) {
    return <Empty title="Order not found" body={(error as Error)?.message} icon={<Icon.Order size={20} />} />;
  }

  const o = data.order;
  const t = data.wip?.totals;

  return (
    <>
      <PageHead
        title={o.order_no}
        badge={<StatusBadge status={o.status} />}
        lede={<>{o.buyer} · {o.style || 'no style'}</>}
        actions={
          <>
            {can('costing.view') && (
              <Link className="btn" to={`/costing/${encodeURIComponent(o.order_no)}`}>
                <Icon.Rupee size={16} /> Cost sheet
              </Link>
            )}
            {can('wip.view') && (
              <Link className="btn" to={`/wip?order=${encodeURIComponent(o.order_no)}`}>
                <Icon.Layers size={16} /> WIP
              </Link>
            )}
          </>
        }
      />

      {data.issues.length > 0 && (
        <div className="banner banner-warn">
          <Icon.Alert size={18} />
          <div>
            <b>This order is not fully set up.</b>
            <ul style={{ margin: '4px 0 0', paddingLeft: '1.1rem' }}>
              {data.issues.map((i) => <li key={i} className="tiny">{i}</li>)}
            </ul>
          </div>
        </div>
      )}

      <div className="stat-grid">
        <div className="stat"><span className="stat-label">Ordered</span>
          <span className="stat-value sm">{qty(o.order_qty)}</span>
          <span className="stat-note">{data.excess_pct > 0 ? `+${data.excess_pct}% excess ships too` : 'no excess'}</span></div>
        <div className="stat"><span className="stat-label">Cut</span>
          <span className="stat-value sm">{qty(t?.cum_cut ?? o.cut)}</span>
          <span className="stat-note">{qty(t?.bal_to_cut ?? 0)} still to cut</span></div>
        <div className="stat"><span className="stat-label">On floor</span>
          <span className="stat-value sm">{qty(t?.total_wip ?? 0)}</span>
          <span className="stat-note">{t?.max_ageing ? `oldest ${t.max_ageing} days` : 'moving'}</span></div>
        <div className="stat"><span className="stat-label">Shipped</span>
          <span className="stat-value sm">{qty(t?.shipped ?? o.shipped)}</span>
          <span className="stat-note">{o.progress_pct}% of the order</span></div>
        <div className="stat"><span className="stat-label">Ex-factory</span>
          <span className="stat-value sm">{date(o.ex_factory_date)}</span>
          <span className="stat-note">{longDate(o.order_date)} ordered</span></div>
      </div>

      <Tabs
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'route', label: 'Route', count: data.route.length },
          { id: 'matrix', label: 'Colour × size', count: data.matrix.length },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'overview' && <OrderOverview data={data} />}
      {tab === 'route' && <RouteEditor orderNo={o.order_no} steps={data.route} />}
      {tab === 'matrix' && <MatrixEditor orderNo={o.order_no} />}
    </>
  );
}

function OrderOverview({ data }: { data: OrderDetailData }) {
  const { can } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const o = data.order;
  const [form, setForm] = useState({ ...o, buffer_pct: (o.buffer_pct ?? 0) * 100 });
  const [dirty, setDirty] = useState(false);
  const set = (n: Partial<typeof form>) => { setForm((f) => ({ ...f, ...n })); setDirty(true); };

  const save = useMutation({
    mutationFn: () => api.patch(`/api/orders/${encodeURIComponent(o.order_no)}`, {
      ...form, buffer_pct: form.buffer_pct / 100,
    }),
    onSuccess: () => {
      toast.ok('Order saved');
      setDirty(false);
      void qc.invalidateQueries({ queryKey: ['order', o.order_no] });
      void qc.invalidateQueries({ queryKey: ['orders'] });
    },
    onError: (e) => toast.error(e),
  });

  const editable = can('orders.edit');

  return (
    <div className="card">
      <div className="card-head">
        <h3>The order record</h3>
        {editable && (
          <button type="button" className="btn btn-primary btn-sm" disabled={!dirty || save.isPending}
            onClick={() => save.mutate()}>
            {save.isPending && <span className="spinner" />}{dirty ? 'Save' : 'Saved'}
          </button>
        )}
      </div>
      <div className="card-body col" style={{ gap: 'var(--s-4)' }}>
        <div className="line-grid">
          <Combobox list="buyers" label="Buyer" value={form.buyer} disabled={!editable}
            onChange={(v) => set({ buyer: v })} />
          <NumField label="Order quantity" value={form.order_qty} disabled={!editable}
            onChange={(v) => set({ order_qty: v })} />
          <Combobox list="order_status" label="Status" value={form.status} disabled={!editable}
            allowCreate={false} onChange={(v) => set({ status: v })} />
          <NumField label="SAM" suffix="min" value={form.sam} step={0.5} disabled={!editable}
            onChange={(v) => set({ sam: v })} />
        </div>
        <TextField label="Style" value={form.style} disabled={!editable} onChange={(v) => set({ style: v })} />
        <div className="line-grid">
          <DateField label="Order date" value={form.order_date ?? ''} disabled={!editable}
            onChange={(v) => set({ order_date: v })} />
          <DateField label="Ex-factory" value={form.ex_factory_date ?? ''} disabled={!editable}
            onChange={(v) => set({ ex_factory_date: v })} />
          <DateField label="Sew complete by" value={form.sew_complete_by ?? ''} disabled={!editable}
            onChange={(v) => set({ sew_complete_by: v })} />
          <NumField label="Fabric lead" suffix="days" value={form.fabric_lead_days ?? 0} disabled={!editable}
            onChange={(v) => set({ fabric_lead_days: v })} help="drives the fabric-waiting alert" />
        </div>
        <div className="line-grid">
          <Combobox list="team" label="Merchandiser" value={form.merchandiser} disabled={!editable}
            onChange={(v) => set({ merchandiser: v })} />
          <Combobox list="team" label="Planner" value={form.planner} disabled={!editable}
            onChange={(v) => set({ planner: v })} />
          <NumField label="Cutting buffer" suffix="%" value={form.buffer_pct} step={0.5} disabled={!editable}
            onChange={(v) => set({ buffer_pct: v })} help="loss allowance, on top of excess" />
          {can('orders.excess_pct.view') && (
            <NumField label="Excess %" suffix="%" value={form.excess_pct ?? data.excess_pct} step={0.5}
              disabled={!editable || !can('orders.excess_pct.edit')}
              onChange={(v) => set({ excess_pct: v })}
              help={form.excess_pct === null ? `inherited from ${o.buyer}` : 'overrides the buyer default'} />
          )}
        </div>
        <div className="line-grid">
          <TextField label="Set group" value={form.set_group} disabled={!editable}
            onChange={(v) => set({ set_group: v })}
            help="two orders that must ship together" />
          <SelectField label="Set role" value={form.set_role} disabled={!editable}
            options={[{ value: '', label: '—' }, { value: 'Primary', label: 'Primary' }, { value: 'Secondary', label: 'Secondary' }]}
            onChange={(v) => set({ set_role: v })} />
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- route editor */

const PROCESSES = ['Cutting', 'Fusing', 'Print', 'Embroidery', 'Wash', 'Tie&Dye', 'Rotary AOP',
  'Other', 'Sewing', 'Checking', 'Packing', 'Inspection', 'Shipment'];
const OUTSOURCED = new Set(['Print', 'Embroidery', 'Wash', 'Tie&Dye', 'Rotary AOP', 'Other']);

function RouteEditor({ orderNo, steps }: {
  orderNo: string; steps: { step_no: number; process: string; type: string }[];
}) {
  const { can } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const [list, setList] = useState(() => steps.map((s) => ({ ...s })));
  const [copyFrom, setCopyFrom] = useState('');
  const dirty = useMemo(() => JSON.stringify(list) !== JSON.stringify(steps), [list, steps]);
  const editable = can('route.edit');

  const save = useMutation({
    mutationFn: () => api.put(`/api/orders/${encodeURIComponent(orderNo)}/route`, {
      steps: list.map((s, i) => ({ step_no: i + 1, process: s.process, type: s.type })),
    }),
    onSuccess: () => {
      toast.ok('Route saved', 'Every WIP bucket and alert follows it from now on.');
      void qc.invalidateQueries({ queryKey: ['order', orderNo] });
    },
    onError: (e) => toast.error(e),
  });

  const copy = useMutation({
    mutationFn: () => api.post(`/api/orders/${encodeURIComponent(orderNo)}/route/copy`, { from: copyFrom }),
    onSuccess: () => {
      toast.ok(`Copied ${copyFrom}'s route`);
      void qc.invalidateQueries({ queryKey: ['order', orderNo] });
    },
    onError: (e) => toast.error(e),
  });

  const move = (i: number, dir: -1 | 1) => {
    const next = [...list];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    setList(next);
  };

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3>The exact sequence this order travels</h3>
          <p className="hint">
            Any sequence is allowed — sewing before tie &amp; dye, fusing after sewing, a process twice.
            Every WIP bucket and alert follows this list, so it has to be what really happens.
          </p>
        </div>
        {editable && (
          <button type="button" className="btn btn-primary btn-sm" disabled={!dirty || save.isPending}
            onClick={() => save.mutate()}>
            {save.isPending && <span className="spinner" />}{dirty ? 'Save route' : 'Saved'}
          </button>
        )}
      </div>
      <div className="card-body col" style={{ gap: 'var(--s-4)' }}>
        <RouteBar steps={list.map((s, i) => ({ ...s, step_no: i + 1 }))} />

        <div className="col" style={{ gap: 6 }}>
          {list.map((s, i) => (
            <div key={i} className="row" style={{ gap: 'var(--s-2)' }}>
              <span className="badge" style={{ minWidth: 30, justifyContent: 'center' }}>{i + 1}</span>
              <div style={{ flex: '1 1 200px', maxWidth: 260 }}>
                <Combobox list="processes" value={s.process} disabled={!editable} extra={PROCESSES}
                  onChange={(v) => setList(list.map((x, j) => (j === i
                    ? { ...x, process: v, type: OUTSOURCED.has(v) ? 'Outsourced' : 'In-house' } : x)))} />
              </div>
              <span className={`badge ${s.type === 'Outsourced' ? 'badge-info' : ''}`}>{s.type}</span>
              {editable && (
                <>
                  <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Move up"
                    disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                  <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Move down"
                    disabled={i === list.length - 1} onClick={() => move(i, 1)}>↓</button>
                  <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Remove step"
                    onClick={() => setList(list.filter((_, j) => j !== i))}>✕</button>
                </>
              )}
            </div>
          ))}
          {editable && (
            <div>
              <button type="button" className="btn btn-sm"
                onClick={() => setList([...list, { step_no: list.length + 1, process: '', type: 'In-house' }])}>
                <Icon.Plus size={14} /> Add a step
              </button>
            </div>
          )}
        </div>

        {editable && (
          <div className="row-wrap" style={{ gap: 'var(--s-2)', alignItems: 'flex-end' }}>
            <div style={{ minWidth: 240, maxWidth: 320 }}>
              <OrderPicker value={copyFrom} onChange={setCopyFrom} label="Or copy from another order" />
            </div>
            <button type="button" className="btn" disabled={!copyFrom || copy.isPending}
              onClick={() => copy.mutate()}>Copy route</button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- matrix editor */

interface MatrixCell {
  colour: string; size: string; order_qty: number; recut_decision: string;
  planned_cut: number; cum_cut: number; bal_to_cut: number; good: number;
  rejected: number; packed: number; shipped: number; total_wip: number;
  where_now: string; flag: string;
}

const MATRIX_COLUMNS: GridColumn[] = [
  { key: 'colour', label: 'Colour', type: 'combo', list: 'colours', carry: true, required: true, width: 160 },
  { key: 'size', label: 'Size', type: 'combo', list: 'sizes', required: true, width: 130 },
  { key: 'order_qty', label: 'Order qty', type: 'number', required: true, width: 110 },
  { key: 'recut_decision', label: 'Recut decision', type: 'combo', list: 'recut_status', width: 170 },
];

const MATRIX_BLANK = makeBlank(MATRIX_COLUMNS);

function MatrixEditor({ orderNo }: { orderNo: string }) {
  const { can } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<GridRow[]>([]);

  const { data, isLoading } = useQuery({
    queryKey: ['matrix', orderNo],
    queryFn: () => api.get<{
      cells: MatrixCell[]; excess_pct: number; buffer_pct: number;
      order_qty: number; matrix_qty: number; variance: number;
    }>(`/api/orders/${encodeURIComponent(orderNo)}/matrix`),
  });

  const save = useMutation({
    mutationFn: () => api.put(`/api/orders/${encodeURIComponent(orderNo)}/matrix`, {
      cells: filledRows(rows, MATRIX_COLUMNS, MATRIX_BLANK),
      replace: true,
    }),
    onSuccess: () => {
      toast.ok('Size breakdown saved');
      setEditing(false);
      void qc.invalidateQueries({ queryKey: ['matrix', orderNo] });
      void qc.invalidateQueries({ queryKey: ['order', orderNo] });
    },
    onError: (e) => toast.error(e),
  });

  if (isLoading || !data) return <Loading rows={6} />;

  const startEditing = () => {
    setRows([
      ...data.cells.map((c) => ({
        colour: c.colour, size: c.size, order_qty: c.order_qty, recut_decision: c.recut_decision,
      })),
      { ...MATRIX_BLANK },
    ]);
    setEditing(true);
  };

  const typedTotal = filledRows(rows, MATRIX_COLUMNS, MATRIX_BLANK)
    .reduce((s, r) => s + Number(r.order_qty ?? 0), 0);

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3>Colour × size breakdown</h3>
          <p className="hint">
            Every count in the system is against one of these cells. Planned cut adds this buyer's
            excess ({data.excess_pct}%) and the cutting buffer ({Math.round(data.buffer_pct * 100)}%).
          </p>
        </div>
        {can('matrix.edit') && (
          editing ? (
            <div className="row">
              <button type="button" className="btn btn-sm" onClick={() => setEditing(false)}>Cancel</button>
              <button type="button" className="btn btn-primary btn-sm" disabled={save.isPending}
                onClick={() => save.mutate()}>
                {save.isPending && <span className="spinner" />}Save
              </button>
            </div>
          ) : (
            <button type="button" className="btn btn-sm" onClick={startEditing}>Edit breakdown</button>
          )
        )}
      </div>

      <div className="card-body col" style={{ gap: 'var(--s-3)' }}>
        {(editing ? typedTotal : data.matrix_qty) !== data.order_qty && (
          <div className="banner banner-warn">
            The breakdown adds up to <b>{qty(editing ? typedTotal : data.matrix_qty)}</b> but the order
            is <b>{qty(data.order_qty)}</b>. They have to agree before anything else can be trusted.
          </div>
        )}

        {editing ? (
          <BulkGrid columns={MATRIX_COLUMNS} rows={rows} onChange={setRows}
            blank={MATRIX_BLANK}
            validate={(r) => {
              if (!r.colour || !r.size) return 'Colour and size are both needed.';
              if (!Number(r.order_qty)) return 'How many pieces of this colour and size?';
              return null;
            }} />
        ) : data.cells.length === 0 ? (
          <Empty title="No breakdown yet"
            body="Nothing can be counted against this order until its colours and sizes are listed."
            icon={<Icon.Grid size={20} />}
            action={can('matrix.edit') ? (
              <button type="button" className="btn btn-primary" onClick={startEditing}>Add the breakdown</button>
            ) : undefined} />
        ) : (
          <div className="table-wrap flush">
            <table className="data stack">
              <thead>
                <tr>
                  <th>Colour</th><th>Size</th>
                  <th className="num">Order</th><th className="num">Planned cut</th>
                  <th className="num">Cut</th><th className="num">Good</th>
                  <th className="num">Packed</th><th className="num">Shipped</th>
                  <th className="num">On floor</th><th>Where</th><th>Flag</th>
                </tr>
              </thead>
              <tbody>
                {data.cells.map((c) => (
                  <tr key={`${c.colour}-${c.size}`}>
                    <td className="row-title" data-label="Colour">
                      {c.colour} <span className="muted stacked-only">{c.size}</span>
                    </td>
                    <td data-label="Size" className="desktop-only">{c.size}</td>
                    <td className="num" data-label="Order">{qty(c.order_qty)}</td>
                    <td className="num" data-label="Planned cut">{qty(c.planned_cut)}</td>
                    <td className="num strong" data-label="Cut">{qty(c.cum_cut)}</td>
                    <td className="num" data-label="Good">{qty(c.good)}</td>
                    <td className="num" data-label="Packed">{qty(c.packed)}</td>
                    <td className="num" data-label="Shipped">{qty(c.shipped)}</td>
                    <td className="num" data-label="On floor">{qty(c.total_wip)}</td>
                    <td data-label="Where" className="muted">{c.where_now}</td>
                    <td data-label="Flag">
                      {c.flag ? <span className={`badge ${c.flag === 'OVER-CUT' ? 'badge-danger'
                        : c.flag === 'AGED' ? 'badge-warn' : ''}`}>{c.flag}</span> : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={2}>Total</td>
                  <td className="num">{qty(data.matrix_qty)}</td>
                  <td className="num">{qty(data.cells.reduce((s, c) => s + c.planned_cut, 0))}</td>
                  <td className="num">{qty(data.cells.reduce((s, c) => s + c.cum_cut, 0))}</td>
                  <td className="num">{qty(data.cells.reduce((s, c) => s + c.good, 0))}</td>
                  <td className="num">{qty(data.cells.reduce((s, c) => s + c.packed, 0))}</td>
                  <td className="num">{qty(data.cells.reduce((s, c) => s + c.shipped, 0))}</td>
                  <td className="num">{qty(data.cells.reduce((s, c) => s + c.total_wip, 0))}</td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
