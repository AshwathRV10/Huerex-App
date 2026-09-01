import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { Empty, Loading, LockedValue, PageHead, StatusBadge } from '../components/ui';
import { OrderPicker } from '../components/OrderPicker';
import { Icon } from '../components/Icons';
import { compactMoney, isLocked, money, pct, qty } from '../lib/format';

interface SheetRow {
  id: number; order_no: string; buyer: string; style: string;
  version: number; label: string; status: string;
  order_qty: number; ship_qty: number; excess_qty: number; currency: string;
  cost_per_pc?: number; total_cost?: number; selling_price_per_pc?: number;
  margin?: number; margin_pct?: number; updated_at: string;
  total_cost__locked?: boolean; margin__locked?: boolean; selling_price__locked?: boolean;
}

export function CostingPage() {
  const { can } = useSession();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [jump, setJump] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['cost-sheets', q, status],
    queryFn: () => api.get<{ rows: SheetRow[] }>('/api/costing',
      { q: q || undefined, status: status || undefined }),
  });

  const rows = data?.rows ?? [];
  const seeMoney = can('costing.total_cost.view');
  const seeMargin = can('costing.margin.view');

  const totals = rows.reduce((acc, r) => ({
    cost: acc.cost + (r.total_cost ?? 0),
    margin: acc.margin + (r.margin ?? 0),
    qty: acc.qty + (r.ship_qty ?? 0),
  }), { cost: 0, margin: 0, qty: 0 });

  return (
    <>
      <PageHead
        title="Cost sheets"
        lede="What each garment actually costs to make, against what it was sold for. One sheet per order — no two orders are costed the same, because dyeing moves with the colour and printing with the style."
        actions={
          <div style={{ minWidth: 250 }}>
            <OrderPicker value={jump} label="" placeholder="Cost an order…"
              onChange={(v) => { setJump(''); navigate(`/costing/${encodeURIComponent(v)}`); }} />
          </div>
        }
      />

      <div className="toolbar">
        <input className="input search" placeholder="Search by order or style…"
          value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="btn-group">
          {['', 'draft', 'submitted', 'approved'].map((s) => (
            <button key={s || 'all'} type="button" className="btn btn-sm"
              aria-pressed={status === s} onClick={() => setStatus(s)}>
              {s || 'All'}
            </button>
          ))}
        </div>
        <span className="grow" />
        {seeMargin && rows.length > 0 && (
          <span className="tiny muted">
            {qty(totals.qty)} pcs · cost {compactMoney(totals.cost)} · margin{' '}
            <b style={{ color: totals.margin >= 0 ? 'var(--ok-fg)' : 'var(--danger-fg)' }}>
              {compactMoney(totals.margin)}
            </b>
          </span>
        )}
      </div>

      {isLoading ? <Loading rows={8} />
        : rows.length === 0 ? (
          <div className="card">
            <Empty
              title="No cost sheets yet"
              body="Pick an order above and the app will propose a sheet from its route, its fabric and every rate it has seen before."
              icon={<Icon.Rupee size={20} />}
            />
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data stack">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Buyer &amp; style</th>
                  <th className="num">Ships</th>
                  <th className="num">Cost / pc</th>
                  <th className="num">Price / pc</th>
                  <th className="num">Margin / pc</th>
                  <th className="num">Margin %</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const perPcMargin = r.margin !== undefined && r.ship_qty
                    ? r.margin / r.ship_qty : undefined;
                  return (
                    <tr key={r.id}>
                      <td className="row-title" data-label="Order">
                        <Link to={`/costing/${encodeURIComponent(r.order_no)}`}><b>{r.order_no}</b></Link>
                        <span className="cell-sub">v{r.version} · {r.label}</span>
                      </td>
                      <td data-label="Buyer">
                        {r.buyer}
                        <span className="cell-sub truncate" style={{ maxWidth: 280 }}>{r.style}</span>
                      </td>
                      <td className="num" data-label="Ships">
                        {qty(r.ship_qty)}
                        {r.excess_qty > 0 && <span className="cell-sub">incl. {qty(r.excess_qty)} excess</span>}
                      </td>
                      <td className="num" data-label="Cost / pc">
                        {isLocked(r, 'total_cost') || !seeMoney ? <LockedValue /> : money(r.cost_per_pc)}
                      </td>
                      <td className="num" data-label="Price / pc">
                        {isLocked(r, 'selling_price') ? <LockedValue />
                          : r.selling_price_per_pc ? `${r.currency === 'INR' ? '₹' : ''}${r.selling_price_per_pc}` : '—'}
                      </td>
                      <td className="num" data-label="Margin / pc">
                        {isLocked(r, 'margin') || !seeMargin ? <LockedValue />
                          : perPcMargin === undefined ? '—'
                            : <b style={{ color: perPcMargin >= 0 ? 'var(--ok-fg)' : 'var(--danger-fg)' }}>
                              {money(perPcMargin)}
                            </b>}
                      </td>
                      <td className="num" data-label="Margin %">
                        {isLocked(r, 'margin') || !seeMargin ? <LockedValue />
                          : r.margin_pct === undefined ? '—' : pct(r.margin_pct)}
                      </td>
                      <td data-label="Status"><StatusBadge status={r.status} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

      {!seeMoney && (
        <div className="banner">
          <Icon.Lock size={16} />
          <span>
            Cost and margin are restricted. You can see which orders are costed and where each sheet
            stands, but not the figures themselves.
          </span>
        </div>
      )}
    </>
  );
}
