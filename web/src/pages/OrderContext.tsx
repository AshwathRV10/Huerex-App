import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { RouteBar } from '../components/ui';
import { qty, date } from '../lib/format';

/**
 * The strip that sits above every entry grid.
 *
 * It answers the three questions somebody asks before they type: what is this
 * order, where is it in its own route, and how much is still to do in the step
 * I am standing at. Without it people log against the wrong order, or cut a
 * size that was finished last week.
 */

interface WipCell {
  colour: string; size: string; planned_cut: number; cum_cut: number; bal_to_cut: number;
  awaiting_fusing: number; awaiting_jobwork: number; at_jobwork_vendor: number;
  ready_for_sewing: number; in_sewing: number; awaiting_checking: number;
  in_rework: number; awaiting_packing: number; packed_not_shipped: number;
  total_wip: number; where_now: string; flag: string;
}

interface OrderDetail {
  order: {
    order_no: string; buyer: string; style: string; order_qty: number;
    ex_factory_date: string | null; status: string; merchandiser: string; planner: string;
  };
  route: { step_no: number; process: string; type: string }[];
  excess_pct: number;
  issues: string[];
  wip: { cells: WipCell[]; totals: Record<string, number> } | null;
}

const BUCKETS: Record<string, { key: keyof WipCell; label: string }> = {
  cutting: { key: 'bal_to_cut', label: 'still to cut' },
  fusing: { key: 'awaiting_fusing', label: 'awaiting fusing' },
  jobwork: { key: 'awaiting_jobwork', label: 'awaiting job work' },
  sewing: { key: 'ready_for_sewing', label: 'ready to sew' },
  checking: { key: 'awaiting_checking', label: 'awaiting checking' },
  packing: { key: 'awaiting_packing', label: 'awaiting packing' },
  shipment: { key: 'packed_not_shipped', label: 'packed, not shipped' },
};

export function OrderContext({ orderNo, focus }: { orderNo: string; focus?: keyof typeof BUCKETS }) {
  const { data, isLoading } = useQuery({
    queryKey: ['order', orderNo],
    queryFn: () => api.get<OrderDetail>(`/api/orders/${encodeURIComponent(orderNo)}`),
    enabled: Boolean(orderNo),
  });

  if (isLoading || !data) return <div className="skeleton" style={{ height: 92, borderRadius: 'var(--radius-lg)' }} />;

  const bucket = focus ? BUCKETS[focus] : undefined;
  const cells = (data.wip?.cells ?? [])
    .map((c) => ({ ...c, pending: bucket ? Number(c[bucket.key] ?? 0) : c.total_wip }))
    .filter((c) => c.pending > 0)
    .sort((a, b) => b.pending - a.pending);
  const pendingTotal = cells.reduce((s, c) => s + c.pending, 0);

  return (
    <div className="card">
      <div className="card-body col" style={{ gap: 'var(--s-3)' }}>
        <div className="between" style={{ flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <div className="row" style={{ gap: 'var(--s-2)' }}>
              <Link to={`/orders/${encodeURIComponent(data.order.order_no)}`}>
                <b style={{ fontSize: 'var(--text-md)' }}>{data.order.order_no}</b>
              </Link>
              {data.order.status !== 'Active' && <span className="badge badge-warn">{data.order.status}</span>}
              {data.excess_pct > 0 && (
                <span className="badge badge-info" title="Excess ships with the order quantity">
                  +{data.excess_pct}% excess
                </span>
              )}
            </div>
            <div className="tiny muted truncate">{data.order.buyer} · {data.order.style || 'no style'}</div>
          </div>
          <div className="row-wrap tiny muted" style={{ gap: 'var(--s-4)' }}>
            <span><b className="num">{qty(data.order.order_qty)}</b> ordered</span>
            <span>Ex-factory <b>{date(data.order.ex_factory_date)}</b></span>
            {data.order.planner && <span>Planner {data.order.planner}</span>}
          </div>
        </div>

        <RouteBar steps={data.route} />

        {data.issues.length > 0 && (
          <div className="banner banner-warn">
            <div>
              <b>This order is not fully set up.</b>
              <ul style={{ margin: '4px 0 0', paddingLeft: '1.1rem' }}>
                {data.issues.map((i) => <li key={i} className="tiny">{i}</li>)}
              </ul>
            </div>
          </div>
        )}

        {bucket && (
          cells.length === 0 ? (
            <div className="banner banner-ok">
              <span>Nothing is {bucket.label} on this order.</span>
            </div>
          ) : (
            <div className="col" style={{ gap: 6 }}>
              <div className="between tiny muted">
                <span>What is {bucket.label}</span>
                <b className="num">{qty(pendingTotal)} pcs</b>
              </div>
              <div className="row-wrap" style={{ gap: 5 }}>
                {cells.slice(0, 24).map((c) => (
                  <span key={`${c.colour}-${c.size}`} className="badge badge-lg"
                    title={`${c.colour} ${c.size} · ${c.where_now}`}>
                    {c.colour} {c.size}
                    <b className="num" style={{ marginLeft: 4 }}>{c.pending}</b>
                  </span>
                ))}
                {cells.length > 24 && <span className="badge">+{cells.length - 24} more</span>}
              </div>
            </div>
          )
        )}
      </div>
    </div>
  );
}
