/**
 * The permission catalogue.
 *
 * A permission key is `<module>.<action>` for a whole screen, or
 * `<module>.<field>.<action>` for one field on it. Nothing in the app may
 * check for a key that is not declared here — `assertKnownPermission` is
 * called at startup so a typo fails loudly instead of quietly granting or
 * denying access.
 *
 * Field-level keys are read by the serializer in rbac/fieldPolicy.ts, which
 * strips values out of API responses. The UI never receives a number the
 * caller is not allowed to see, so hiding it in the browser is decoration,
 * not the control.
 */

export type Action = 'view' | 'create' | 'edit' | 'delete' | 'approve' | 'export';

export interface ModuleDef {
  key: string;
  label: string;
  group: string;
  actions: Action[];
  /** Fields that carry their own permission, on top of the module grant. */
  sensitiveFields?: { key: string; label: string; actions: Action[] }[];
  description?: string;
}

export const MODULES: ModuleDef[] = [
  // ---------------------------------------------------------------- floor
  {
    key: 'dashboard', label: 'Dashboard', group: 'Overview',
    actions: ['view', 'export'],
    description: 'Live factory control screen',
  },
  {
    key: 'orders', label: 'Orders', group: 'Planning',
    actions: ['view', 'create', 'edit', 'delete', 'export'],
    sensitiveFields: [
      { key: 'excess_pct', label: 'Excess %', actions: ['view', 'edit'] },
      { key: 'fx_rate', label: 'FX rate', actions: ['view', 'edit'] },
    ],
  },
  { key: 'route', label: 'Processing Route', group: 'Planning', actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'matrix', label: 'Colour × Size Matrix', group: 'Planning', actions: ['view', 'create', 'edit', 'delete', 'export'] },
  { key: 'approvals', label: 'Buyer Approvals', group: 'Planning', actions: ['view', 'create', 'edit', 'delete', 'approve'] },

  { key: 'fabric', label: 'Fabric Store', group: 'Materials',
    actions: ['view', 'create', 'edit', 'delete', 'export'],
    sensitiveFields: [
      { key: 'rate_per_kg', label: 'Fabric rate ₹/kg', actions: ['view', 'edit'] },
      { key: 'value', label: 'Stock value', actions: ['view'] },
    ],
  },
  { key: 'trims', label: 'Trims', group: 'Materials',
    actions: ['view', 'create', 'edit', 'delete', 'export'],
    sensitiveFields: [{ key: 'rate', label: 'Trim rate', actions: ['view', 'edit'] }],
  },

  { key: 'cutting', label: 'Cutting', group: 'Production', actions: ['view', 'create', 'edit', 'delete', 'export'] },
  { key: 'fusing', label: 'Fusing', group: 'Production', actions: ['view', 'create', 'edit', 'delete', 'export'] },
  { key: 'jobwork', label: 'Job Work', group: 'Production',
    actions: ['view', 'create', 'edit', 'delete', 'export'],
    sensitiveFields: [{ key: 'rate_per_pc', label: 'Job work rate ₹/pc', actions: ['view', 'edit'] }],
  },
  { key: 'sewing', label: 'Sewing', group: 'Production', actions: ['view', 'create', 'edit', 'delete', 'export'] },
  { key: 'checking', label: 'Checking & Finishing', group: 'Production', actions: ['view', 'create', 'edit', 'delete', 'export'] },
  { key: 'packing', label: 'Packing', group: 'Production', actions: ['view', 'create', 'edit', 'delete', 'export'] },
  { key: 'inspection', label: 'Final Inspection', group: 'Production', actions: ['view', 'create', 'edit', 'delete', 'export'] },
  { key: 'shipment', label: 'Shipment', group: 'Production', actions: ['view', 'create', 'edit', 'delete', 'export'] },

  { key: 'wip', label: 'WIP', group: 'Control', actions: ['view', 'export'] },
  { key: 'reconciliation', label: 'Reconciliation', group: 'Control', actions: ['view', 'export'] },
  { key: 'timeline', label: 'Order Timeline', group: 'Control', actions: ['view', 'edit', 'export'] },
  { key: 'alerts', label: 'Alerts', group: 'Control', actions: ['view', 'export'] },
  { key: 'waivers', label: 'Management Approvals', group: 'Control', actions: ['view', 'create', 'edit', 'delete', 'approve'] },
  { key: 'dataaudit', label: 'Data Audit', group: 'Control', actions: ['view', 'export'] },
  { key: 'capacity', label: 'Capacity & Load', group: 'Control', actions: ['view', 'export'] },
  { key: 'sets', label: 'Set Control', group: 'Control', actions: ['view', 'export'],
    description: 'A set only ships when both halves ship' },

  // ------------------------------------------------------------- commercial
  {
    key: 'costing', label: 'Costing', group: 'Commercial',
    actions: ['view', 'create', 'edit', 'delete', 'approve', 'export'],
    description: 'Per-garment cost build-up',
    sensitiveFields: [
      { key: 'fabric', label: 'Fabric cost block', actions: ['view', 'edit'] },
      { key: 'trims', label: 'Trims cost block', actions: ['view', 'edit'] },
      { key: 'jobwork', label: 'Job work / vendor rates', actions: ['view', 'edit'] },
      { key: 'cmt', label: 'CMT / process rates', actions: ['view', 'edit'] },
      { key: 'overheads', label: 'Overheads (sampling, lab, transport…)', actions: ['view', 'edit'] },
      { key: 'total_cost', label: 'Garment cost total', actions: ['view'] },
      { key: 'selling_price', label: 'Selling / buyer price', actions: ['view', 'edit'] },
      { key: 'margin', label: 'Margin', actions: ['view'] },
    ],
  },
  {
    key: 'rates', label: 'Rate Library', group: 'Commercial',
    actions: ['view', 'create', 'edit', 'delete', 'export'],
    description: 'Remembered rates and their history',
  },
  {
    key: 'buyersummary', label: 'Buyer Summary', group: 'Commercial',
    actions: ['view', 'export'],
    sensitiveFields: [
      { key: 'commercials', label: 'Value, cost and margin columns', actions: ['view'] },
    ],
  },

  // ----------------------------------------------------------------- admin
  { key: 'masters', label: 'Master Data', group: 'Administration', actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'buyers', label: 'Buyers', group: 'Administration', actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'vendors', label: 'Vendors', group: 'Administration', actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'users', label: 'Users & Roles', group: 'Administration', actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'audit', label: 'Audit Log', group: 'Administration', actions: ['view', 'export'] },
  { key: 'settings', label: 'Settings & Backup', group: 'Administration', actions: ['view', 'edit'] },
];

export const MODULE_BY_KEY = new Map(MODULES.map((m) => [m.key, m]));

/** Every legal permission key, built once from the catalogue. */
export const ALL_PERMISSIONS: string[] = (() => {
  const keys: string[] = [];
  for (const m of MODULES) {
    for (const a of m.actions) keys.push(`${m.key}.${a}`);
    for (const f of m.sensitiveFields ?? []) {
      for (const a of f.actions) keys.push(`${m.key}.${f.key}.${a}`);
    }
  }
  return keys;
})();

const PERM_SET = new Set(ALL_PERMISSIONS);

export function isKnownPermission(key: string): boolean {
  return PERM_SET.has(key);
}

export function assertKnownPermission(key: string): void {
  if (!PERM_SET.has(key)) {
    throw new Error(`Unknown permission key "${key}" — add it to rbac/permissions.ts`);
  }
}

/** Field keys that a module protects, e.g. costing -> [fabric, margin, …] */
export function sensitiveFieldKeys(moduleKey: string): string[] {
  return (MODULE_BY_KEY.get(moduleKey)?.sensitiveFields ?? []).map((f) => f.key);
}

// ---------------------------------------------------------------------------
// Default roles. These are seeded once; after that they are ordinary editable
// rows, so the factory can invent its own without touching code.
// ---------------------------------------------------------------------------

const floorView = [
  'dashboard.view', 'orders.view', 'route.view', 'matrix.view', 'wip.view',
  'timeline.view', 'alerts.view', 'reconciliation.view', 'dataaudit.view',
  'sets.view',
];

/**
 * "Everything an entry screen offers", expanded from the catalogue rather than
 * assumed. Not every module declares every action — the route editor has no
 * export, buyer approvals have approve instead — and inventing a key that the
 * catalogue does not contain would create a permission nobody can ever hold
 * while quietly breaking the escalation check, which compares a role's grants
 * against the grants of the person editing it.
 */
const allEntry = (mods: string[], actions: Action[] = ['view', 'create', 'edit', 'export']) =>
  mods.flatMap((m) => {
    const def = MODULE_BY_KEY.get(m);
    if (!def) throw new Error(`Unknown module "${m}" in a role definition`);
    return actions.filter((a) => def.actions.includes(a)).map((a) => `${m}.${a}`);
  });

export interface RoleSeed {
  code: string; name: string; rank: number; description: string; permissions: string[];
}

export const DEFAULT_ROLES: RoleSeed[] = [
  {
    code: 'admin', name: 'Administrator', rank: 0,
    description: 'Full access including users, roles, settings and backup.',
    permissions: ALL_PERMISSIONS,
  },
  {
    code: 'management', name: 'Management', rank: 10,
    description: 'Sees every number including cost and margin; approves waivers and cost sheets.',
    permissions: [
      ...ALL_PERMISSIONS.filter((p) => !p.startsWith('users.') && !p.startsWith('settings.')),
      'users.view', 'settings.view',
    ],
  },
  {
    code: 'costing', name: 'Costing & Commercial', rank: 20,
    description: 'Builds cost sheets and owns the rate library. No user administration.',
    permissions: [
      ...floorView, 'buyersummary.view', 'buyersummary.export', 'buyersummary.commercials.view',
      ...allEntry(['costing', 'rates']),
      // Owning the rate library means being able to tidy it. A rate typed
      // against the wrong vendor is this role's mistake to make and to clear
      // up, and forgetting one changes no sheet that has already been built.
      'costing.delete', 'rates.delete',
      ...MODULES.find((m) => m.key === 'costing')!.sensitiveFields!.flatMap(
        (f) => f.actions.map((a) => `costing.${f.key}.${a}`),
      ),
      'fabric.view', 'fabric.rate_per_kg.view', 'fabric.value.view',
      'trims.view', 'trims.rate.view',
      'jobwork.view', 'jobwork.rate_per_pc.view',
      'buyers.view', 'vendors.view', 'masters.view', 'masters.create',
      'orders.excess_pct.view',
    ],
  },
  {
    code: 'merchandiser', name: 'Merchandiser', rank: 30,
    description: 'Runs the order book and buyer approvals. Sees no cost or margin.',
    permissions: [
      ...floorView, 'dashboard.export',
      ...allEntry(['orders', 'route', 'matrix', 'approvals', 'trims', 'shipment']),
      'approvals.approve', 'orders.excess_pct.view',
      'buyersummary.view', 'buyersummary.export',
      'jobwork.view', 'fabric.view', 'inspection.view', 'packing.view',
      'buyers.view', 'vendors.view', 'masters.view', 'masters.create',
      'timeline.edit', 'capacity.view',
    ],
  },
  {
    code: 'planner', name: 'Planner', rank: 35,
    description: 'Route, capacity and the production plan. No commercial data.',
    permissions: [
      ...floorView, 'dashboard.export', 'capacity.view', 'capacity.export',
      ...allEntry(['route', 'matrix']),
      'orders.view', 'orders.edit',
      'cutting.view', 'sewing.view', 'jobwork.view', 'fusing.view',
      'checking.view', 'packing.view', 'shipment.view', 'inspection.view',
      'waivers.view', 'waivers.create', 'masters.view', 'masters.create',
      'timeline.edit',
    ],
  },
  {
    code: 'production', name: 'Production / Floor', rank: 50,
    description: 'Logs what happened on the floor. Cannot see any rate.',
    permissions: [
      ...floorView,
      ...allEntry(['cutting', 'fusing', 'sewing', 'checking', 'packing']),
      'jobwork.view', 'jobwork.create', 'jobwork.edit',
      'masters.view', 'masters.create',
    ],
  },
  {
    code: 'store', name: 'Store / Materials', rank: 55,
    description: 'Fabric and trim movements and the store balance.',
    permissions: [
      ...floorView,
      ...allEntry(['fabric', 'trims']),
      'fabric.delete', 'trims.delete',
      'cutting.view', 'jobwork.view', 'packing.view',
      'masters.view', 'masters.create',
    ],
  },
  {
    code: 'qc', name: 'Quality', rank: 60,
    description: 'Checking, rework and final inspection.',
    permissions: [
      ...floorView,
      ...allEntry(['checking', 'inspection']),
      'packing.view', 'sewing.view', 'cutting.view',
      'masters.view', 'masters.create',
    ],
  },
  {
    code: 'viewer', name: 'Read Only', rank: 90,
    description: 'Can look at production progress. No entry, no rates.',
    permissions: [
      ...floorView, 'cutting.view', 'sewing.view', 'checking.view',
      'packing.view', 'shipment.view', 'inspection.view', 'fusing.view',
      'jobwork.view', 'fabric.view', 'trims.view', 'approvals.view', 'capacity.view',
    ],
  },
];

// A role that grants a permission the catalogue does not declare is a typo,
// and a silent one: the grant can never match a check, and it makes the
// no-escalation rule refuse edits by people who legitimately hold everything.
// Caught here, at import, rather than the first time somebody edits a user.
for (const role of DEFAULT_ROLES) {
  for (const perm of role.permissions) {
    if (!PERM_SET.has(perm)) {
      throw new Error(`Role "${role.code}" grants unknown permission "${perm}"`);
    }
  }
}
