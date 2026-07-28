// How an online order picks the location it ships from (roadmap §1.2, Phase D).
//
// A STRATEGY registry, not a switch. v1 registers `priority` only; `nearest`,
// `most_stock`, `cheapest_shipping`, `manual` and `split` each become a file
// that registers itself here, and checkout never learns their names — it asks
// for the store's configured strategy and takes the ranking.
//
// PURE module: ranking is a function of the candidates and the context, both
// supplied by the caller. Nothing here reads the database.

import type { Plan } from "@/lib/plans";

/** A location that could serve an order, as far as the resolver is concerned. */
export interface FulfilmentCandidate {
  id: string;
  name: string;
  active: boolean;
  /** Does it carry the `online_fulfil` capability? */
  fulfilsOnline: boolean;
  /** Stock at THIS location for every line of the order, keyed
   *  `productId:variantId`. Missing = zero. */
  stock: Map<string, number>;
}

export interface FulfilmentLine {
  key: string;
  quantity: number;
  /** Untracked or backorderable SKUs never block a location. */
  needsStock: boolean;
}

export interface FulfilmentContext {
  candidates: FulfilmentCandidate[];
  lines: FulfilmentLine[];
  /** The merchant's ordering, for strategies that use one. */
  priority: string[];
  skipInactive: boolean;
}

export interface FulfilmentStrategy {
  id: string;
  label: string;
  description: string;
  minPlan?: Plan;
  /** Candidate location ids, best first. The caller takes the first that can
   *  serve the whole order. */
  rank(ctx: FulfilmentContext): string[];
}

/** Can this location serve EVERY line? v1 does not split an order. */
export function canServe(
  candidate: FulfilmentCandidate,
  lines: FulfilmentLine[],
): boolean {
  for (const line of lines) {
    if (!line.needsStock) continue;
    if ((candidate.stock.get(line.key) ?? 0) < line.quantity) return false;
  }
  return true;
}

/** Locations that are allowed to fulfil at all, before any ordering. */
export function eligible(ctx: FulfilmentContext): FulfilmentCandidate[] {
  return ctx.candidates.filter(
    (c) => c.fulfilsOnline && (!ctx.skipInactive || c.active),
  );
}

const priority: FulfilmentStrategy = {
  id: "priority",
  label: "Priority order",
  description:
    "Try locations in the order you set. The first with stock fulfils the order.",
  rank(ctx) {
    const ok = eligible(ctx);
    const byId = new Map(ok.map((c) => [c.id, c]));
    // The merchant's order first...
    const ranked = ctx.priority.filter((id) => byId.has(id));
    // ...then anything eligible they never placed, so a location added after
    // the ordering was saved is still usable rather than silently ignored.
    for (const c of ok) if (!ranked.includes(c.id)) ranked.push(c.id);
    return ranked;
  },
};

const REGISTRY: Record<string, FulfilmentStrategy> = {
  [priority.id]: priority,
};

export const FULFILMENT_STRATEGIES = Object.values(REGISTRY);
export const DEFAULT_STRATEGY_ID = priority.id;

export function getStrategy(id: string | null | undefined): FulfilmentStrategy {
  // An unknown id (a strategy removed, or a typo in the DB) must not stop a
  // store selling — fall back to the one that always works.
  return REGISTRY[id ?? ""] ?? priority;
}

/**
 * The location an order should ship from, or null when none can serve it whole.
 *
 * Null is NOT an error: the caller decides whether to fail the order or fall
 * back. v1 never splits an order across locations (roadmap Phase J).
 */
export function pickFulfilmentLocation(
  ctx: FulfilmentContext,
  strategyId?: string | null,
): string | null {
  const strategy = getStrategy(strategyId);
  const byId = new Map(ctx.candidates.map((c) => [c.id, c]));
  for (const id of strategy.rank(ctx)) {
    const candidate = byId.get(id);
    if (candidate && canServe(candidate, ctx.lines)) return id;
  }
  return null;
}
