import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { Empty, Loading, PageHead, Stat } from '../components/ui';
import { Icon } from '../components/Icons';
import { qty } from '../lib/format';

interface Leg { order_no: string; role: string; cut: number; good: number; packed: number; shipped: number }
interface SetRow {
  set_group: string; colour: string; size: string; set_qty: number;
  legs: Leg[]; sets_makeable: number; sets_packed: number; sets_shipped: number;
  leg_gap: number; status: string; config_error: string;
}

export function SetControlPage() {
  const { can } = useSession();
  const { data, isLoading } = useQuery({
    queryKey: ['set-control'],
    queryFn: () => api.get<{ rows: SetRow[]; groups: number; misconfigured: string[]; worst_gap: number }>('/api/set-control'),
  });

  if (isLoading) return <Loading rows={6} />;

  const rows = data?.rows ?? [];
  const byGroup = new Map<string, SetRow[]>();
  for (const r of rows) byGroup.set(r.set_group, [...(byGroup.get(r.set_group) ?? []), r]);

  return (
    <>
      <PageHead
        title="Set control"
        lede="A set only ships when both halves ship. Declare the pairing once on the order — same set group, one Primary and one Secondary — and this builds itself from what the floor has logged."
        actions={can('sets.export') && rows.length > 0 && (
          <button type="button" className="btn" onClick={() => api.download('/api/set-control/export')}>
            <Icon.Download size={16} /> Export
          </button>
        )}
      />

      {rows.length === 0 ? (
        <div className="card">
          <Empty
            title="No sets declared"
            body={
              <>
                If two orders have to ship together, open each one and give them the same
                <b> set group</b>, marking one Primary and the other Secondary. They will
                appear here, matched colour by colour and size by size.
              </>
            }
            icon={<Icon.Layers size={20} />}
          />
        </div>
      ) : (
        <>
          <div className="stat-grid">
            <Stat label="Set groups" value={data!.groups} note="pairs being tracked" accent="brand" />
            <Stat label="Sets makeable" value={qty(rows.reduce((s, r) => s + r.sets_makeable, 0))}
              note="limited by the scarcer half" />
            <Stat label="Sets shipped" value={qty(rows.reduce((s, r) => s + r.sets_shipped, 0))} accent="ok" />
            <Stat label="Worst gap" value={qty(data!.worst_gap)}
              note="pieces of one half with no partner"
              accent={data!.worst_gap > 0 ? 'warn' : 'ok'} />
          </div>

          {data!.misconfigured.length > 0 && (
            <div className="banner banner-danger">
              <Icon.Alert size={18} />
              <div>
                <b>A pairing is not declared properly.</b>
                <ul style={{ margin: '4px 0 0', paddingLeft: '1.1rem' }}>
                  {data!.misconfigured.map((m) => <li key={m} className="tiny">{m}</li>)}
                </ul>
                <span className="tiny">
                  Until this is fixed, nothing stops one half shipping without the other.
                </span>
              </div>
            </div>
          )}

          {[...byGroup.entries()].map(([group, groupRows]) => (
            <div className="card" key={group}>
              <div className="card-head">
                <div>
                  <h3>Set {group}</h3>
                  <span className="hint">
                    {[...new Set(groupRows.flatMap((r) => r.legs.map((l) => `${l.order_no} (${l.role})`)))].join('  +  ')}
                  </span>
                </div>
                <span className={`badge ${groupRows.some((r) => r.leg_gap > 0) ? 'badge-warn' : 'badge-ok'}`}>
                  {qty(groupRows.reduce((s, r) => s + r.sets_makeable, 0))} sets makeable
                </span>
              </div>
              <div className="table-wrap flush">
                <table className="data stack">
                  <thead>
                    <tr>
                      <th>Colour &amp; size</th>
                      <th className="num">Set qty</th>
                      {groupRows[0].legs.map((l) => (
                        <th key={l.order_no} className="num">
                          {l.order_no}
                          <span className="cell-sub">{l.role} · good</span>
                        </th>
                      ))}
                      <th className="num">Sets makeable</th>
                      <th className="num">Sets shipped</th>
                      <th className="num">Gap</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groupRows.map((r) => (
                      <tr key={`${r.colour}-${r.size}`}>
                        <td className="row-title" data-label="Colour &amp; size">
                          {r.colour} <span className="muted">{r.size}</span>
                        </td>
                        <td className="num" data-label="Set qty">{qty(r.set_qty)}</td>
                        {r.legs.map((l) => (
                          <td key={l.order_no} className="num" data-label={l.order_no}>
                            <Link to={`/orders/${encodeURIComponent(l.order_no)}`}>{qty(l.good)}</Link>
                            <span className="cell-sub">{qty(l.cut)} cut</span>
                          </td>
                        ))}
                        <td className="num strong" data-label="Sets makeable">{qty(r.sets_makeable)}</td>
                        <td className="num" data-label="Sets shipped">{qty(r.sets_shipped)}</td>
                        <td className="num" data-label="Gap">
                          {r.leg_gap > 0
                            ? <span className="badge badge-warn">{qty(r.leg_gap)}</span>
                            : <span className="subtle">·</span>}
                        </td>
                        <td data-label="Status">
                          <span className={`badge ${r.status === 'Complete' || r.status === 'In step' ? 'badge-ok'
                            : r.status === 'Not paired properly' ? 'badge-danger' : 'badge-warn'}`}>
                            {r.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </>
      )}
    </>
  );
}
