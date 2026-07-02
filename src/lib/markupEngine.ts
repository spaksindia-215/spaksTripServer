import type { MarkupRule } from "../models/User";

export type { MarkupRule };

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
