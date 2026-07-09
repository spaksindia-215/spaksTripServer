// Single shared pricing module — the ONLY place markup arithmetic is defined.
// Consumed by both runtimes:
//   server/src/lib/tboMarkup.ts            (Express)
//   client/src/lib/server/agentMarkup.ts   (Next.js, imports this file directly)
// Deliberately zero I/O and zero framework imports (no mongoose, no express,
// no next) so it is safe to import from either app without pulling in the
// other's runtime dependencies. `MarkupRule` is redeclared locally rather than
// imported from ../models/User (a Mongoose model file) for the same reason —
// it must stay structurally identical to that type; a future change to one
// should be mirrored in the other.
//
// Rounding policy: percent markups round to the nearest whole rupee at each
// layer (INR has no display subunit in this product); flat markups and caps
// are applied as configured with no additional rounding, since flat values are
// entered as whole rupees in the agent/superadmin UI. This matches the
// pre-consolidation behavior of both duplicated copies exactly (see golden
// tests in markupEngine.test.ts) — this refactor changes no pricing output.

export type MarkupType = "percent" | "flat";

export interface MarkupRule {
  type: MarkupType;
  value: number;
  cap?: number;
}

export interface TwoTierPricing {
  tboFare:        number; // TBO raw fare — never sent to any browser
  platformMarkup: number; // platform cut (₹) — never shown to agent
  agentNetRate:   number; // tboFare + platformMarkup — agent's "base price"
  agentMarkup:    number; // agent's cut (₹) — not shown to customer
  customerPaid:   number; // agentNetRate + agentMarkup — only this reaches browser
}

export function applyTwoTierMarkup(
  tboFare:      number,
  platformRule: MarkupRule,
  agentRule:    MarkupRule,
): TwoTierPricing {
  const agentNetRate = applyMarkup(tboFare, platformRule);
  const customerPaid = applyMarkup(agentNetRate, agentRule);
  return {
    tboFare,
    platformMarkup: agentNetRate - tboFare,
    agentNetRate,
    agentMarkup:    customerPaid - agentNetRate,
    customerPaid,
  };
}

/** Layer 1 only — used when an agent browses their own portal. */
export function applyPlatformMarkup(
  tboFare:      number,
  platformRule: MarkupRule,
): number {
  return applyMarkup(tboFare, platformRule);
}

/**
 * Applies an agent's markup rule to a net fare.
 * Returns the marked-up price the client sees.
 * Net fares must never be forwarded to the client after this call.
 *
 * applyMarkup(4500, {type:'percent',value:2})        === 4590
 * applyMarkup(4500, {type:'flat',value:50})           === 4550
 * applyMarkup(4500, {type:'percent',value:2,cap:50})  === 4550  (cap enforced)
 */
export function applyMarkup(netFare: number, rule: MarkupRule): number {
  const raw =
    rule.type === "percent"
      ? Math.round(netFare * (1 + rule.value / 100))
      : netFare + rule.value;

  if (rule.cap != null && rule.cap > 0) {
    return Math.min(raw, netFare + rule.cap);
  }
  return raw;
}

/** The markup amount in ₹ added on top of the net fare. */
export function markupAmount(netFare: number, markedFare: number): number {
  return markedFare - netFare;
}

/**
 * Thrown by an adapter (tboMarkup.ts / agentMarkup.ts) when a subdomain
 * request's agent markup genuinely could not be resolved (cache + DB both
 * failed, or an agent confirmed active moments ago by the routing layer has
 * vanished from this lookup) — as opposed to "agent found, no markup
 * configured for this product" (a valid, legitimate `null`).
 *
 * Callers on a final-price-quote path (fare-quote, hotel detail) MUST NOT
 * catch this and silently fall back to the raw fare — that undercharges the
 * customer relative to what the agent configured (fail CLOSED: surface an
 * explicit error). Search/listing paths may explicitly catch it and fail
 * OPEN, since no price has been quoted yet. Defined once here (not per
 * adapter) so `instanceof` checks work regardless of which adapter threw it.
 */
export class AgentPricingUnavailableError extends Error {
  constructor(slug: string, cause?: unknown) {
    super(`Agent pricing unavailable for slug "${slug}"`);
    this.name = "AgentPricingUnavailableError";
    if (cause !== undefined) this.cause = cause;
  }
}
