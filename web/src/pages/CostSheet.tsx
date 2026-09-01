import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { useToast } from '../lib/toast';
import { Combobox } from '../components/Combobox';
import { NumField, RateField, SelectField, TextField, type RateContext } from '../components/RateField';
import { Confirm, Empty, Loading, LockedValue, Modal, PageHead, StatusBadge } from '../components/ui';
import { Icon } from '../components/Icons';
import { compactMoney, money, pct, qty } from '../lib/format';

/* ------------------------------------------------------------------ types */

interface Component { component: string; rate_per_kg: number; vendor: string; loss_pct: number; remarks: string }
interface FabricLine {
  fabric_type: string; colour: string; part: string; gsm: number;
  consumption_g_per_pc: number; wastage_pct: number;
  rate_mode: 'buildup' | 'flat'; flat_rate_per_kg: number;
  applies_qty_pct: number; supplier: string; remarks: string; components: Component[];
}
interface TrimLine {
  trim_item: string; colour: string; size: string; uom: string; qty_per_pc: number;
  rate_per_unit: number; wastage_pct: number; applies_qty_pct: number; supplier: string; remarks: string;
}
interface JobWorkLine {
  process: string; vendor: string; colour: string; step_no: number | null;
  rate_per_pc: number; applies_qty_pct: number; vendor_loss_pct: number;
  freight_per_order: number; remarks: string;
}
interface CmtLine {
  operation: string; basis: 'per_pc' | 'per_order' | 'per_sam_min' | 'pct_of_cost';
  rate: number; sam_min: number; efficiency_pct: number; applies_qty_pct: number; remarks: string;
}
interface OverheadLine {
  category: string; basis: 'per_pc' | 'per_order' | 'pct_of_cost' | 'pct_of_revenue';
  amount: number; vendor: string; remarks: string;
}

interface Sheet {
  id: number; order_id: number; version: number; label: string; status: string;
  is_primary: number; order_qty: number; excess_pct: number; excess_billable: number;
  rejection_pct: number; currency: string; fx_rate: number; selling_price_per_pc: number;
  price_basis: string; target_margin_pct: number; notes: string; updated_at: string;
}

interface Order {
  id: number; order_no: string; buyer: string; style: string; order_qty: number;
  currency: string; fx_rate: number; status: string;
}

interface ResultLine {
  label: string; sublabel: string; detail: string; qty: number; qtyUom: string;
  rate: number; rateUom: string; total: number; perPc: number;
}
interface ResultBlock {
  key: 'fabric' | 'trims' | 'jobwork' | 'cmt' | 'overheads';
  label: string; lines: ResultLine[]; total: number; perPc: number; pctOfCost: number; locked?: boolean;
}
interface CostResult {
  quantities: {
    orderQty: number; excessPct: number; excessQty: number; shipQty: number;
    billableQty: number; rejectionPct: number; rejectionQty: number; productionQty: number;
  };
  blocks: ResultBlock[];
  totalCost?: number; costPerPcShipped?: number; costPerPcProduced?: number;
  revenue?: number; revenuePerPc?: number; margin?: number; marginPerPc?: number;
  marginPct?: number; markupPct?: number;
  breakEvenPricePerPc?: number; targetPricePerPc?: number;
  currency: string; fxRate: number; warnings: string[];
  total_cost__locked?: boolean; margin__locked?: boolean; selling_price__locked?: boolean;
}

interface SheetPayload {
  order: Order;
  sheet: Sheet | null;
  versions: { id: number; version: number; label: string; status: string; updated_at: string }[];
  result?: CostResult;
  lines?: {
    fabric: FabricLine[]; trims: TrimLine[]; jobwork: JobWorkLine[];
    cmt: CmtLine[]; overheads: OverheadLine[]; prices: unknown[];
  };
  proposal?: Draft & { selling_price_because?: string };
}

interface Draft {
  label: string;
  excess_pct: number; excess_billable: boolean; rejection_pct: number;
  currency: string; fx_rate: number; selling_price_per_pc: number;
  price_basis: string; target_margin_pct: number; notes: string;
  fabric: FabricLine[]; trims: TrimLine[]; jobwork: JobWorkLine[];
  cmt: CmtLine[]; overheads: OverheadLine[];
}

/* ----------------------------------------------------------------- blanks */

const blankComponent = (): Component => ({ component: '', rate_per_kg: 0, vendor: '', loss_pct: 0, remarks: '' });
const blankFabric = (): FabricLine => ({
  fabric_type: '', colour: '', part: 'Body', gsm: 0, consumption_g_per_pc: 0, wastage_pct: 8,
  rate_mode: 'buildup', flat_rate_per_kg: 0, applies_qty_pct: 100, supplier: '', remarks: '',
  components: [blankComponent()],
});
const blankTrim = (): TrimLine => ({
  trim_item: '', colour: '', size: '', uom: 'pcs', qty_per_pc: 1,
  rate_per_unit: 0, wastage_pct: 2, applies_qty_pct: 100, supplier: '', remarks: '',
});
const blankJobWork = (): JobWorkLine => ({
  process: '', vendor: '', colour: '', step_no: null, rate_per_pc: 0,
  applies_qty_pct: 100, vendor_loss_pct: 0, freight_per_order: 0, remarks: '',
});
const blankCmt = (): CmtLine => ({
  operation: '', basis: 'per_pc', rate: 0, sam_min: 0, efficiency_pct: 100, applies_qty_pct: 100, remarks: '',
});
const blankOverhead = (): OverheadLine => ({ category: '', basis: 'per_order', amount: 0, vendor: '', remarks: '' });

function draftFrom(sheet: Sheet, lines: NonNullable<SheetPayload['lines']>): Draft {
  return {
    label: sheet.label,
    excess_pct: sheet.excess_pct,
    excess_billable: Boolean(sheet.excess_billable),
    rejection_pct: sheet.rejection_pct,
    currency: sheet.currency,
    fx_rate: sheet.fx_rate,
    selling_price_per_pc: sheet.selling_price_per_pc,
    price_basis: sheet.price_basis,
    target_margin_pct: sheet.target_margin_pct,
    notes: sheet.notes,
    fabric: lines.fabric.map((f) => ({ ...f, components: f.components ?? [] })),
    trims: lines.trims ?? [],
    jobwork: lines.jobwork ?? [],
    cmt: lines.cmt ?? [],
    overheads: lines.overheads ?? [],
  };
}

/* =========================================================== the editor == */

export function CostSheetPage() {
  const { orderNo = '' } = useParams();
  const { can } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();

  const [version, setVersion] = useState<number | undefined>();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [showActual, setShowActual] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['cost-sheet', orderNo, version],
    queryFn: () => api.get<SheetPayload>(`/api/costing/order/${encodeURIComponent(orderNo)}`,
      version ? { version } : undefined),
    enabled: Boolean(orderNo),
  });

  useEffect(() => {
    if (!data) return;
    if (data.sheet && data.lines) setDraft(draftFrom(data.sheet, data.lines));
    else setDraft(null);
    setDirty(false);
  }, [data]);

  // Warn before losing an unsaved sheet — this screen holds a lot of typing.
  useEffect(() => {
    if (!dirty) return;
    const onLeave = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [dirty]);

  const create = useMutation({
    mutationFn: (body: Partial<Draft>) =>
      api.post<Sheet>(`/api/costing/order/${encodeURIComponent(orderNo)}`, body),
    onSuccess: (sheet) => {
      toast.ok(`Cost sheet v${sheet.version} started`, 'Rates the app remembered are filled in already.');
      setVersion(undefined);
      void qc.invalidateQueries({ queryKey: ['cost-sheet', orderNo] });
    },
    onError: (e) => toast.error(e),
  });

  const save = useMutation({
    mutationFn: (body: Draft) => api.put(`/api/costing/${data!.sheet!.id}`, body),
    onSuccess: () => {
      toast.ok('Cost sheet saved', 'Every rate you typed is remembered for the next order.');
      setDirty(false);
      void qc.invalidateQueries({ queryKey: ['cost-sheet', orderNo] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (e) => toast.error(e),
  });

  const submit = useMutation({
    mutationFn: () => api.post(`/api/costing/${data!.sheet!.id}/submit`),
    onSuccess: () => {
      toast.ok('Sent for approval', 'Management has been notified.');
      void qc.invalidateQueries({ queryKey: ['cost-sheet', orderNo] });
    },
    onError: (e) => toast.error(e),
  });

  const decide = useMutation({
    mutationFn: (decision: string) => api.post(`/api/costing/${data!.sheet!.id}/decide`, { decision }),
    onSuccess: () => {
      toast.ok('Decision recorded');
      void qc.invalidateQueries({ queryKey: ['cost-sheet', orderNo] });
    },
    onError: (e) => toast.error(e),
  });

  const duplicate = useMutation({
    mutationFn: () => api.post<Sheet>(`/api/costing/${data!.sheet!.id}/duplicate`, { label: 'Revised' }),
    onSuccess: (sheet) => {
      toast.ok(`Version ${sheet.version} created`, 'The approved one is kept as it was.');
      setVersion(undefined);
      void qc.invalidateQueries({ queryKey: ['cost-sheet', orderNo] });
    },
    onError: (e) => toast.error(e),
  });

  const remove = useMutation({
    mutationFn: () => api.del(`/api/costing/${data!.sheet!.id}`),
    onSuccess: () => { toast.ok('Cost sheet deleted'); navigate('/costing'); },
    onError: (e) => { toast.error(e); setConfirmDelete(false); },
  });

  const patch = (next: Partial<Draft>) => { setDraft((d) => (d ? { ...d, ...next } : d)); setDirty(true); };

  if (isLoading) return <Loading rows={10} />;
  if (error || !data) {
    return <Empty title="Could not open this cost sheet" body={(error as Error)?.message} icon={<Icon.Alert size={20} />} />;
  }

  const { order, sheet, versions, result } = data;
  const memoryCtx = { buyer: order.buyer, style: order.style };
  const editable = Boolean(sheet) && can('costing.edit')
    && sheet!.status !== 'locked'
    && (sheet!.status !== 'approved' || can('costing.approve'));

  /* ------------------------------------------------ no sheet yet: propose */
  if (!sheet) {
    return (
      <>
        <PageHead
          title={`Cost ${order.order_no}`}
          lede={<>{order.buyer} · {order.style || 'no style'} · {qty(order.order_qty)} pieces</>}
          actions={<Link className="btn" to="/costing">All cost sheets</Link>}
        />
        <div className="card card-pad col" style={{ gap: 'var(--s-4)' }}>
          <div>
            <h2>This order has never been costed</h2>
            <p className="muted" style={{ marginTop: 6, maxWidth: '62ch' }}>
              Starting a sheet fills in what the app already knows: the fabric this order is
              actually being cut from, the outsourced steps in its own route with the vendors
              it uses, and every rate it has seen before for this buyer and style. You change
              the numbers that are wrong and leave the rest.
            </p>
          </div>
          <div>
            <button type="button" className="btn btn-primary btn-lg" disabled={create.isPending || !can('costing.create')}
              onClick={() => create.mutate(data.proposal as Partial<Draft>)}>
              {create.isPending && <span className="spinner" />}
              <Icon.Plus size={16} /> Start a cost sheet
            </button>
          </div>
          {data.proposal && <ProposalPreview proposal={data.proposal} />}
        </div>
      </>
    );
  }

  if (!draft) return <Loading rows={8} />;

  const q = result?.quantities;
  const lockedCost = result?.total_cost__locked;
  const lockedMargin = result?.margin__locked;

  return (
    <>
      <PageHead
        title={`Cost ${order.order_no}`}
        badge={<StatusBadge status={sheet.status} />}
        lede={<>{order.buyer} · {order.style || 'no style'} · version {sheet.version} “{sheet.label}”</>}
        actions={
          <>
            {versions.length > 1 && (
              <select className="select" style={{ width: 'auto' }}
                value={version ?? sheet.version}
                onChange={(e) => setVersion(Number(e.target.value))}>
                {versions.map((v) => (
                  <option key={v.id} value={v.version}>v{v.version} · {v.label} · {v.status}</option>
                ))}
              </select>
            )}
            {can('costing.view') && !lockedCost && (
              <button type="button" className="btn" onClick={() => setShowActual(true)}>
                <Icon.Balance size={16} /> Plan vs actual
              </button>
            )}
            {can('costing.export') && (
              <button type="button" className="btn" onClick={() => api.download(`/api/costing/${sheet.id}/export`)}>
                <Icon.Download size={16} /> Export
              </button>
            )}
            {can('costing.create') && (
              <button type="button" className="btn" onClick={() => duplicate.mutate()} disabled={duplicate.isPending}>
                <Icon.Copy size={16} /> New version
              </button>
            )}
          </>
        }
      />

      {result && result.warnings.length > 0 && (
        <div className="banner banner-warn">
          <Icon.Alert size={18} />
          <div>
            {result.warnings.map((w) => <div key={w}>{w}</div>)}
          </div>
        </div>
      )}

      {/* ------------------------------------------------- quantity basis -- */}
      <section className="card">
        <div className="card-head">
          <h3>What is being made, and what is being sold</h3>
          <span className="hint">excess ships with the order · rejection is made but never leaves</span>
        </div>
        <div className="card-body col" style={{ gap: 'var(--s-4)' }}>
          <div className="line-grid">
            <NumField label="Order quantity" value={sheet.order_qty} onChange={() => undefined} disabled
              help="from the order" />
            <NumField label="Excess %" value={draft.excess_pct} step={0.5} disabled={!editable}
              suffix="%" onChange={(v) => patch({ excess_pct: v })}
              help="this buyer's rule" />
            <div className="field">
              <label>Buyer pays for excess</label>
              <label className="check">
                <span className="switch">
                  <input type="checkbox" checked={draft.excess_billable} disabled={!editable}
                    onChange={(e) => patch({ excess_billable: e.target.checked })} />
                </span>
                <span className="tiny">{draft.excess_billable ? 'Yes — invoiced' : 'No — we absorb it'}</span>
              </label>
            </div>
            <NumField label="Rejection allowance %" value={draft.rejection_pct} step={0.5} disabled={!editable}
              suffix="%" onChange={(v) => patch({ rejection_pct: v })}
              help="made but not shipped" />
          </div>

          {q && (
            <div className="stat-grid">
              <QtyStat label="Ordered" value={q.orderQty} note="what the buyer asked for" />
              <QtyStat label="Excess" value={q.excessQty} note={`${q.excessPct}% of the order`} />
              <QtyStat label="Ships" value={q.shipQty} note="leaves the gate" accent="brand" />
              <QtyStat label="Invoiced" value={q.billableQty}
                note={draft.excess_billable ? 'order plus excess' : 'order only — excess is free'} />
              <QtyStat label="Must be made" value={q.productionQty}
                note={q.rejectionQty ? `${qty(q.rejectionQty)} allowed for rejection` : 'no rejection allowance'}
                accent="warn" />
            </div>
          )}
        </div>
      </section>

      {/* ------------------------------------------------------- the blocks */}
      <FabricBlock draft={draft} patch={patch} editable={editable && can('costing.fabric.edit')}
        memoryCtx={memoryCtx} block={result?.blocks.find((b) => b.key === 'fabric')} />

      <TrimBlock draft={draft} patch={patch} editable={editable && can('costing.trims.edit')}
        memoryCtx={memoryCtx} block={result?.blocks.find((b) => b.key === 'trims')} />

      <JobWorkBlock draft={draft} patch={patch} editable={editable && can('costing.jobwork.edit')}
        memoryCtx={memoryCtx} block={result?.blocks.find((b) => b.key === 'jobwork')} />

      <CmtBlock draft={draft} patch={patch} editable={editable && can('costing.cmt.edit')}
        memoryCtx={memoryCtx} block={result?.blocks.find((b) => b.key === 'cmt')} />

      <OverheadBlock draft={draft} patch={patch} editable={editable && can('costing.overheads.edit')}
        memoryCtx={memoryCtx} block={result?.blocks.find((b) => b.key === 'overheads')} />

      {/* ------------------------------------------------------------ price */}
      {can('costing.selling_price.view') && (
        <section className="card">
          <div className="card-head">
            <h3>What the buyer is paying</h3>
            <span className="hint">per piece, in the order's currency</span>
          </div>
          <div className="card-body line-grid">
            <Combobox list="currencies" value={draft.currency} label="Currency"
              disabled={!editable || !can('costing.selling_price.edit')}
              onChange={(v) => patch({ currency: v })} />
            <NumField label="₹ per unit of currency" value={draft.fx_rate} step={0.01}
              disabled={!editable || !can('costing.selling_price.edit') || draft.currency === 'INR'}
              onChange={(v) => patch({ fx_rate: v })}
              help={draft.currency === 'INR' ? 'rupees, so 1' : 'used to compare with cost'} />
            <RateField
              label={`Selling price / pc (${draft.currency})`}
              context={{ kind: 'selling_price', ...memoryCtx, uom: 'pc' } as RateContext}
              value={draft.selling_price_per_pc}
              onChange={(v) => patch({ selling_price_per_pc: v })}
              disabled={!editable || !can('costing.selling_price.edit')}
              prefix={draft.currency === 'INR' ? '₹' : ''}
              always
            />
            <Combobox list="price_basis" value={draft.price_basis} label="Basis"
              disabled={!editable || !can('costing.selling_price.edit')}
              onChange={(v) => patch({ price_basis: v })} />
            <NumField label="Target margin %" value={draft.target_margin_pct} suffix="%" step={0.5}
              disabled={!editable} onChange={(v) => patch({ target_margin_pct: v })}
              help="what price would hit it" />
          </div>
        </section>
      )}

      <section className="card">
        <div className="card-head"><h3>Notes</h3></div>
        <div className="card-body">
          <textarea className="textarea" value={draft.notes} disabled={!editable}
            placeholder="Anything the next person reading this sheet should know — an agreed exception, a rate that is only good until March, why a line looks odd."
            onChange={(e) => patch({ notes: e.target.value })} />
        </div>
      </section>

      {/* ---------------------------------------------------- sticky summary */}
      {result && (
        <div className="cost-summary">
          <SummaryFigure label="Cost / garment"
            value={lockedCost ? <LockedValue /> : money(result.costPerPcShipped)}
            note={lockedCost ? undefined : `${money(result.totalCost, 0)} in total`} />
          <SummaryFigure label="Price / garment"
            value={result.selling_price__locked ? <LockedValue />
              : money((draft.selling_price_per_pc || 0) * (draft.fx_rate || 1))}
            note={draft.currency !== 'INR' ? `${draft.selling_price_per_pc} ${draft.currency}` : undefined} />
          <SummaryFigure label="Margin / garment"
            value={lockedMargin ? <LockedValue /> : money(result.marginPerPc ?? 0)}
            note={lockedMargin ? undefined : pct(result.marginPct ?? 0)}
            tone={(result.margin ?? 0) >= 0 ? 'ok' : 'danger'} />
          <SummaryFigure label="Order margin"
            value={lockedMargin ? <LockedValue /> : compactMoney(result.margin)}
            note={lockedCost ? undefined : `break-even ${money(result.breakEvenPricePerPc)}`}
            tone={(result.margin ?? 0) >= 0 ? 'ok' : 'danger'} />
          {editable && (
            <div className="row" style={{ justifyContent: 'flex-end', gridColumn: '1 / -1' }}>
              {can('costing.delete') && (
                <button type="button" className="btn btn-ghost" onClick={() => setConfirmDelete(true)}>Delete</button>
              )}
              {sheet.status === 'draft' && (
                <button type="button" className="btn" disabled={dirty || submit.isPending}
                  title={dirty ? 'Save first' : 'Send to management'}
                  onClick={() => submit.mutate()}>
                  Send for approval
                </button>
              )}
              {can('costing.approve') && sheet.status === 'submitted' && (
                <>
                  <button type="button" className="btn" onClick={() => decide.mutate('rejected')}>Send back</button>
                  <button type="button" className="btn btn-primary" onClick={() => decide.mutate('approved')}>Approve</button>
                </>
              )}
              <button type="button" className="btn btn-primary" disabled={!dirty || save.isPending}
                onClick={() => save.mutate(draft)}>
                {save.isPending && <span className="spinner" />}
                {dirty ? 'Save changes' : 'Saved'}
              </button>
            </div>
          )}
        </div>
      )}

      {showActual && <ActualModal sheetId={sheet.id} onClose={() => setShowActual(false)} />}
      {confirmDelete && (
        <Confirm title="Delete this cost sheet?" danger confirmLabel="Delete" busy={remove.isPending}
          onClose={() => setConfirmDelete(false)} onConfirm={() => remove.mutate()}
          body="Every line goes with it. The rates it taught the app are kept — they belong to the rate library, not to this sheet." />
      )}
    </>
  );
}

/* -------------------------------------------------------------- fragments */

function QtyStat({ label, value, note, accent }: {
  label: string; value: number; note: string; accent?: 'brand' | 'warn';
}) {
  return (
    <div className={`stat ${accent === 'brand' ? 'accent' : accent === 'warn' ? 'accent-warn' : ''}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value sm">{qty(value)}</span>
      <span className="stat-note">{note}</span>
    </div>
  );
}

function SummaryFigure({ label, value, note, tone }: {
  label: string; value: React.ReactNode; note?: React.ReactNode; tone?: 'ok' | 'danger';
}) {
  return (
    <div className="col" style={{ gap: 0 }}>
      <span className="stat-label">{label}</span>
      <span className="stat-value sm" style={{
        color: tone === 'danger' ? 'var(--danger-fg)' : tone === 'ok' ? 'var(--ok-fg)' : undefined,
      }}>{value}</span>
      {note && <span className="stat-note">{note}</span>}
    </div>
  );
}

function BlockShell({ title, hint, block, editable, onAdd, addLabel, children }: {
  title: string; hint: string; block?: ResultBlock; editable: boolean;
  onAdd?: () => void; addLabel: string; children: React.ReactNode;
}) {
  if (block?.locked) {
    return (
      <section className="card card-pad">
        <div className="between">
          <h3>{title}</h3>
          <LockedValue />
        </div>
        <p className="tiny muted" style={{ marginTop: 6 }}>
          Your role does not include this part of the cost build-up.
        </p>
      </section>
    );
  }
  return (
    <details className="cost-block" open>
      <summary>
        <span className="chev"><Icon.Chevron size={15} /></span>
        <span>{title}</span>
        <span className="tiny subtle desktop-only">{hint}</span>
        {block && (
          <span className="totals">
            <span className="tiny muted desktop-only">{pct(block.pctOfCost, 0)} of cost</span>
            <span><span className="tiny muted">per pc </span><b>{money(block.perPc)}</b></span>
            <b>{money(block.total, 0)}</b>
          </span>
        )}
      </summary>
      <div className="cost-lines">
        {children}
        {editable && onAdd && (
          <div>
            <button type="button" className="btn btn-sm" onClick={onAdd}>
              <Icon.Plus size={14} /> {addLabel}
            </button>
          </div>
        )}
      </div>
    </details>
  );
}

function LineFoot({ line, onRemove, editable }: {
  line?: ResultLine; onRemove: () => void; editable: boolean;
}) {
  return (
    <div className="line-foot">
      <span className="tiny muted">
        {line ? (
          <>
            {line.qty.toLocaleString('en-IN')} {line.qtyUom} × {money(line.rate)} {line.rateUom}
            {line.detail && <> · {line.detail}</>}
          </>
        ) : <span className="subtle">Fill the line to see what it costs.</span>}
      </span>
      <div className="row">
        {line && (
          <>
            <b className="num">{money(line.total, 0)}</b>
            <span className="badge">{money(line.perPc)}/pc</span>
          </>
        )}
        {editable && (
          <button type="button" className="btn btn-ghost btn-sm btn-icon"
            aria-label="Remove this line" onClick={onRemove}>✕</button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ fabric block */

function FabricBlock({ draft, patch, editable, memoryCtx, block }: {
  draft: Draft; patch: (n: Partial<Draft>) => void; editable: boolean;
  memoryCtx: { buyer: string; style: string }; block?: ResultBlock;
}) {
  const setLine = (i: number, next: Partial<FabricLine>) =>
    patch({ fabric: draft.fabric.map((l, j) => (j === i ? { ...l, ...next } : l)) });

  return (
    <BlockShell
      title="Fabric"
      hint="kilograms × ₹/kg, wastage included"
      block={block}
      editable={editable}
      addLabel="Add a fabric"
      onAdd={() => patch({ fabric: [...draft.fabric, blankFabric()] })}
    >
      {draft.fabric.length === 0 && <p className="tiny subtle">No fabric on this sheet yet.</p>}
      {draft.fabric.map((line, i) => {
        const rate = line.rate_mode === 'flat'
          ? line.flat_rate_per_kg
          : line.components.reduce((s, c) => s + (c.rate_per_kg || 0) / (1 - Math.min(c.loss_pct || 0, 95) / 100), 0);
        return (
          <div className="line-card" key={i}>
            <div className="line-grid">
              <Combobox list="fabric_types" label="Fabric" value={line.fabric_type} disabled={!editable}
                onChange={(v) => setLine(i, { fabric_type: v })} required />
              <Combobox list="colours" label="Colour" value={line.colour} disabled={!editable}
                onChange={(v) => setLine(i, { colour: v })} help="blank = every colour" />
              <Combobox list="fabric_parts" label="Part" value={line.part} disabled={!editable}
                onChange={(v) => setLine(i, { part: v })} />
              <NumField label="Consumption" suffix="g/pc" value={line.consumption_g_per_pc} step={1}
                disabled={!editable} onChange={(v) => setLine(i, { consumption_g_per_pc: v })} />
              <NumField label="Wastage" suffix="%" value={line.wastage_pct} step={0.5}
                disabled={!editable} onChange={(v) => setLine(i, { wastage_pct: v })}
                help="cutting loss on top" />
              <NumField label="Applies to" suffix="%" value={line.applies_qty_pct} step={5}
                disabled={!editable} onChange={(v) => setLine(i, { applies_qty_pct: v })}
                help="% of pieces" />
            </div>

            <div className="col" style={{ gap: 'var(--s-2)' }}>
              <div className="between">
                <span className="label">
                  Rate build-up
                  <span className="subtle" style={{ fontWeight: 400 }}> — knitting moves with the fabric, dyeing with the colour</span>
                </span>
                <div className="btn-group">
                  <button type="button" className="btn btn-sm" disabled={!editable}
                    aria-pressed={line.rate_mode === 'buildup'}
                    onClick={() => setLine(i, { rate_mode: 'buildup' })}>Build-up</button>
                  <button type="button" className="btn btn-sm" disabled={!editable}
                    aria-pressed={line.rate_mode === 'flat'}
                    onClick={() => setLine(i, { rate_mode: 'flat' })}>One rate</button>
                </div>
              </div>

              {line.rate_mode === 'flat' ? (
                <div style={{ maxWidth: 220 }}>
                  <RateField label="Rate" suffix="/kg" disabled={!editable}
                    context={{ kind: 'fabric_flat', ...memoryCtx, fabric_type: line.fabric_type, colour: line.colour, uom: 'kg' } as RateContext}
                    value={line.flat_rate_per_kg}
                    onChange={(v) => setLine(i, { flat_rate_per_kg: v })} />
                </div>
              ) : (
                <div className="col" style={{ gap: 6 }}>
                  {line.components.map((c, ci) => (
                    <div className="comp-row" key={ci}>
                      <Combobox list="fabric_components" label={ci === 0 ? 'Component' : undefined}
                        value={c.component} disabled={!editable}
                        onChange={(v) => setLine(i, {
                          components: line.components.map((x, k) => (k === ci ? { ...x, component: v } : x)),
                        })} />
                      <RateField label={ci === 0 ? 'Rate' : undefined} suffix="/kg" disabled={!editable}
                        context={{
                          kind: 'fabric_component', ...memoryCtx,
                          fabric_type: line.fabric_type, colour: line.colour,
                          component: c.component, vendor: c.vendor, uom: 'kg',
                        } as RateContext}
                        value={c.rate_per_kg}
                        onChange={(v) => setLine(i, {
                          components: line.components.map((x, k) => (k === ci ? { ...x, rate_per_kg: v } : x)),
                        })} />
                      <NumField label={ci === 0 ? 'Loss' : undefined} suffix="%" value={c.loss_pct} step={0.5}
                        disabled={!editable}
                        onChange={(v) => setLine(i, {
                          components: line.components.map((x, k) => (k === ci ? { ...x, loss_pct: v } : x)),
                        })} />
                      {editable && (
                        <button type="button" className="btn btn-ghost btn-sm btn-icon"
                          aria-label="Remove component" style={{ marginBottom: 2 }}
                          onClick={() => setLine(i, { components: line.components.filter((_, k) => k !== ci) })}>✕</button>
                      )}
                    </div>
                  ))}
                  <div className="between">
                    {editable && (
                      <button type="button" className="btn btn-ghost btn-sm"
                        onClick={() => setLine(i, { components: [...line.components, blankComponent()] })}>
                        <Icon.Plus size={13} /> Add a component
                      </button>
                    )}
                    <span className="tiny muted">Rate works out at <b>{money(rate)}/kg</b></span>
                  </div>
                </div>
              )}
            </div>

            <LineFoot line={block?.lines[i]} editable={editable}
              onRemove={() => patch({ fabric: draft.fabric.filter((_, j) => j !== i) })} />
          </div>
        );
      })}
    </BlockShell>
  );
}

/* -------------------------------------------------------------- trim block */

function TrimBlock({ draft, patch, editable, memoryCtx, block }: {
  draft: Draft; patch: (n: Partial<Draft>) => void; editable: boolean;
  memoryCtx: { buyer: string; style: string }; block?: ResultBlock;
}) {
  const setLine = (i: number, next: Partial<TrimLine>) =>
    patch({ trims: draft.trims.map((l, j) => (j === i ? { ...l, ...next } : l)) });

  return (
    <BlockShell title="Trims" hint="per piece" block={block} editable={editable}
      addLabel="Add a trim" onAdd={() => patch({ trims: [...draft.trims, blankTrim()] })}>
      {draft.trims.length === 0 && <p className="tiny subtle">No trims on this sheet yet.</p>}
      {draft.trims.map((line, i) => (
        <div className="line-card" key={i}>
          <div className="line-grid">
            <Combobox list="trim_items" label="Trim" value={line.trim_item} disabled={!editable}
              onChange={(v) => setLine(i, { trim_item: v })} required />
            <Combobox list="colours" label="Colour" value={line.colour} disabled={!editable}
              onChange={(v) => setLine(i, { colour: v })} help="blank = all" />
            <NumField label="Qty / garment" value={line.qty_per_pc} step={0.25} disabled={!editable}
              onChange={(v) => setLine(i, { qty_per_pc: v })} />
            <Combobox list="trim_uoms" label="Unit" value={line.uom} disabled={!editable}
              onChange={(v) => setLine(i, { uom: v })} />
            <RateField label="Rate" prefix="₹" suffix={`/${line.uom || 'pc'}`} disabled={!editable}
              context={{ kind: 'trim', ...memoryCtx, trim_item: line.trim_item, colour: line.colour, uom: line.uom } as RateContext}
              value={line.rate_per_unit} onChange={(v) => setLine(i, { rate_per_unit: v })} />
            <NumField label="Wastage" suffix="%" value={line.wastage_pct} step={0.5} disabled={!editable}
              onChange={(v) => setLine(i, { wastage_pct: v })} />
            <NumField label="Applies to" suffix="%" value={line.applies_qty_pct} step={5} disabled={!editable}
              onChange={(v) => setLine(i, { applies_qty_pct: v })} />
          </div>
          <LineFoot line={block?.lines[i]} editable={editable}
            onRemove={() => patch({ trims: draft.trims.filter((_, j) => j !== i) })} />
        </div>
      ))}
    </BlockShell>
  );
}

/* ---------------------------------------------------------- job work block */

function JobWorkBlock({ draft, patch, editable, memoryCtx, block }: {
  draft: Draft; patch: (n: Partial<Draft>) => void; editable: boolean;
  memoryCtx: { buyer: string; style: string }; block?: ResultBlock;
}) {
  const setLine = (i: number, next: Partial<JobWorkLine>) =>
    patch({ jobwork: draft.jobwork.map((l, j) => (j === i ? { ...l, ...next } : l)) });

  return (
    <BlockShell title="Job work" hint="₹ per piece, per process, per vendor" block={block} editable={editable}
      addLabel="Add a process" onAdd={() => patch({ jobwork: [...draft.jobwork, blankJobWork()] })}>
      {draft.jobwork.length === 0 && (
        <p className="tiny subtle">
          Nothing outsourced. Job-work lines are proposed from the outsourced steps in this order's route.
        </p>
      )}
      {draft.jobwork.map((line, i) => (
        <div className="line-card" key={i}>
          <div className="line-grid">
            <Combobox list="jobwork_processes" label="Process" value={line.process} disabled={!editable}
              onChange={(v) => setLine(i, { process: v })} required />
            <Combobox list="vendors" label="Vendor" value={line.vendor} disabled={!editable}
              onChange={(v) => setLine(i, { vendor: v })} />
            <Combobox list="colours" label="Colour" value={line.colour} disabled={!editable}
              onChange={(v) => setLine(i, { colour: v })} help="blank = all" />
            <RateField label="Rate" suffix="/pc" disabled={!editable}
              context={{ kind: 'jobwork', ...memoryCtx, process: line.process, vendor: line.vendor, colour: line.colour, uom: 'pc' } as RateContext}
              value={line.rate_per_pc} onChange={(v) => setLine(i, { rate_per_pc: v })} />
            <NumField label="Applies to" suffix="%" value={line.applies_qty_pct} step={5} disabled={!editable}
              onChange={(v) => setLine(i, { applies_qty_pct: v })} help="e.g. front panel only" />
            <NumField label="Vendor loss" suffix="%" value={line.vendor_loss_pct} step={0.5} disabled={!editable}
              onChange={(v) => setLine(i, { vendor_loss_pct: v })} help="paid for, never returned" />
            <NumField label="Freight" prefix="₹" value={line.freight_per_order} step={100} disabled={!editable}
              onChange={(v) => setLine(i, { freight_per_order: v })} help="for the whole order" />
          </div>
          <LineFoot line={block?.lines[i]} editable={editable}
            onRemove={() => patch({ jobwork: draft.jobwork.filter((_, j) => j !== i) })} />
        </div>
      ))}
    </BlockShell>
  );
}

/* --------------------------------------------------------------- CMT block */

const CMT_BASIS = [
  { value: 'per_pc', label: '₹ per piece' },
  { value: 'per_sam_min', label: 'SAM × ₹ per minute' },
  { value: 'per_order', label: '₹ for the order' },
  { value: 'pct_of_cost', label: '% of the cost so far' },
];

function CmtBlock({ draft, patch, editable, memoryCtx, block }: {
  draft: Draft; patch: (n: Partial<Draft>) => void; editable: boolean;
  memoryCtx: { buyer: string; style: string }; block?: ResultBlock;
}) {
  const setLine = (i: number, next: Partial<CmtLine>) =>
    patch({ cmt: draft.cmt.map((l, j) => (j === i ? { ...l, ...next } : l)) });

  return (
    <BlockShell title="CMT" hint="cutting, sewing, fusing, ironing, checking, packing" block={block}
      editable={editable} addLabel="Add an operation"
      onAdd={() => patch({ cmt: [...draft.cmt, blankCmt()] })}>
      {draft.cmt.map((line, i) => (
        <div className="line-card" key={i}>
          <div className="line-grid">
            <Combobox list="cmt_operations" label="Operation" value={line.operation} disabled={!editable}
              onChange={(v) => setLine(i, { operation: v })} required />
            <SelectField label="Costed as" value={line.basis} disabled={!editable}
              options={CMT_BASIS}
              onChange={(v) => setLine(i, { basis: v as CmtLine['basis'] })} />
            <RateField
              label={line.basis === 'pct_of_cost' ? 'Percentage' : line.basis === 'per_sam_min' ? 'Rate / minute' : 'Rate'}
              prefix={line.basis === 'pct_of_cost' ? '' : '₹'}
              suffix={line.basis === 'pct_of_cost' ? '%' : line.basis === 'per_sam_min' ? '/min' : line.basis === 'per_order' ? '/order' : '/pc'}
              disabled={!editable}
              context={{ kind: 'cmt', ...memoryCtx, operation: line.operation, uom: line.basis } as RateContext}
              value={line.rate} onChange={(v) => setLine(i, { rate: v })} />
            {line.basis === 'per_sam_min' && (
              <>
                <NumField label="SAM" suffix="min" value={line.sam_min} step={0.5} disabled={!editable}
                  onChange={(v) => setLine(i, { sam_min: v })} />
                <NumField label="Efficiency" suffix="%" value={line.efficiency_pct} step={5} disabled={!editable}
                  onChange={(v) => setLine(i, { efficiency_pct: v })}
                  help="65% means each SAM minute costs 1.54" />
              </>
            )}
            {line.basis !== 'per_order' && line.basis !== 'pct_of_cost' && (
              <NumField label="Applies to" suffix="%" value={line.applies_qty_pct} step={5} disabled={!editable}
                onChange={(v) => setLine(i, { applies_qty_pct: v })} />
            )}
          </div>
          <LineFoot line={block?.lines[i]} editable={editable}
            onRemove={() => patch({ cmt: draft.cmt.filter((_, j) => j !== i) })} />
        </div>
      ))}
    </BlockShell>
  );
}

/* ---------------------------------------------------------- overhead block */

const OH_BASIS = [
  { value: 'per_order', label: '₹ for the order' },
  { value: 'per_pc', label: '₹ per piece' },
  { value: 'pct_of_cost', label: '% of the cost' },
  { value: 'pct_of_revenue', label: '% of the revenue' },
];

function OverheadBlock({ draft, patch, editable, memoryCtx, block }: {
  draft: Draft; patch: (n: Partial<Draft>) => void; editable: boolean;
  memoryCtx: { buyer: string; style: string }; block?: ResultBlock;
}) {
  const setLine = (i: number, next: Partial<OverheadLine>) =>
    patch({ overheads: draft.overheads.map((l, j) => (j === i ? { ...l, ...next } : l)) });

  return (
    <BlockShell title="Other costs" hint="sampling, lab, documentation, transport, commission" block={block}
      editable={editable} addLabel="Add a cost"
      onAdd={() => patch({ overheads: [...draft.overheads, blankOverhead()] })}>
      {draft.overheads.map((line, i) => (
        <div className="line-card" key={i}>
          <div className="line-grid">
            <Combobox list="overhead_categories" label="Cost" value={line.category} disabled={!editable}
              onChange={(v) => setLine(i, { category: v })} required />
            <SelectField label="Costed as" value={line.basis} disabled={!editable} options={OH_BASIS}
              onChange={(v) => setLine(i, { basis: v as OverheadLine['basis'] })} />
            <RateField
              label={line.basis.startsWith('pct') ? 'Percentage' : 'Amount'}
              prefix={line.basis.startsWith('pct') ? '' : '₹'}
              suffix={line.basis.startsWith('pct') ? '%' : line.basis === 'per_pc' ? '/pc' : ''}
              disabled={!editable}
              context={{ kind: 'overhead', ...memoryCtx, category: line.category, uom: line.basis } as RateContext}
              value={line.amount} onChange={(v) => setLine(i, { amount: v })} />
            <Combobox list="vendors" label="Vendor / lab" value={line.vendor} disabled={!editable}
              onChange={(v) => setLine(i, { vendor: v })} />
            <TextField label="Note" value={line.remarks} disabled={!editable}
              onChange={(v) => setLine(i, { remarks: v })} />
          </div>
          <LineFoot line={block?.lines[i]} editable={editable}
            onRemove={() => patch({ overheads: draft.overheads.filter((_, j) => j !== i) })} />
        </div>
      ))}
    </BlockShell>
  );
}

/* ------------------------------------------------------------- the preview */

function ProposalPreview({ proposal }: { proposal: Draft & { selling_price_because?: string } }) {
  const rows = [
    ['Fabric', proposal.fabric.map((f) => `${f.fabric_type}${f.colour ? ` · ${f.colour}` : ''} at ${f.consumption_g_per_pc} g/pc`)],
    ['Job work', proposal.jobwork.map((j) => `${j.process}${j.vendor ? ` at ${j.vendor}` : ''}${j.rate_per_pc ? ` — ₹${j.rate_per_pc}/pc` : ''}`)],
    ['CMT', proposal.cmt.map((c) => `${c.operation}${c.rate ? ` — ₹${c.rate}` : ''}`)],
    ['Other costs', proposal.overheads.map((o) => `${o.category}${o.amount ? ` — ₹${o.amount}` : ''}`)],
  ] as const;

  return (
    <div className="col" style={{ gap: 'var(--s-3)' }}>
      <span className="label">What the draft will contain</span>
      <div className="grid-3">
        {rows.map(([title, items]) => (
          <div key={title} className="card card-pad col" style={{ gap: 6, background: 'var(--bg-sunken)' }}>
            <b className="tiny">{title}</b>
            {items.length === 0
              ? <span className="tiny subtle">nothing proposed</span>
              : items.slice(0, 8).map((t) => <span key={t} className="tiny muted">{t}</span>)}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------- plan vs actual -- */

interface ActualPayload {
  order: Order;
  plan: CostResult;
  actual: {
    produced: number; shipped: number; rejected: number;
    fabric: { rows: { fabric_type: string; colour: string; kg: number; rate: number; source: string; total: number }[]; total: number };
    jobwork: { rows: { process: string; vendor: string; qty: number; rate: number; total: number }[]; total: number };
    trims: { total: number }; cmt: { total: number }; overheads: { total: number };
    totalCost: number; costPerPcProduced: number; costPerPcShipped: number;
    revenue: number; margin: number; marginPct: number;
  };
}

function ActualModal({ sheetId, onClose }: { sheetId: number; onClose: () => void }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['cost-actual', sheetId],
    queryFn: () => api.get<ActualPayload>(`/api/costing/${sheetId}/actual`),
  });

  return (
    <Modal title="Plan against actual" wide onClose={onClose}
      subtitle="Planned figures come from this sheet. Actual quantities come from what the floor and the store logged; fabric is valued at the receipt rate where one exists.">
      {isLoading && <Loading rows={6} />}
      {error && <p className="muted">{(error as Error).message}</p>}
      {data && (
        <div className="col" style={{ gap: 'var(--s-4)' }}>
          <div className="stat-grid">
            <Stat2 label="Made so far" value={qty(data.actual.produced)} note="pieces cut" />
            <Stat2 label="Shipped" value={qty(data.actual.shipped)} note="out of the gate" />
            <Stat2 label="Rejected" value={qty(data.actual.rejected)} note="never leaves" />
            <Stat2 label="Cost per garment" value={money(data.actual.costPerPcShipped)}
              note={`planned ${money(data.plan.costPerPcShipped)}`} />
          </div>

          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Block</th><th className="num">Planned</th><th className="num">Actual so far</th><th className="num">Difference</th></tr>
              </thead>
              <tbody>
                {([
                  ['Fabric', data.plan.blocks.find((b) => b.key === 'fabric')?.total ?? 0, data.actual.fabric.total],
                  ['Trims', data.plan.blocks.find((b) => b.key === 'trims')?.total ?? 0, data.actual.trims.total],
                  ['Job work', data.plan.blocks.find((b) => b.key === 'jobwork')?.total ?? 0, data.actual.jobwork.total],
                  ['CMT', data.plan.blocks.find((b) => b.key === 'cmt')?.total ?? 0, data.actual.cmt.total],
                  ['Other costs', data.plan.blocks.find((b) => b.key === 'overheads')?.total ?? 0, data.actual.overheads.total],
                ] as [string, number, number][]).map(([label, plan, actual]) => (
                  <tr key={label}>
                    <td>{label}</td>
                    <td className="num">{money(plan, 0)}</td>
                    <td className="num">{money(actual, 0)}</td>
                    <td className="num" style={{ color: actual > plan ? 'var(--danger-fg)' : 'var(--ok-fg)' }}>
                      {actual > plan ? '+' : ''}{money(actual - plan, 0)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Total</td>
                  <td className="num">{money(data.plan.totalCost, 0)}</td>
                  <td className="num">{money(data.actual.totalCost, 0)}</td>
                  <td className="num">{money(data.actual.totalCost - (data.plan.totalCost ?? 0), 0)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          {data.actual.fabric.rows.length > 0 && (
            <div className="col" style={{ gap: 'var(--s-2)' }}>
              <span className="label">Fabric actually issued</span>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr><th>Fabric</th><th>Colour</th><th className="num">Kg</th><th className="num">₹/kg</th><th>Rate from</th><th className="num">Value</th></tr>
                  </thead>
                  <tbody>
                    {data.actual.fabric.rows.map((r, i) => (
                      <tr key={i}>
                        <td>{r.fabric_type}</td>
                        <td>{r.colour}</td>
                        <td className="num">{r.kg}</td>
                        <td className="num">{money(r.rate)}</td>
                        <td><span className="badge">{r.source === 'receipt' ? 'store receipt' : 'the plan'}</span></td>
                        <td className="num">{money(r.total, 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {data.actual.fabric.rows.some((r) => r.source !== 'receipt') && (
                <p className="tiny muted">
                  Some fabric receipts have no rate against them, so the planned rate was used for those lines.
                  Entering the rate on the store receipt makes this figure true.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function Stat2({ label, value, note }: { label: string; value: React.ReactNode; note?: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value sm">{value}</span>
      {note && <span className="stat-note">{note}</span>}
    </div>
  );
}
