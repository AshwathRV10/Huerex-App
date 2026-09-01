import type { FastifyRequest } from 'fastify';
import { can } from './guard.js';

/**
 * Field-level redaction.
 *
 * The rule the brief asks for is "unauthorized users must have no access to
 * restricted fields, reports, exports, APIs, URLs or database data". So the
 * value never leaves the server: we delete the key and replace it with a
 * marker the UI renders as a lock, rather than sending the number and hiding
 * it with CSS.
 */

export const REDACTED = '__redacted__';

export interface RedactionSpec {
  /** field name on the payload -> permission key that unlocks it */
  [field: string]: string;
}

export function redact<T extends Record<string, unknown>>(
  req: FastifyRequest,
  row: T,
  spec: RedactionSpec,
): T {
  let out: T | null = null;
  for (const [field, perm] of Object.entries(spec)) {
    if (!(field in row)) continue;
    if (can(req, perm)) continue;
    if (!out) out = { ...row };
    delete (out as Record<string, unknown>)[field];
    (out as Record<string, unknown>)[`${field}__locked`] = true;
  }
  return out ?? row;
}

export function redactMany<T extends Record<string, unknown>>(
  req: FastifyRequest,
  rows: T[],
  spec: RedactionSpec,
): T[] {
  const locked = Object.entries(spec).filter(([, perm]) => !can(req, perm));
  if (locked.length === 0) return rows;
  return rows.map((r) => {
    const copy = { ...r } as Record<string, unknown>;
    for (const [field] of locked) {
      if (field in copy) {
        delete copy[field];
        copy[`${field}__locked`] = true;
      }
    }
    return copy as T;
  });
}

/** Drop whole blocks of a cost sheet the caller may not see. */
export function pickVisibleBlocks(req: FastifyRequest, blocks: string[]): Set<string> {
  return new Set(blocks.filter((b) => can(req, `costing.${b}.view`)));
}

export const FABRIC_SPEC: RedactionSpec = {
  rate_per_kg: 'fabric.rate_per_kg.view',
  value_inr: 'fabric.value.view',
  stock_value: 'fabric.value.view',
};

export const TRIM_SPEC: RedactionSpec = { rate: 'trims.rate.view', rate_per_unit: 'trims.rate.view' };

export const JOBWORK_SPEC: RedactionSpec = { rate_per_pc: 'jobwork.rate_per_pc.view' };

export const ORDER_SPEC: RedactionSpec = {
  excess_pct: 'orders.excess_pct.view',
  fx_rate: 'orders.fx_rate.view',
};

export const BUYER_SUMMARY_SPEC: RedactionSpec = {
  order_value: 'buyersummary.commercials.view',
  shipped_value: 'buyersummary.commercials.view',
  total_cost: 'buyersummary.commercials.view',
  margin: 'buyersummary.commercials.view',
  margin_pct: 'buyersummary.commercials.view',
  avg_price: 'buyersummary.commercials.view',
  avg_cost: 'buyersummary.commercials.view',
};
