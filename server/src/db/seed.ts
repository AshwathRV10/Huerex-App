import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { all, db, one, run, tx } from './index.js';
import { migrate } from './migrate.js';
import { env } from '../env.js';
import { hashPassword, newToken } from '../auth/password.js';
import { DEFAULT_ROLES } from '../rbac/permissions.js';
import { ALERT_CATALOG } from '../engine/alerts.js';
import { PLACEHOLDER_ORDER } from '../modules/rates.js';

/**
 * Seeding does three separate jobs, and each is safe to re-run:
 *   1. roles — refreshed from the catalogue every time, because a new
 *      permission added in code has to reach the built-in roles
 *   2. master lists, buyers and vendors — inserted if missing, never clobbered
 *   3. the factory's own data from the V5.1 workbook — only when the database
 *      is empty, so a real installation is never overwritten
 */

const here = dirname(fileURLToPath(import.meta.url));
const SEED_FILE = resolve(process.env.SEED_FILE ?? join(here, '../../seed/workbook.json'));

const log = (m: string) => console.log(m);

// ---------------------------------------------------------------------- roles
function seedRoles(): void {
  tx(() => {
    for (const role of DEFAULT_ROLES) {
      const existing = one<{ id: number }>('SELECT id FROM roles WHERE code = ?', [role.code]);
      let id: number;
      if (existing) {
        id = existing.id;
        run('UPDATE roles SET name = ?, description = ?, rank = ?, is_system = 1 WHERE id = ?',
          [role.name, role.description, role.rank, id]);
      } else {
        id = run(
          'INSERT INTO roles (code, name, description, rank, is_system) VALUES (?,?,?,?,1)',
          [role.code, role.name, role.description, role.rank],
        ).lastInsertRowid as number;
      }
      // Built-in roles track the catalogue. Sites that want a different shape
      // make their own role rather than editing these.
      run('DELETE FROM role_permissions WHERE role_id = ?', [id]);
      for (const perm of new Set(role.permissions)) {
        run('INSERT OR IGNORE INTO role_permissions (role_id, perm_key) VALUES (?,?)', [id, perm]);
      }
    }
  });
  log(`  roles: ${DEFAULT_ROLES.length} built-in roles refreshed`);
}

// ---------------------------------------------------------------- first user
async function seedAdmin(): Promise<string | null> {
  const count = one<{ c: number }>('SELECT COUNT(*) AS c FROM users')!.c;
  if (count > 0) return null;
  const password = env.seedPassword || newToken(9);
  const hash = await hashPassword(password);
  const id = run(
    `INSERT INTO users (username, full_name, email, password_hash, must_change_pw)
     VALUES ('admin', 'Administrator', '', ?, 1)`, [hash],
  ).lastInsertRowid as number;
  const adminRole = one<{ id: number }>("SELECT id FROM roles WHERE code = 'admin'")!;
  run('INSERT INTO user_roles (user_id, role_id) VALUES (?,?)', [id, adminRole.id]);
  return password;
}

// -------------------------------------------------------------------- masters
const BASE_LISTS: Record<string, string[]> = {
  order_status: ['Active', 'On Hold', 'Closed', 'Cancelled'],
  approval_status: ['Pending', 'Approved', 'Rejected', 'Not Required'],
  inspection_results: ['Pending', 'Pass', 'Fail', 'Not Required'],
  recut_status: ['-', 'Recut Required', 'Recut Done', 'Ship Short Approved', 'Over Cut Approved'],
  set_roles: ['-', 'Primary', 'Secondary'],
  processes: ['Cutting', 'Fusing', 'Print', 'Embroidery', 'Wash', 'Tie&Dye', 'Rotary AOP',
    'Other', 'Sewing', 'Checking', 'Packing', 'Inspection', 'Shipment'],
  jobwork_processes: ['Print', 'Embroidery', 'Wash', 'Tie&Dye', 'Rotary AOP', 'Other'],
  delay_reasons: ['-', 'Fabric Late', 'Trims Late', 'Approval Late', 'Job Work Vendor Late',
    'Capacity Shortfall', 'Quality Rework', 'Buyer Change', 'Power/Machine Breakdown'],
  approval_types: ['Lab Dip', 'Fit Approval', 'Strike Off', 'Trim Card', 'PP Sample', 'Size Set'],
  trim_uoms: ['pcs', 'mtr', 'kg', 'dozen', 'set', 'roll', 'cone'],
  currencies: ['INR', 'USD', 'EUR', 'GBP', 'AED'],
  price_basis: ['FOB', 'CIF', 'Ex-Works', 'DDP'],
  // The costing lists — these are what make the first cost sheet quick.
  fabric_components: ['Yarn', 'Knitting', 'Dyeing', 'Compacting', 'Finishing', 'Printing',
    'Brushing', 'Bio-wash', 'Freight'],
  cmt_operations: ['Cutting', 'Sewing', 'Fusing', 'Ironing', 'Checking', 'Packing',
    'Thread Cutting', 'Overheads'],
  overhead_categories: ['Sampling', 'Lab Test', 'Documentation', 'Transportation',
    'Excess & Rejection', 'Commission', 'Finance Cost', 'Factory Overhead'],
  fabric_parts: ['Body', 'Rib', 'Collar', 'Cuff', 'Pocket', 'Hood', 'Lining', 'Placket'],
  defect_types: ['Stitching', 'Measurement', 'Fabric Fault', 'Printing', 'Embroidery',
    'Stain', 'Shade Variation', 'Trim'],
  alert_types: ALERT_CATALOG.map((a) => a.type),
};

function insertList(code: string, values: string[]): number {
  let added = 0;
  values.forEach((value, index) => {
    const v = String(value).trim();
    if (!v) return;
    const existing = one('SELECT id FROM master_values WHERE list_code = ? AND value = ? COLLATE NOCASE', [code, v]);
    if (existing) return;
    run('INSERT INTO master_values (list_code, value, sort_order) VALUES (?,?,?)', [code, v, index]);
    added += 1;
  });
  return added;
}

function seedMasters(workbook: Pick<Workbook, 'masters'> | null): void {
  let added = 0;
  tx(() => {
    for (const [code, values] of Object.entries(BASE_LISTS)) added += insertList(code, values);

    const fromBook = (workbook?.masters ?? {}) as Record<string, string[]>;
    const map: Record<string, string> = {
      buyers: 'buyers', colours: 'colours', sizes: 'sizes', lines: 'lines',
      vendors: 'vendors', fabric_types: 'fabric_types', trim_items: 'trim_items',
      team: 'team', processes: 'processes', jobwork_processes: 'jobwork_processes',
      approval_types: 'approval_types', delay_reasons: 'delay_reasons',
      recut_status: 'recut_status', inspection_results: 'inspection_results',
      order_status: 'order_status', set_roles: 'set_roles', approval_status: 'approval_status',
    };
    for (const [bookKey, listCode] of Object.entries(map)) {
      if (Array.isArray(fromBook[bookKey])) added += insertList(listCode, fromBook[bookKey]);
    }

    for (const b of all<{ value: string }>("SELECT value FROM master_values WHERE list_code = 'buyers'")) {
      run('INSERT INTO buyers (name) VALUES (?) ON CONFLICT(name) DO NOTHING', [b.value]);
    }
    for (const v of all<{ value: string }>("SELECT value FROM master_values WHERE list_code = 'vendors'")) {
      run('INSERT INTO vendors (name) VALUES (?) ON CONFLICT(name) DO NOTHING', [v.value]);
    }
  });
  log(`  masters: ${added} values added`);
}

function seedSettings(): void {
  const defaults: Record<string, string> = {
    'factory.name': 'HUEREX',
    'alert.jobwork_days': '14',
    'alert.aged_wip_days': '14',
    'alert.dhu_pct': '5',
    'alert.wastage_pct': '12',
    'alert.fabric_lead_days': '21',
    'costing.default_rejection_pct': '2',
    'costing.default_fabric_wastage_pct': '8',
    'costing.currency': 'INR',
  };
  for (const [key, value] of Object.entries(defaults)) {
    run('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO NOTHING', [key, value]);
  }
}

// ------------------------------------------------------------ workbook import
interface Workbook {
  masters: Record<string, string[]>;
  orders: Record<string, unknown>[];
  route: Record<string, unknown>[];
  matrix: Record<string, unknown>[];
  fabric: Record<string, unknown>[];
  jobwork: Record<string, unknown>[];
  cutting: Record<string, unknown>[];
  fusing: Record<string, unknown>[];
  sewing: Record<string, unknown>[];
  checking: Record<string, unknown>[];
  packing: Record<string, unknown>[];
  shipment: Record<string, unknown>[];
  inspection: Record<string, unknown>[];
  trims: Record<string, unknown>[];
  approvals: Record<string, unknown>[];
  waivers: Record<string, unknown>[];
}

function loadWorkbook(): Workbook | null {
  if (!existsSync(SEED_FILE)) {
    log(`  workbook: ${SEED_FILE} not found, skipping factory data`);
    return null;
  }
  return JSON.parse(readFileSync(SEED_FILE, 'utf8')) as Workbook;
}

const OUTSOURCED = new Set(['Print', 'Embroidery', 'Wash', 'Tie&Dye', 'Rotary AOP', 'Other']);

function importWorkbook(wbData: Workbook): void {
  const existing = one<{ c: number }>('SELECT COUNT(*) AS c FROM orders')!.c;
  if (existing > 0) {
    log(`  workbook: ${existing} orders already present, not importing`);
    return;
  }

  const orderId = new Map<string, number>();
  const id = (no: unknown): number | null => orderId.get(String(no)) ?? null;

  tx(() => {
    for (const o of wbData.orders) {
      const info = run(
        `INSERT INTO orders (order_no, buyer, style, order_qty, order_date, ex_factory_date,
            sew_complete_by, sam, buffer_pct, merchandiser, planner, status, set_group,
            set_role, fabric_lead_days)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [o.order_no, o.buyer, o.style, o.order_qty, o.order_date, o.ex_factory_date,
          o.sew_complete_by, o.sam, o.buffer_pct, o.merchandiser, o.planner,
          o.status || 'Active', o.set_group || '', o.set_role || '', o.fabric_lead_days],
      );
      orderId.set(String(o.order_no), info.lastInsertRowid as number);
    }

    for (const r of wbData.route) {
      const oid = id(r.order_no);
      if (!oid) continue;
      const process = String(r.process);
      run(
        'INSERT OR IGNORE INTO order_route (order_id, step_no, process, type) VALUES (?,?,?,?)',
        [oid, r.step_no, process, r.type || (OUTSOURCED.has(process) ? 'Outsourced' : 'In-house')],
      );
    }

    wbData.matrix.forEach((m, index) => {
      const oid = id(m.order_no);
      if (!oid) return;
      run(
        `INSERT OR IGNORE INTO order_matrix (order_id, colour, size, order_qty, recut_decision, sort_order)
         VALUES (?,?,?,?,?,?)`,
        [oid, m.colour, m.size, m.order_qty, m.recut_decision || '-', index],
      );
    });

    // The old sheet held one row per movement with receipt and issue side by
    // side. The store ledger wants them as separate movements, so they split.
    for (const f of wbData.fabric) {
      const oid = id(f.order_no);
      if (!oid) continue;
      const base = [f.txn_date, f.fabric_type, f.colour, oid] as const;
      if (Number(f.received_kg) > 0) {
        run(
          `INSERT INTO fabric_ledger (txn_date, direction, fabric_type, colour, order_id, qty_kg, remarks)
           VALUES (?, 'RECEIPT', ?, ?, ?, ?, ?)`,
          [base[0], base[1], base[2], base[3], f.received_kg, f.remarks ?? ''],
        );
      }
      if (Number(f.issued_kg) > 0) {
        run(
          `INSERT INTO fabric_ledger (txn_date, direction, fabric_type, colour, order_id, qty_kg, remarks)
           VALUES (?, 'ISSUE', ?, ?, ?, ?, '')`,
          [base[0], base[1], base[2], base[3], f.issued_kg],
        );
      }
      if (Number(f.returned_kg) > 0) {
        run(
          `INSERT INTO fabric_ledger (txn_date, direction, fabric_type, colour, order_id, qty_kg, remarks)
           VALUES (?, 'RETURN', ?, ?, ?, ?, '')`,
          [base[0], base[1], base[2], base[3], f.returned_kg],
        );
      }
      if (f.manual_consumed_kg != null && Number(f.manual_consumed_kg) > 0) {
        run(
          `INSERT INTO fabric_manual_consumption (order_id, fabric_type, colour, consumed_kg, as_of_date)
           VALUES (?,?,?,?,?) ON CONFLICT(order_id, fabric_type, colour) DO NOTHING`,
          [oid, f.fabric_type, f.colour, f.manual_consumed_kg, f.txn_date],
        );
      }
    }

    for (const j of wbData.jobwork) {
      const oid = id(j.order_no);
      if (!oid) continue;
      const step = one<{ step_no: number }>(
        'SELECT step_no FROM order_route WHERE order_id = ? AND process = ? ORDER BY step_no LIMIT 1',
        [oid, j.process],
      );
      run(
        `INSERT INTO job_work (txn_date, order_id, colour, size, process, step_no, vendor, direction, qty, remarks)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [j.txn_date, oid, j.colour, j.size ?? '', j.process, step?.step_no ?? null,
          j.vendor, j.direction, j.qty, j.remarks ?? ''],
      );
    }

    for (const c of wbData.cutting) {
      const oid = id(c.order_no);
      if (!oid) continue;
      run(
        `INSERT INTO cutting (txn_date, order_id, colour, size, fabric_type, counts_as_garment,
            lot_no, cut_qty, fabric_gsm, area_per_pc_sqm, pc_weight_g, remarks)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [c.txn_date, oid, c.colour, c.size, c.fabric_type ?? '', c.counts_as_garment ?? 1,
          c.lot_no ?? '', c.cut_qty, c.fabric_gsm, c.area_per_pc_sqm, c.pc_weight_g, c.remarks ?? ''],
      );
    }

    for (const f of wbData.fusing) {
      const oid = id(f.order_no);
      if (oid) {
        run('INSERT INTO fusing (txn_date, order_id, colour, size, fused_qty, remarks) VALUES (?,?,?,?,?,?)',
          [f.txn_date, oid, f.colour, f.size, f.fused_qty, f.remarks ?? '']);
      }
    }

    for (const s of wbData.sewing) {
      const oid = id(s.order_no);
      if (oid) {
        run(
          `INSERT INTO sewing (txn_date, order_id, line, operators, hours, block1, block2, block3,
              issued_to_line, remarks)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [s.txn_date, oid, s.line, s.operators, s.hours, s.block1, s.block2, s.block3,
            s.issued_to_line, s.remarks ?? ''],
        );
      }
    }

    for (const c of wbData.checking) {
      const oid = id(c.order_no);
      if (oid) {
        run(
          `INSERT INTO checking (txn_date, order_id, colour, size, line, checked_qty, pass_qty,
              alter_qty, reject_qty, rechecked_ok, remarks)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [c.txn_date, oid, c.colour, c.size, c.line ?? '', c.checked_qty, c.pass_qty,
            c.alter_qty, c.reject_qty, c.rechecked_ok, c.remarks ?? ''],
        );
      }
    }

    for (const p of wbData.packing ?? []) {
      const oid = id(p.order_no);
      if (oid) {
        run('INSERT INTO packing (txn_date, order_id, colour, size, packed_qty, carton_no, remarks) VALUES (?,?,?,?,?,?,?)',
          [p.txn_date, oid, p.colour, p.size, p.packed_qty, p.carton_no ?? '', p.remarks ?? '']);
      }
    }

    for (const s of wbData.shipment ?? []) {
      const oid = id(s.order_no);
      if (oid) {
        run(
          `INSERT INTO shipment (txn_date, order_id, colour, size, ship_qty, invoice_no, buyer_po_no,
              cartons, gross_wt_kg, net_wt_kg, remarks)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [s.txn_date, oid, s.colour, s.size, s.ship_qty, s.invoice_no ?? '', s.buyer_po_no ?? '',
            s.cartons ?? 0, s.gross_wt_kg ?? 0, s.net_wt_kg ?? 0, s.remarks ?? ''],
        );
      }
    }

    for (const i of wbData.inspection ?? []) {
      const oid = id(i.order_no);
      if (oid) {
        run(
          `INSERT INTO inspection (order_id, inspection_date, offered_qty, result, aql, inspector, remarks)
           VALUES (?,?,?,?,?,?,?)`,
          [oid, i.inspection_date, i.offered_qty, i.result, i.aql ?? '', i.inspector ?? '', i.remarks ?? ''],
        );
      }
    }

    for (const t of wbData.trims ?? []) {
      const oid = id(t.order_no);
      if (oid) {
        run(
          `INSERT INTO trims (txn_date, order_id, trim_item, required_qty, received_qty, issued_qty,
              blocks_packing, remarks)
           VALUES (?,?,?,?,?,?,?,?)`,
          [t.txn_date, oid, t.trim_item, t.required_qty, t.received_qty, t.issued_qty,
            t.blocks_packing ?? 0, t.remarks ?? ''],
        );
      }
    }

    for (const a of wbData.approvals ?? []) {
      const oid = id(a.order_no);
      if (oid) {
        run(
          `INSERT OR IGNORE INTO buyer_approvals (order_id, approval_type, required, status,
              sent_date, decided_date, blocks_production, remarks)
           VALUES (?,?,?,?,?,?,?,?)`,
          [oid, a.approval_type, a.required, a.status, a.sent_date, a.decided_date,
            a.blocks_production ?? 0, a.remarks ?? ''],
        );
      }
    }

    for (const w of wbData.waivers ?? []) {
      const oid = id(w.order_no);
      if (oid) {
        run(
          `INSERT INTO alert_waivers (order_id, alert_type, approved, approved_by, approved_at, reason, valid_until)
           VALUES (?,?,?,?,?,?,?)`,
          [oid, w.alert_type, w.approved, w.approved_by ?? '', w.approved_at,
            w.reason ?? '', w.valid_until ?? new Date().toISOString().slice(0, 10)],
        );
      }
    }
  });

  const counts = [
    ['orders', wbData.orders.length], ['route steps', wbData.route.length],
    ['matrix cells', wbData.matrix.length], ['fabric movements', wbData.fabric.length],
    ['job work', wbData.jobwork.length], ['cutting', wbData.cutting.length],
    ['fusing', wbData.fusing.length], ['sewing', wbData.sewing.length],
    ['checking', wbData.checking.length], ['approvals', (wbData.approvals ?? []).length],
    ['waivers', (wbData.waivers ?? []).length],
  ] as const;
  log(`  workbook: imported ${counts.map(([k, v]) => `${v} ${k}`).join(', ')}`);
}

// -------------------------------------------------- costing starting points
/**
 * A small starting rate library. Every number here is a placeholder marked as
 * such — it exists so the first cost sheet has a shape to argue with rather
 * than a page of zeroes, and the moment a real rate is typed it takes over.
 */
function seedRateStarters(): void {
  const existing = one<{ c: number }>('SELECT COUNT(*) AS c FROM rate_memory')!.c;
  if (existing > 0) return;
  const starters: [string, Record<string, string>, number, string][] = [
    ['cmt', { operation: 'Cutting', uom: 'per_pc' }, 3, 'pc'],
    ['cmt', { operation: 'Sewing', uom: 'per_sam_min' }, 1.6, 'min'],
    ['cmt', { operation: 'Fusing', uom: 'per_pc' }, 1.5, 'pc'],
    ['cmt', { operation: 'Ironing', uom: 'per_pc' }, 2.5, 'pc'],
    ['cmt', { operation: 'Checking', uom: 'per_pc' }, 2, 'pc'],
    ['cmt', { operation: 'Packing', uom: 'per_pc' }, 2.5, 'pc'],
    ['overhead', { category: 'Sampling', uom: 'per_order' }, 3000, 'order'],
    ['overhead', { category: 'Lab Test', uom: 'per_order' }, 4500, 'order'],
    ['overhead', { category: 'Documentation', uom: 'per_order' }, 1500, 'order'],
    ['overhead', { category: 'Transportation', uom: 'per_order' }, 6000, 'order'],
    ['overhead', { category: 'Factory Overhead', uom: 'pct_of_cost' }, 5, '%'],
  ];
  tx(() => {
    for (const [kind, ctx, rate] of starters) {
      run(
        `INSERT OR IGNORE INTO rate_memory (kind, operation, category, uom, rate, use_count, last_order_no)
         VALUES (?,?,?,?,?,0,?)`,
        [kind, ctx.operation ?? '', ctx.category ?? '', ctx.uom ?? '', rate, PLACEHOLDER_ORDER],
      );
    }
  });
  log('  rates: starting points added — flagged everywhere they are offered, and');
  log('         no longer flagged once somebody uses them on a real order');
}

// ------------------------------------------------------------------------ run
async function main(): Promise<void> {
  console.log('Seeding HUEREX GFES');
  console.log('  database:', env.dbPath);
  migrate(log);

  const workbook = loadWorkbook();
  seedRoles();
  seedMasters(workbook);
  seedSettings();
  const password = await seedAdmin();
  if (workbook) importWorkbook(workbook);
  seedRateStarters();

  run(
    `INSERT INTO audit_log (username, action, entity, summary, severity)
     VALUES ('system', 'seed', 'database', 'Database seeded', 'notice')`,
  );

  if (password) {
    console.log('\n  ┌─────────────────────────────────────────────────────┐');
    console.log('  │  First sign-in                                      │');
    console.log('  │    username: admin                                  │');
    console.log(`  │    password: ${password.padEnd(38)}│`);
    console.log('  │  You will be asked to change it straight away.      │');
    console.log('  └─────────────────────────────────────────────────────┘\n');
  }
  console.log('Done.');
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
