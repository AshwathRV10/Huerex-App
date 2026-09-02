/**
 * Formatting.
 *
 * Two rules run through all of it. Numbers a person has to compare are shown
 * with the same number of decimals in every row, and a number nobody is
 * allowed to see comes back from the server as `undefined` with a matching
 * `<field>__locked` flag — so `isLocked` is how a screen tells "no access"
 * apart from "genuinely zero".
 */

const inr0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const inr2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const plain = new Intl.NumberFormat('en-IN');

export function num(v: unknown, decimals = 0): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return decimals === 0 ? inr0.format(n) : n.toFixed(decimals);
}

export function qty(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return plain.format(Math.round(n));
}

/** Money, always in rupees, always with the symbol attached to the number. */
export function money(v: unknown, decimals: 0 | 2 = 2): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const abs = decimals === 0 ? inr0.format(Math.abs(n)) : inr2.format(Math.abs(n));
  return `${n < 0 ? '−' : ''}₹${abs}`;
}

/** For headline figures where ₹12,45,600 is noise and ₹12.5 L is the point. */
export function compactMoney(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  if (a >= 1e7) return `${sign}₹${(a / 1e7).toFixed(a >= 1e8 ? 0 : 2)} Cr`;
  if (a >= 1e5) return `${sign}₹${(a / 1e5).toFixed(a >= 1e6 ? 0 : 2)} L`;
  if (a >= 1000) return `${sign}₹${inr0.format(Math.round(a))}`;
  return `${sign}₹${a.toFixed(0)}`;
}

export function pct(v: unknown, decimals = 1): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `${n.toFixed(decimals)}%`;
}

export function kg(v: unknown, decimals = 2): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `${n.toFixed(decimals)} kg`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function date(v: unknown): string {
  if (!v) return '—';
  const s = String(v).slice(0, 10);
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return '—';
  return `${String(d).padStart(2, '0')} ${MONTHS[m - 1]}`;
}

export function longDate(v: unknown): string {
  if (!v) return '—';
  const s = String(v).slice(0, 10);
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return '—';
  return `${String(d).padStart(2, '0')} ${MONTHS[m - 1]} ${y}`;
}

export function dateTime(v: unknown): string {
  if (!v) return '—';
  const s = String(v).replace(' ', 'T');
  const dt = new Date(s.endsWith('Z') || s.includes('+') ? s : `${s}Z`);
  if (Number.isNaN(dt.getTime())) return String(v);
  return `${String(dt.getDate()).padStart(2, '0')} ${MONTHS[dt.getMonth()]} ${dt.getFullYear()}, ${
    String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
}

export function ago(v: unknown): string {
  if (!v) return '—';
  const s = String(v).replace(' ', 'T');
  const then = new Date(s.endsWith('Z') || s.includes('+') ? s : `${s}Z`).getTime();
  if (!Number.isFinite(then)) return '—';
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.round(days / 30);
  if (months < 18) return `${months} month${months === 1 ? '' : 's'} ago`;
  return `${Math.round(months / 12)} yr ago`;
}

export function days(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `${n} day${Math.abs(n) === 1 ? '' : 's'}`;
}

export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function initials(name: string): string {
  return name.split(/[\s.]+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
}

/** True when the server withheld this field because of permissions. */
export function isLocked(row: object | undefined | null, field: string): boolean {
  return Boolean((row as Record<string, unknown> | undefined)?.[`${field}__locked`]);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
