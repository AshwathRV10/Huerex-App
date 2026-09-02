import { EntryPage, type EntryColumn } from '../components/EntryPage';
import { OrderContext } from './OrderContext';
import type { GridRow } from '../components/BulkGrid';
import { qty } from '../lib/format';

/**
 * The floor screens.
 *
 * Each is a list of columns and a sentence of guidance. Everything else —
 * bulk entry, carry-forward, paste, validation, the history tab, the mobile
 * layout, the audit trail — comes from EntryPage, so they cannot drift apart.
 *
 * The `carry` flags are the important design decision on each screen: they say
 * what stays the same between two consecutive entries. On a cutting table that
 * is the date, the colour and the fabric; only the size and the quantity move.
 */

const dateCol: EntryColumn = { key: 'txn_date', label: 'Date', type: 'date', carry: true, required: true, width: 140 };
const remarksCol: EntryColumn = { key: 'remarks', label: 'Remarks', type: 'text', width: 180, placeholder: 'optional' };

const num = (row: GridRow, key: string) => Number(row[key] ?? 0);

/* ------------------------------------------------------------------ cutting */
export function CuttingPage() {
  return (
    <EntryPage
      module="cutting"
      endpoint="cutting"
      title="Cutting"
      lede="Where every garment enters the system. A re-cut panel or a swatch that must not inflate the order count goes in with “Counts” unticked."
      entryTitle="Log a cut"
      context={(o) => <OrderContext orderNo={o} focus="cutting" />}
      columns={[
        dateCol,
        { key: 'colour', label: 'Colour', type: 'combo', list: 'colours', carry: true, required: true, width: 150 },
        { key: 'size', label: 'Size', type: 'combo', list: 'sizes', required: true, width: 120 },
        { key: 'fabric_type', label: 'Fabric', type: 'combo', list: 'fabric_types', carry: true, width: 150 },
        { key: 'cut_qty', label: 'Cut qty', type: 'number', required: true, width: 100 },
        { key: 'pc_weight_g', label: 'Pc wt (g)', type: 'number', carry: true, width: 100, step: 0.1, hint: 'drives fabric used' },
        { key: 'fabric_gsm', label: 'GSM', type: 'number', carry: true, width: 90 },
        { key: 'lot_no', label: 'Lot / bundle', type: 'text', carry: true, width: 120 },
        { key: 'counts_as_garment', label: 'Counts', type: 'check', width: 70, hint: 'as a garment' },
        { key: 'table_no', label: 'Table', type: 'text', carry: true, width: 90 },
        remarksCol,
      ]}
      seed={{ counts_as_garment: true }}
      validate={(r) => {
        if (!r.colour) return 'Which colour was cut?';
        if (!r.size) return 'Which size was cut?';
        if (!num(r, 'cut_qty')) return 'How many pieces were cut?';
        return null;
      }}
    />
  );
}

/* ------------------------------------------------------------------- fusing */
export function FusingPage() {
  return (
    <EntryPage
      module="fusing"
      endpoint="fusing"
      title="Fusing"
      lede="Fusing is done inside the factory, so it is not job work. Put it in the route at whatever step it actually happens — before sewing or after, both work."
      entryTitle="Log fusing"
      context={(o) => <OrderContext orderNo={o} focus="fusing" />}
      columns={[
        dateCol,
        { key: 'colour', label: 'Colour', type: 'combo', list: 'colours', carry: true, required: true, width: 150 },
        { key: 'size', label: 'Size', type: 'combo', list: 'sizes', required: true, width: 120 },
        { key: 'fused_qty', label: 'Fused qty', type: 'number', required: true, width: 110 },
        remarksCol,
      ]}
      validate={(r) => {
        if (!r.colour || !r.size) return 'Colour and size are both needed.';
        if (!num(r, 'fused_qty')) return 'How many pieces were fused?';
        return null;
      }}
    />
  );
}

/* ----------------------------------------------------------------- job work */
export function JobWorkPage() {
  return (
    <EntryPage
      module="jobwork"
      endpoint="jobwork"
      title="Job work"
      lede="Anything done outside — print, embroidery, wash, tie & dye. Two rows per movement: one OUT when the pieces leave, one IN when they come back. Nothing can come back that did not go out."
      entryTitle="Log a movement"
      context={(o) => <OrderContext orderNo={o} focus="jobwork" />}
      columns={[
        dateCol,
        { key: 'direction', label: 'Direction', type: 'select', carry: true, width: 110,
          options: [{ value: 'OUT', label: 'OUT — leaving' }, { value: 'IN', label: 'IN — returning' }] },
        { key: 'process', label: 'Process', type: 'combo', list: 'jobwork_processes', carry: true, required: true, width: 150 },
        { key: 'vendor', label: 'Vendor', type: 'combo', list: 'vendors', carry: true, required: true, width: 190 },
        { key: 'colour', label: 'Colour', type: 'combo', list: 'colours', carry: true, required: true, width: 150 },
        { key: 'size', label: 'Size', type: 'combo', list: 'sizes', width: 110 },
        { key: 'qty', label: 'Qty', type: 'number', required: true, width: 100 },
        { key: 'dc_no', label: 'DC no', type: 'text', carry: true, width: 110 },
        remarksCol,
      ]}
      seed={{ direction: 'OUT' }}
      validate={(r) => {
        if (!r.process) return 'Which process is this?';
        if (!r.vendor) return 'Which vendor?';
        if (!r.colour) return 'Which colour?';
        if (!num(r, 'qty')) return 'How many pieces?';
        return null;
      }}
    />
  );
}

/* ------------------------------------------------------------------- sewing */
export function SewingPage() {
  return (
    <EntryPage
      module="sewing"
      endpoint="sewing"
      title="Sewing"
      lede={<>Three fixed blocks a day: 09:00–12:30, 13:30–18:00, 18:30–20:30. Colour and size are optional — fill them and WIP is exact, leave them blank and the output is spread across whatever was available to sew.</>}
      entryTitle="Log output"
      context={(o) => <OrderContext orderNo={o} focus="sewing" />}
      columns={[
        dateCol,
        { key: 'line', label: 'Line', type: 'combo', list: 'lines', carry: true, required: true, width: 120 },
        { key: 'operators', label: 'Operators', type: 'number', carry: true, width: 100 },
        { key: 'hours', label: 'Hours', type: 'number', carry: true, width: 90, step: 0.5 },
        { key: 'block1', label: 'Block 1', type: 'number', width: 95, hint: '09:00–12:30' },
        { key: 'block2', label: 'Block 2', type: 'number', width: 95, hint: '13:30–18:00' },
        { key: 'block3', label: 'Block 3', type: 'number', width: 95, hint: '18:30–20:30' },
        { key: 'issued_to_line', label: 'Issued to line', type: 'number', width: 120, hint: 'fed in today' },
        { key: 'colour', label: 'Colour', type: 'combo', list: 'colours', carry: true, width: 140, hint: 'optional' },
        { key: 'size', label: 'Size', type: 'combo', list: 'sizes', width: 110, hint: 'optional' },
        remarksCol,
      ]}
      derived={[{
        key: 'output', label: 'Output', align: 'right',
        render: (r) => qty(Number(r.block1 ?? 0) + Number(r.block2 ?? 0) + Number(r.block3 ?? 0)),
      }]}
      validate={(r) => {
        if (!r.line) return 'Which line?';
        const out = num(r, 'block1') + num(r, 'block2') + num(r, 'block3');
        if (out === 0 && !num(r, 'issued_to_line')) return 'Enter the output for at least one block, or what was issued to the line.';
        return null;
      }}
    />
  );
}

/* ----------------------------------------------------------------- checking */
export function CheckingPage() {
  return (
    <EntryPage
      module="checking"
      endpoint="checking"
      title="Checking &amp; finishing"
      lede="Checked has to equal Pass + Alter + Reject, and the screen will not save until it does. Re-checked OK moves pieces out of rework and into the good pool."
      entryTitle="Log checking"
      context={(o) => <OrderContext orderNo={o} focus="checking" />}
      columns={[
        dateCol,
        { key: 'colour', label: 'Colour', type: 'combo', list: 'colours', carry: true, required: true, width: 150 },
        { key: 'size', label: 'Size', type: 'combo', list: 'sizes', required: true, width: 110 },
        { key: 'line', label: 'Line', type: 'combo', list: 'lines', carry: true, width: 110 },
        { key: 'checked_qty', label: 'Checked', type: 'number', required: true, width: 100 },
        { key: 'pass_qty', label: 'Pass', type: 'number', width: 95 },
        { key: 'alter_qty', label: 'Alter', type: 'number', width: 95 },
        { key: 'reject_qty', label: 'Reject', type: 'number', width: 95 },
        { key: 'rechecked_ok', label: 'Re-checked OK', type: 'number', width: 130, hint: 'back from rework' },
        { key: 'defect_notes', label: 'Defects', type: 'text', width: 170 },
      ]}
      validate={(r) => {
        if (!r.colour || !r.size) return 'Colour and size are both needed.';
        const checked = num(r, 'checked_qty');
        const parts = num(r, 'pass_qty') + num(r, 'alter_qty') + num(r, 'reject_qty');
        if (checked === 0 && num(r, 'rechecked_ok') > 0) return null;
        if (checked === 0) return 'How many pieces were checked?';
        if (checked !== parts) {
          return `Pass + Alter + Reject comes to ${parts}, but ${checked} were checked. They have to agree.`;
        }
        return null;
      }}
    />
  );
}

/* ------------------------------------------------------------------ packing */
export function PackingPage() {
  return (
    <EntryPage
      module="packing"
      endpoint="packing"
      title="Packing"
      lede="Cartons, and the trims that must be there first. A trim marked “blocks packing” and short will hold the whole order — the screen will say so rather than letting the carton close."
      entryTitle="Log packing"
      context={(o) => <OrderContext orderNo={o} focus="packing" />}
      columns={[
        dateCol,
        { key: 'colour', label: 'Colour', type: 'combo', list: 'colours', carry: true, required: true, width: 150 },
        { key: 'size', label: 'Size', type: 'combo', list: 'sizes', required: true, width: 110 },
        { key: 'packed_qty', label: 'Packed', type: 'number', required: true, width: 100 },
        { key: 'carton_no', label: 'Carton no', type: 'text', carry: true, width: 120 },
        remarksCol,
      ]}
      validate={(r) => {
        if (!r.colour || !r.size) return 'Colour and size are both needed.';
        if (!num(r, 'packed_qty')) return 'How many pieces went in?';
        return null;
      }}
    />
  );
}

/* --------------------------------------------------------------- inspection */
export function InspectionPage() {
  return (
    <EntryPage
      module="inspection"
      endpoint="inspection"
      title="Final inspection"
      lede="The gate in front of shipment. If inspection is in the order's route, nothing can ship until a Pass is recorded here."
      entryTitle="Record an inspection"
      context={(o) => <OrderContext orderNo={o} focus="shipment" />}
      columns={[
        { key: 'inspection_date', label: 'Date', type: 'date', carry: true, required: true, width: 140 },
        { key: 'offered_qty', label: 'Offered', type: 'number', width: 110 },
        { key: 'result', label: 'Result', type: 'combo', list: 'inspection_results', required: true, width: 130 },
        { key: 'aql', label: 'AQL', type: 'text', carry: true, width: 100 },
        { key: 'inspector', label: 'Inspector / agency', type: 'text', carry: true, width: 190 },
        remarksCol,
      ]}
      seed={{ result: 'Pending' }}
      validate={(r) => (r.result ? null : 'Pass, fail or pending?')}
    />
  );
}

/* ----------------------------------------------------------------- shipment */
export function ShipmentPage() {
  return (
    <EntryPage
      module="shipment"
      endpoint="shipment"
      title="Shipment"
      lede="The last movement, and the one that closes the order. Excess ships in these same cartons, which is why shipped can exceed the order quantity."
      entryTitle="Log a dispatch"
      context={(o) => <OrderContext orderNo={o} focus="shipment" />}
      columns={[
        dateCol,
        { key: 'colour', label: 'Colour', type: 'combo', list: 'colours', carry: true, required: true, width: 150 },
        { key: 'size', label: 'Size', type: 'combo', list: 'sizes', required: true, width: 110 },
        { key: 'ship_qty', label: 'Ship qty', type: 'number', required: true, width: 105 },
        { key: 'invoice_no', label: 'Invoice', type: 'text', carry: true, width: 130 },
        { key: 'buyer_po_no', label: 'Buyer PO', type: 'text', carry: true, width: 130 },
        { key: 'cartons', label: 'Cartons', type: 'number', width: 95, step: 0.5 },
        { key: 'gross_wt_kg', label: 'Gross kg', type: 'number', width: 100, step: 0.1 },
        { key: 'net_wt_kg', label: 'Net kg', type: 'number', width: 100, step: 0.1 },
        remarksCol,
      ]}
      validate={(r) => {
        if (!r.colour || !r.size) return 'Colour and size are both needed.';
        if (!num(r, 'ship_qty')) return 'How many pieces went out?';
        return null;
      }}
    />
  );
}

/* -------------------------------------------------------------------- trims */
export function TrimsPage() {
  return (
    <EntryPage
      module="trims"
      endpoint="trims"
      title="Trims"
      lede="What is short, and whether it stops packing. Only trims marked “blocks packing” raise a blocker — that is deliberate, so a missing price tag does not read like a missing carton."
      entryTitle="Log trims"
      context={(o) => <OrderContext orderNo={o} />}
      columns={[
        dateCol,
        { key: 'trim_item', label: 'Trim', type: 'combo', list: 'trim_items', required: true, width: 170 },
        { key: 'colour', label: 'Colour', type: 'combo', list: 'colours', carry: true, width: 140 },
        { key: 'required_qty', label: 'Required', type: 'number', width: 110 },
        { key: 'received_qty', label: 'Received', type: 'number', width: 110 },
        { key: 'issued_qty', label: 'Issued', type: 'number', width: 100 },
        { key: 'uom', label: 'Unit', type: 'combo', list: 'trim_uoms', carry: true, width: 95 },
        { key: 'blocks_packing', label: 'Blocks packing', type: 'check', width: 110 },
        { key: 'supplier', label: 'Supplier', type: 'combo', list: 'suppliers', carry: true, width: 160 },
        remarksCol,
      ]}
      seed={{ uom: 'pcs' }}
      validate={(r) => {
        if (!r.trim_item) return 'Which trim?';
        if (!num(r, 'required_qty') && !num(r, 'received_qty')) return 'Enter what is required, what arrived, or both.';
        return null;
      }}
    />
  );
}

/* -------------------------------------------------------- buyer approvals */
export function ApprovalsPage() {
  return (
    <EntryPage
      module="approvals"
      endpoint="approvals"
      title="Buyer approvals"
      lede="What the buyer still owes you. Mark an approval “blocks production” and the owner is told the moment it is raised, and again while it stays open — nobody has to remember to look."
      entryTitle="Raise or update"
      context={(o) => <OrderContext orderNo={o} />}
      columns={[
        { key: 'approval_type', label: 'Approval', type: 'combo', list: 'approval_types', required: true, width: 160 },
        { key: 'status', label: 'Status', type: 'combo', list: 'approval_status', carry: true, required: true, width: 140 },
        { key: 'sent_date', label: 'Sent', type: 'date', carry: true, width: 140 },
        { key: 'decided_date', label: 'Decided', type: 'date', width: 140 },
        { key: 'blocks_production', label: 'Blocks production', type: 'check', width: 130 },
        { key: 'required', label: 'Required', type: 'check', width: 90 },
        { key: 'owner', label: 'Owner', type: 'combo', list: 'team', carry: true, width: 150 },
        remarksCol,
      ]}
      seed={{ status: 'Pending', required: true }}
      validate={(r) => {
        if (!r.approval_type) return 'Which approval is this?';
        if ((r.status === 'Approved' || r.status === 'Rejected') && !r.decided_date) {
          return 'An approval that is decided needs the date it was decided.';
        }
        return null;
      }}
    />
  );
}

/* ---------------------------------------------------- management waivers */
export function WaiversPage() {
  return (
    <EntryPage
      module="waivers"
      endpoint="waivers"
      title="Management approvals"
      lede="Accept a delay without deleting the record. The alert stops firing until the date you set, then starts again — it is suppressed, not erased, and the dashboard still counts it. Fabric wastage and over-cuts cannot be waived here: a material loss has to be corrected."
      entryTitle="Accept an alert"
      context={(o) => <OrderContext orderNo={o} />}
      columns={[
        { key: 'alert_type', label: 'Alert', type: 'combo', list: 'alert_types', required: true, width: 170 },
        { key: 'approved', label: 'Approved', type: 'check', width: 95 },
        { key: 'approved_by', label: 'Approved by', type: 'text', carry: true, required: true, width: 160 },
        { key: 'approved_at', label: 'On', type: 'date', carry: true, width: 140 },
        { key: 'valid_until', label: 'Valid until', type: 'date', required: true, width: 140, hint: 'compulsory' },
        { key: 'reason', label: 'Reason', type: 'text', width: 260, required: true },
      ]}
      seed={{ approved: true }}
      validate={(r) => {
        if (!r.alert_type) return 'Which alert is being accepted?';
        if (!r.valid_until) return 'Valid until is compulsory — otherwise the alert would be silenced forever.';
        if (String(r.reason ?? '').trim().length < 3) return 'Say why this is being accepted.';
        return null;
      }}
    />
  );
}
