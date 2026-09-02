import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { useToast } from '../lib/toast';
import { BulkGrid, filledRows, makeBlank, type GridColumn, type GridRow } from '../components/BulkGrid';
import { OrderPicker } from '../components/OrderPicker';
import { DateField, NumField } from '../components/RateField';
import { Empty, Loading, LockedValue, Modal, PageHead, Tabs } from '../components/ui';
import { Icon } from '../components/Icons';
import { date, isLocked, kg, money, pct, today } from '../lib/format';

/**
 * The fabric store.
 *
 * The workbook could show kilograms in and kilograms consumed but never what
 * was left on the shelf, so nobody could answer "have we got enough to finish
 * cutting?" without walking to the store. This screen leads with the balance,
 * and every movement that changes it is one row.
 */

interface StockRow {
  fabric_type: string; colour: string; lot_no: string; order_no: string;
  received_kg: number; issued_kg: number; returned_kg: number;
  transferred_out_kg: number; transferred_in_kg: number; adjusted_kg: number;
  balance_kg: number; rate_per_kg: number | null; stock_value: number | null;
  last_movement: string;
  rate_per_kg__locked?: boolean; stock_value__locked?: boolean;
}

interface ConsumptionRow {
  order_no: string; buyer: string; fabric_type: string; colour: string;
  net_issued_kg: number; consumed_kg: number; wastage_kg: number;
  wastage_pct: number; source: string;
}

const LEDGER_COLUMNS: GridColumn[] = [
  { key: 'txn_date', label: 'Date', type: 'date', carry: true, required: true, width: 140 },
  { key: 'direction', label: 'Movement', type: 'select', carry: true, width: 150,
    options: [
      { value: 'RECEIPT', label: 'Received into store' },
      { value: 'ISSUE', label: 'Issued to cutting' },
      { value: 'RETURN', label: 'Returned to store' },
      { value: 'TRANSFER_OUT', label: 'Transferred out' },
      { value: 'TRANSFER_IN', label: 'Transferred in' },
      { value: 'ADJUST', label: 'Stock correction' },
    ] },
  { key: 'fabric_type', label: 'Fabric', type: 'combo', list: 'fabric_types', carry: true, required: true, width: 160 },
  { key: 'colour', label: 'Colour', type: 'combo', list: 'colours', carry: true, required: true, width: 150 },
  { key: 'lot_no', label: 'Lot', type: 'text', carry: true, width: 110 },
  { key: 'qty_kg', label: 'Kg', type: 'number', required: true, width: 100, step: 0.1 },
  { key: 'rate_per_kg', label: '₹/kg', type: 'number', width: 100, step: 0.5, hint: 'on receipts' },
  { key: 'supplier', label: 'Supplier', type: 'combo', list: 'suppliers', carry: true, width: 160 },
  { key: 'dc_no', label: 'DC no', type: 'text', carry: true, width: 110 },
  { key: 'remarks', label: 'Remarks', type: 'text', width: 160 },
];

export function FabricPage() {
  const { can } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const [tab, setTab] = useState('stock');
  const [orderNo, setOrderNo] = useState('');
  const blankRow = useMemo(
    () => makeBlank(LEDGER_COLUMNS, { txn_date: today(), direction: 'RECEIPT' }), [],
  );
  const [rows, setRows] = useState<GridRow[]>(() => [
    makeBlank(LEDGER_COLUMNS, { txn_date: today(), direction: 'RECEIPT' }),
  ]);
  const [reweigh, setReweigh] = useState<ConsumptionRow | null>(null);

  const stock = useQuery({
    queryKey: ['fabric-stock', orderNo],
    queryFn: () => api.get<{ rows: StockRow[] }>('/api/fabric/stock', { order_no: orderNo || undefined }),
    enabled: can('fabric.view'),
  });

  const consumption = useQuery({
    queryKey: ['fabric-consumption', orderNo],
    queryFn: () => api.get<{ rows: ConsumptionRow[] }>('/api/fabric/consumption', { order_no: orderNo || undefined }),
    enabled: can('fabric.view') && tab === 'consumption',
  });

  const ledger = useQuery({
    queryKey: ['fabric-ledger', orderNo],
    queryFn: () => api.get<{ rows: Record<string, unknown>[]; total: number }>('/api/fabric',
      { order_no: orderNo || undefined, limit: 300 }),
    enabled: can('fabric.view') && tab === 'ledger',
  });

  const save = useMutation({
    mutationFn: (payload: GridRow[]) => api.post<{ created: number }>('/api/fabric/bulk', {
      rows: payload.map((r) => ({ ...r, order_no: orderNo || undefined })),
    }),
    onSuccess: (res) => {
      toast.ok(`Saved ${res.created} movement${res.created === 1 ? '' : 's'}`, 'The store balance is updated.');
      setRows([{ ...blankRow }]);
      void qc.invalidateQueries();
    },
    onError: (e) => toast.error(e),
  });

  const ready = filledRows(rows, LEDGER_COLUMNS, blankRow);
  const stockRows = stock.data?.rows ?? [];
  const totals = useMemo(() => stockRows.reduce((acc, r) => ({
    balance: acc.balance + r.balance_kg,
    value: acc.value + (r.stock_value ?? 0),
  }), { balance: 0, value: 0 }), [stockRows]);

  return (
    <>
      <PageHead
        title="Fabric store"
        lede="Kilograms in, kilograms out, and — the thing a spreadsheet never tells you — kilograms still on the shelf."
        actions={
          can('fabric.export') && (
            <button type="button" className="btn"
              onClick={() => api.download('/api/fabric/export', { order_no: orderNo || undefined })}>
              <Icon.Download size={16} /> Export
            </button>
          )
        }
      />

      <div className="toolbar">
        <div style={{ minWidth: 240, flex: '1 1 240px', maxWidth: 380 }}>
          <OrderPicker value={orderNo} onChange={setOrderNo} label="Order (optional)"
            help="Leave blank to see the whole store" />
        </div>
        {orderNo && (
          <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-end' }}
            onClick={() => setOrderNo('')}>Show the whole store</button>
        )}
        <span className="grow" />
        <div className="row-wrap tiny muted">
          <span><b className="num">{kg(totals.balance, 1)}</b> on the shelf</span>
          {can('fabric.value.view') && totals.value > 0 && (
            <span>· worth <b className="num">{money(totals.value, 0)}</b></span>
          )}
        </div>
      </div>

      <Tabs
        tabs={[
          { id: 'stock', label: 'What is in the store', count: stockRows.length },
          ...(can('fabric.create') ? [{ id: 'log', label: 'Log a movement' }] : []),
          { id: 'consumption', label: 'Consumption & wastage' },
          { id: 'ledger', label: 'Every movement', count: ledger.data?.total },
        ]}
        active={tab}
        onChange={setTab}
      />

      {/* ------------------------------------------------------------ stock */}
      {tab === 'stock' && (
        stock.isLoading ? <Loading />
          : stockRows.length === 0 ? (
            <div className="card">
              <Empty title="The store is empty"
                body="Record a receipt and the balance appears here immediately."
                icon={<Icon.Fabric size={20} />} />
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data stack">
                <thead>
                  <tr>
                    <th>Fabric</th><th>Colour</th><th>Lot</th><th>Held for</th>
                    <th className="num">Received</th><th className="num">Issued</th>
                    <th className="num">Returned</th><th className="num">Balance</th>
                    <th className="num">₹/kg</th><th className="num">Value</th>
                    <th className="num">Last moved</th>
                  </tr>
                </thead>
                <tbody>
                  {stockRows.map((r, i) => (
                    <tr key={i}>
                      <td className="row-title" data-label="Fabric">
                        {r.fabric_type} <span className="muted stacked-only">{r.colour}</span>
                      </td>
                      <td data-label="Colour" className="desktop-only">{r.colour}</td>
                      <td data-label="Lot">{r.lot_no || <span className="subtle">—</span>}</td>
                      <td data-label="Held for">{r.order_no}</td>
                      <td className="num" data-label="Received">{r.received_kg.toFixed(1)}</td>
                      <td className="num" data-label="Issued">{r.issued_kg.toFixed(1)}</td>
                      <td className="num" data-label="Returned">{r.returned_kg.toFixed(1)}</td>
                      <td className="num strong" data-label="Balance"
                        style={{ color: r.balance_kg <= 0 ? 'var(--fg-subtle)' : undefined }}>
                        {r.balance_kg.toFixed(2)}
                      </td>
                      <td className="num" data-label="₹/kg">
                        {isLocked(r as unknown as Record<string, unknown>, 'rate_per_kg')
                          ? <LockedValue />
                          : r.rate_per_kg ? money(r.rate_per_kg) : <span className="subtle">not costed</span>}
                      </td>
                      <td className="num" data-label="Value">
                        {isLocked(r as unknown as Record<string, unknown>, 'stock_value')
                          ? <LockedValue />
                          : r.stock_value ? money(r.stock_value, 0) : '—'}
                      </td>
                      <td className="num" data-label="Last moved">{date(r.last_movement)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
      )}

      {/* -------------------------------------------------------------- log */}
      {tab === 'log' && can('fabric.create') && (
        <div className="col" style={{ gap: 'var(--s-3)' }}>
          <div className="banner banner-info">
            <Icon.Fabric size={16} />
            <span>
              Put the rate on a receipt and the order can be costed on what the fabric really
              cost, not on an estimate. Issuing more than the store holds is refused rather
              than allowed to go negative.
            </span>
          </div>
          <BulkGrid columns={LEDGER_COLUMNS} rows={rows} onChange={setRows}
            blank={blankRow}
            validate={(r) => {
              if (!r.fabric_type) return 'Which fabric?';
              if (!r.colour) return 'Which colour?';
              if (!Number(r.qty_kg)) return 'How many kilograms?';
              if (r.direction !== 'RECEIPT' && !orderNo) return 'Pick the order this movement belongs to.';
              return null;
            }} />
          <div className="between">
            <span className="tiny subtle">
              A receipt with no order goes into free stock and can be issued to any order later.
            </span>
            <button type="button" className="btn btn-primary"
              disabled={ready.length === 0 || save.isPending}
              onClick={() => save.mutate(ready)}>
              {save.isPending && <span className="spinner" />}Save {ready.length || ''} movement{ready.length === 1 ? '' : 's'}
            </button>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------ consumption */}
      {tab === 'consumption' && (
        consumption.isLoading ? <Loading />
          : (consumption.data?.rows.length ?? 0) === 0 ? (
            <div className="card"><Empty title="Nothing issued yet" icon={<Icon.Scale size={20} />} /></div>
          ) : (
            <div className="col" style={{ gap: 'var(--s-3)' }}>
              <div className="banner">
                <Icon.Scale size={16} />
                <span>
                  Consumption is worked out from what cutting actually cut, using the piece weight on
                  each cutting entry. When the store has re-weighed, enter the real figure and it
                  takes over.
                </span>
              </div>
              <div className="table-wrap">
                <table className="data stack">
                  <thead>
                    <tr>
                      <th>Order</th><th>Fabric</th><th>Colour</th>
                      <th className="num">Issued</th><th className="num">Consumed</th>
                      <th className="num">Unaccounted</th><th className="num">%</th>
                      <th>From</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {consumption.data!.rows.map((r, i) => (
                      <tr key={i}>
                        <td className="row-title" data-label="Order">{r.order_no}</td>
                        <td data-label="Fabric">{r.fabric_type}</td>
                        <td data-label="Colour">{r.colour}</td>
                        <td className="num" data-label="Issued">{r.net_issued_kg?.toFixed(1)}</td>
                        <td className="num" data-label="Consumed">{r.consumed_kg?.toFixed(1)}</td>
                        <td className="num" data-label="Unaccounted">{r.wastage_kg?.toFixed(1)}</td>
                        <td className="num" data-label="%">
                          <span className={`badge ${r.wastage_pct > 12 ? 'badge-danger'
                            : r.wastage_pct > 8 ? 'badge-warn' : 'badge-ok'}`}>
                            {pct(r.wastage_pct)}
                          </span>
                        </td>
                        <td data-label="From"><span className="badge">{r.source}</span></td>
                        <td data-label="">
                          {can('fabric.edit') && (
                            <button type="button" className="btn btn-sm" onClick={() => setReweigh(r)}>
                              Re-weigh
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )
      )}

      {/* ----------------------------------------------------------- ledger */}
      {tab === 'ledger' && (
        ledger.isLoading ? <Loading />
          : (ledger.data?.rows.length ?? 0) === 0 ? (
            <div className="card"><Empty title="No movements yet" icon={<Icon.Book size={20} />} /></div>
          ) : (
            <div className="table-wrap">
              <table className="data stack">
                <thead>
                  <tr>
                    <th>Date</th><th>Movement</th><th>Fabric</th><th>Colour</th>
                    <th>Lot</th><th>Order</th><th className="num">Kg</th>
                    <th className="num">₹/kg</th><th>Supplier</th><th>Remarks</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.data!.rows.map((r) => (
                    <tr key={String(r.id)}>
                      <td className="row-title" data-label="Date">{date(r.txn_date)}</td>
                      <td data-label="Movement">
                        <span className={`badge ${r.direction === 'RECEIPT' ? 'badge-ok'
                          : r.direction === 'ISSUE' ? 'badge-warn' : ''}`}>
                          {String(r.direction).replace('_', ' ').toLowerCase()}
                        </span>
                      </td>
                      <td data-label="Fabric">{String(r.fabric_type)}</td>
                      <td data-label="Colour">{String(r.colour)}</td>
                      <td data-label="Lot">{String(r.lot_no || '—')}</td>
                      <td data-label="Order">{String(r.order_no ?? '—')}</td>
                      <td className="num" data-label="Kg">{Number(r.qty_kg).toFixed(2)}</td>
                      <td className="num" data-label="₹/kg">
                        {isLocked(r, 'rate_per_kg') ? <LockedValue />
                          : r.rate_per_kg ? money(Number(r.rate_per_kg)) : '—'}
                      </td>
                      <td data-label="Supplier">{String(r.supplier || '—')}</td>
                      <td data-label="Remarks" className="muted">{String(r.remarks || '')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
      )}

      {reweigh && <ReweighModal row={reweigh} onClose={() => setReweigh(null)} />}
    </>
  );
}

function ReweighModal({ row, onClose }: { row: ConsumptionRow; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [value, setValue] = useState(row.consumed_kg);
  const [when, setWhen] = useState(today());
  const [note, setNote] = useState('');

  const orderId = useQuery({
    queryKey: ['order-id', row.order_no],
    queryFn: () => api.get<{ order: { id: number } }>(`/api/orders/${encodeURIComponent(row.order_no)}`),
  });

  const save = useMutation({
    mutationFn: () => api.post('/api/fabric/consumption', {
      order_id: orderId.data!.order.id,
      fabric_type: row.fabric_type,
      colour: row.colour,
      consumed_kg: value,
      as_of_date: when,
      remarks: note,
    }),
    onSuccess: () => {
      toast.ok('Consumption recorded', 'The wastage figure now uses the weighed number.');
      void qc.invalidateQueries();
      onClose();
    },
    onError: (e) => toast.error(e),
  });

  const waste = row.net_issued_kg - value;

  return (
    <Modal
      title="Record what was really consumed"
      subtitle={`${row.fabric_type} · ${row.colour} · ${row.order_no}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={save.isPending || !orderId.data}
            onClick={() => save.mutate()}>
            {save.isPending && <span className="spinner" />}Save
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 'var(--s-4)' }}>
        <p className="muted tiny">
          Until this is entered, consumption is worked out from the piece weight on each cutting
          entry. A weighed figure is always better — it is what makes the wastage number honest.
        </p>
        <div className="line-grid">
          <NumField label="Issued" suffix="kg" value={row.net_issued_kg} onChange={() => undefined} disabled />
          <NumField label="Really consumed" suffix="kg" value={value} step={0.1} onChange={setValue} />
          <DateField label="Weighed on" value={when} onChange={setWhen} />
        </div>
        <div className={`banner ${waste / (row.net_issued_kg || 1) > 0.12 ? 'banner-danger' : 'banner-ok'}`}>
          That leaves <b>{kg(waste, 2)}</b> unaccounted —{' '}
          <b>{pct((waste / (row.net_issued_kg || 1)) * 100)}</b> of what was issued.
        </div>
        <div className="field">
          <label>Note</label>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="Who weighed it, and anything that explains the gap" />
        </div>
      </div>
    </Modal>
  );
}
