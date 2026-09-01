import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { Loading, PageHead, Stat, Meter, Empty } from '../components/ui';
import { Icon } from '../components/Icons';
import { compactMoney, pct, qty } from '../lib/format';

interface Bottleneck { label: string; qty: number }
interface AlertRow {
  order_no: string; buyer: string; type: string; severity: string;
  qty: number; days: number; message: string; action: string; owner: string; link: string;
}

interface DashboardData {
  live_orders: number;
  order_qty: number; cut: number; packed: number; shipped: number; wip: number;
  aged: number; good: number; overdue: number; on_time_pct: number | null;
  alerts: { open: number; suppressed: number; critical: number; high: number;
    byType: { type: string; count: number; qty: number }[] };
  bottlenecks: Bottleneck[];
  output_14d: { d: string; qty: number }[];
  data_audit: { open: number; clean: boolean; checks: number };
  commercial?: {
    order_book_value: number; order_book_cost: number; order_book_margin: number;
    order_book_margin_pct: number; costed_orders: number; uncosted_orders: number;
  };
  top_alerts: AlertRow[];
}

export function Dashboard() {
  const { user } = useSession();
  const { data, isLoading, error } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<DashboardData>('/api/dashboard'),
    refetchInterval: 120_000,
  });

  if (isLoading) return <Loading rows={8} />;
  if (error || !data) {
    return <Empty title="The dashboard could not load" body={(error as Error)?.message} icon={<Icon.Alert size={20} />} />;
  }

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const firstName = (user?.full_name ?? '').split(' ')[0];

  return (
    <>
      <PageHead
        title={`${greeting}${firstName ? `, ${firstName}` : ''}`}
        lede={
          data.alerts.open === 0
            ? 'Nothing is asking for you. Every live order is moving.'
            : `${data.alerts.open} thing${data.alerts.open === 1 ? '' : 's'} need${data.alerts.open === 1 ? 's' : ''} a decision today — the sharpest are below.`
        }
        actions={
          <Link className="btn" to="/alerts">
            <Icon.Alert size={16} /> All alerts
          </Link>
        }
      />

      {!data.data_audit.clean && (
        <div className="banner banner-warn">
          <Icon.Alert size={18} />
          <div>
            <b>{data.data_audit.open} data issue{data.data_audit.open === 1 ? '' : 's'} across {data.data_audit.checks} check{data.data_audit.checks === 1 ? '' : 's'}.</b>{' '}
            The figures below are only as good as the entries behind them.{' '}
            <Link to="/data-audit">Open the data audit</Link>.
          </div>
        </div>
      )}

      {/* ---------------------------------------------------- the order book */}
      <section className="col" style={{ gap: 'var(--s-3)' }}>
        <h2 className="label">On the floor now</h2>
        <div className="stat-grid">
          <Stat label="Live orders" value={data.live_orders} note="active, not on hold" accent="brand" />
          <Stat label="Committed" value={qty(data.order_qty)} note="pieces owed to buyers" />
          <Stat label="Cut" value={qty(data.cut)}
            note={data.order_qty ? `${Math.round((data.cut / data.order_qty) * 100)}% of the book` : undefined} />
          <Stat label="Packed" value={qty(data.packed)} note="in cartons" />
          <Stat label="Shipped" value={qty(data.shipped)} note="out of the gate" accent="ok" />
          <Stat label="WIP" value={qty(data.wip)}
            note={data.aged > 0 ? `${qty(data.aged)} not moved in 14 days` : 'all moving'}
            accent={data.aged > 0 ? 'warn' : undefined} />
        </div>
      </section>

      {/* ---------------------------------------------------------- delivery */}
      <section className="grid-2">
        <div className="card">
          <div className="card-head">
            <h3>Delivery</h3>
            <span className="hint">measured against ex-factory, not the order date</span>
          </div>
          <div className="card-body col" style={{ gap: 'var(--s-4)' }}>
            <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
              <Stat label="Past ex-factory" value={data.overdue}
                note={data.overdue ? 'orders with pieces still unshipped' : 'nothing is late'}
                accent={data.overdue ? 'danger' : 'ok'} />
              <Stat label="On time" value={data.on_time_pct === null ? '—' : pct(data.on_time_pct, 0)}
                note="of orders that have fully shipped" />
            </div>
            <div className="col" style={{ gap: 6 }}>
              <div className="between tiny muted">
                <span>Book shipped</span>
                <span>{qty(data.shipped)} / {qty(data.order_qty)}</span>
              </div>
              <Meter value={data.shipped} max={data.order_qty || 1} tone="ok" />
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h3>Where the floor is stuck</h3>
            <span className="hint">biggest pile first</span>
          </div>
          <div className="card-body">
            {data.bottlenecks.length === 0 ? (
              <p className="muted tiny">Nothing is waiting anywhere. Every piece is being worked on.</p>
            ) : (
              <div className="col" style={{ gap: 'var(--s-3)' }}>
                {data.bottlenecks.slice(0, 6).map((b, i) => (
                  <div key={b.label} className="col" style={{ gap: 5 }}>
                    <div className="between">
                      <span className="tiny">{b.label}</span>
                      <b className="tiny num">{qty(b.qty)}</b>
                    </div>
                    <Meter value={b.qty} max={data.bottlenecks[0].qty} tone={i === 0 ? 'warn' : undefined} />
                  </div>
                ))}
                <Link className="tiny" to="/wip">See every piece by order, colour and size →</Link>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------- commercial */}
      {data.commercial && (
        <section className="card">
          <div className="card-head">
            <h3>The order book, in money</h3>
            <span className="hint">from the live cost sheet on each order</span>
          </div>
          <div className="card-body col" style={{ gap: 'var(--s-4)' }}>
            <div className="stat-grid">
              <Stat label="Order value" value={compactMoney(data.commercial.order_book_value)}
                note="at the quoted prices" />
              <Stat label="Cost to make" value={compactMoney(data.commercial.order_book_cost)}
                note="fabric, trims, job work, CMT, overheads" />
              <Stat label="Margin" value={compactMoney(data.commercial.order_book_margin)}
                note={pct(data.commercial.order_book_margin_pct)}
                accent={data.commercial.order_book_margin >= 0 ? 'ok' : 'danger'} />
              <Stat label="Costed" value={`${data.commercial.costed_orders} of ${data.commercial.costed_orders + data.commercial.uncosted_orders}`}
                note={data.commercial.uncosted_orders
                  ? `${data.commercial.uncosted_orders} order${data.commercial.uncosted_orders === 1 ? '' : 's'} with no sheet`
                  : 'every live order is costed'}
                accent={data.commercial.uncosted_orders ? 'warn' : undefined} />
            </div>
            {data.commercial.uncosted_orders > 0 && (
              <div className="banner">
                <Icon.Rupee size={16} />
                <span>
                  An order with no cost sheet contributes nothing to these figures — so the real
                  margin is not yet known. <Link to="/costing">Build the missing sheets</Link>.
                </span>
              </div>
            )}
          </div>
        </section>
      )}

      {/* ----------------------------------------------- what needs me today */}
      <section className="card">
        <div className="card-head">
          <h3>What needs me today</h3>
          <span className="hint">
            {data.alerts.critical > 0 && <span className="badge badge-danger">{data.alerts.critical} critical</span>}{' '}
            {data.alerts.suppressed > 0 && <span className="badge">{data.alerts.suppressed} accepted by management</span>}
          </span>
        </div>
        {data.top_alerts.length === 0 ? (
          <Empty
            title="Nothing is blocked"
            body="Every live order is moving, in route, and inside its dates."
            icon={<Icon.Check size={20} />}
          />
        ) : (
          <div className="table-wrap flush">
            <table className="data stack">
              <thead>
                <tr>
                  <th style={{ width: 92 }}>Severity</th>
                  <th>Order</th>
                  <th>What is wrong</th>
                  <th>What to do</th>
                  <th className="num">Pcs</th>
                  <th>Owner</th>
                </tr>
              </thead>
              <tbody>
                {data.top_alerts.map((a, i) => (
                  <tr key={`${a.order_no}-${a.type}-${i}`}>
                    <td data-label="Severity">
                      <span className={`badge ${a.severity === 'CRITICAL' ? 'badge-danger'
                        : a.severity === 'HIGH' ? 'badge-warn' : 'badge-info'}`}>
                        {a.severity}
                      </span>
                    </td>
                    <td data-label="Order" className="row-title">
                      <Link to={a.link}><b>{a.order_no}</b></Link>
                      <span className="cell-sub">{a.buyer}</span>
                    </td>
                    <td data-label="What is wrong">
                      <b className="tiny">{a.type}</b>
                      <span className="cell-sub">{a.message}</span>
                    </td>
                    <td data-label="What to do" className="muted">{a.action}</td>
                    <td data-label="Pcs" className="num">{qty(a.qty)}</td>
                    <td data-label="Owner">{a.owner || <span className="subtle">unassigned</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ----------------------------------------------------- sewing output */}
      {data.output_14d.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h3>Sewing output, last 14 days</h3>
            <span className="hint">pieces off the line each day</span>
          </div>
          <div className="card-body">
            <OutputChart data={data.output_14d} />
          </div>
        </section>
      )}
    </>
  );
}

/**
 * A bar chart drawn as plain elements. No chart library: fourteen bars do not
 * justify 200 KB of JavaScript on a machine that may have no internet.
 */
function OutputChart({ data }: { data: { d: string; qty: number }[] }) {
  const max = Math.max(...data.map((d) => d.qty), 1);
  const total = data.reduce((s, d) => s + d.qty, 0);
  const avg = Math.round(total / data.length);

  return (
    <div className="col" style={{ gap: 'var(--s-3)' }}>
      <div className="row-wrap tiny muted">
        <span><b className="num">{qty(total)}</b> pieces over {data.length} days</span>
        <span>·</span>
        <span>averaging <b className="num">{qty(avg)}</b> a day</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 132 }}>
        {data.map((d) => (
          <div key={d.d} className="grow" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5 }}
            title={`${d.d}: ${d.qty} pcs`}>
            <span className="tiny num subtle" style={{ fontSize: 10 }}>{d.qty || ''}</span>
            <div style={{
              width: '100%',
              height: `${Math.max((d.qty / max) * 100, d.qty > 0 ? 4 : 1)}%`,
              minHeight: 2,
              background: d.qty >= avg ? 'var(--brand)' : 'var(--brand-line)',
              borderRadius: '4px 4px 2px 2px',
              transition: 'height 300ms var(--ease)',
            }} />
            <span className="tiny subtle" style={{ fontSize: 9 }}>{d.d.slice(8)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
