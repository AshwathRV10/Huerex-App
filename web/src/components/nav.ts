import { Icon, type IconName } from './Icons';

export interface NavEntry {
  to: string;
  label: string;
  icon: IconName;
  perm: string;
  /** words the command palette matches on, beyond the label */
  keywords?: string;
}

export interface NavGroup { title: string; items: NavEntry[] }

/**
 * The whole application in one list.
 *
 * Grouped the way the factory is organised rather than the way the database
 * is: what management looks at, what the order book needs, what the store
 * holds, what the floor does today, what has to be checked, and what only
 * an administrator touches.
 */
export const NAV: NavGroup[] = [
  {
    title: 'Overview',
    items: [
      { to: '/', label: 'Dashboard', icon: 'Dashboard', perm: 'dashboard.view', keywords: 'home today control' },
      { to: '/alerts', label: 'Alerts', icon: 'Alert', perm: 'alerts.view', keywords: 'problems issues blocked' },
      { to: '/wip', label: 'WIP on floor', icon: 'Layers', perm: 'wip.view', keywords: 'work in progress buckets stuck' },
    ],
  },
  {
    title: 'Order book',
    items: [
      { to: '/orders', label: 'Orders', icon: 'Order', perm: 'orders.view', keywords: 'styles buyers po' },
      { to: '/approvals', label: 'Buyer approvals', icon: 'Shield', perm: 'approvals.view', keywords: 'lab dip fit pp sample' },
      { to: '/timeline', label: 'Order timeline', icon: 'Clock', perm: 'timeline.view', keywords: 'milestones cycle delay' },
      { to: '/buyer-summary', label: 'Buyer summary', icon: 'Book', perm: 'buyersummary.view', keywords: 'buyer book performance' },
    ],
  },
  {
    title: 'Costing',
    items: [
      { to: '/costing', label: 'Cost sheets', icon: 'Rupee', perm: 'costing.view', keywords: 'cost margin price quote garment' },
      { to: '/rates', label: 'Rate library', icon: 'Tag', perm: 'rates.view', keywords: 'rates memory history dyeing knitting' },
    ],
  },
  {
    title: 'Materials',
    items: [
      { to: '/fabric', label: 'Fabric store', icon: 'Fabric', perm: 'fabric.view', keywords: 'kg stock balance receipt issue wastage' },
      { to: '/trims', label: 'Trims', icon: 'Trim', perm: 'trims.view', keywords: 'label tag button carton' },
    ],
  },
  {
    title: 'Production',
    items: [
      { to: '/cutting', label: 'Cutting', icon: 'Scissors', perm: 'cutting.view', keywords: 'cut lay bundle' },
      { to: '/jobwork', label: 'Job work', icon: 'Vendor', perm: 'jobwork.view', keywords: 'print embroidery wash tie dye vendor' },
      { to: '/fusing', label: 'Fusing', icon: 'Layers', perm: 'fusing.view' },
      { to: '/sewing', label: 'Sewing', icon: 'Needle', perm: 'sewing.view', keywords: 'line output efficiency block' },
      { to: '/checking', label: 'Checking', icon: 'Check', perm: 'checking.view', keywords: 'quality dhu alter reject rework' },
      { to: '/packing', label: 'Packing', icon: 'Box', perm: 'packing.view', keywords: 'carton' },
      { to: '/inspection', label: 'Final inspection', icon: 'Shield', perm: 'inspection.view', keywords: 'aql gate' },
      { to: '/shipment', label: 'Shipment', icon: 'Truck', perm: 'shipment.view', keywords: 'dispatch invoice' },
    ],
  },
  {
    title: 'Control',
    items: [
      { to: '/reconciliation', label: 'Reconciliation', icon: 'Balance', perm: 'reconciliation.view', keywords: 'cut shipped rejected identity' },
      { to: '/capacity', label: 'Capacity & load', icon: 'Scale', perm: 'capacity.view', keywords: 'minutes operators lines' },
      { to: '/waivers', label: 'Management approvals', icon: 'Shield', perm: 'waivers.view', keywords: 'waive suppress accept alert' },
      { to: '/data-audit', label: 'Data audit', icon: 'Check', perm: 'dataaudit.view', keywords: 'checks trust clean' },
    ],
  },
  {
    title: 'Administration',
    items: [
      { to: '/masters', label: 'Master data', icon: 'Grid', perm: 'masters.view', keywords: 'lists colours sizes vendors' },
      { to: '/buyers', label: 'Buyers & vendors', icon: 'Users', perm: 'buyers.view', keywords: 'excess billable terms' },
      { to: '/users', label: 'Users & roles', icon: 'Users', perm: 'users.view', keywords: 'permissions rbac access' },
      { to: '/audit', label: 'Audit log', icon: 'Book', perm: 'audit.view', keywords: 'who changed what history' },
      { to: '/settings', label: 'Settings & backup', icon: 'Settings', perm: 'settings.view', keywords: 'thresholds backup restore' },
    ],
  },
];

export const ICONS = Icon;
