import type { Request } from "express";
import { getAgentConfig } from "./agentCache";
import {
  applyMarkup,
  AgentPricingUnavailableError,
  type MarkupRule,
  type TwoTierPricing,
} from "./markupEngine";

export type { TwoTierPricing };
export { AgentPricingUnavailableError };

// Server-side port of client/src/lib/server/agentMarkup.ts.
//
// Pricing is single-tier:
//   apex (spakstrip.com)      → TBO fare unchanged
//   subdomain (agent.*)       → TBO fare + agent markup (L2 only)
//
// Difference from the Next.js version: instead of HTTP-fetching
// /api/internal/agent-config, this reads the agent markup directly from the
// in-process cache (getAgentConfig) — no self-call. Agent context arrives via the
// x-agent-slug / x-agent-id headers that proxyToRailway forwards from Vercel.

type PricingProduct = "flights" | "hotels" | "taxi";

async function getAgentMarkup(
  product: PricingProduct,
  slug: string,
): Promise<MarkupRule | null> {
  let agent;
  try {
    agent = await getAgentConfig(slug);
  } catch (err) {
    throw new AgentPricingUnavailableError(slug, err);
  }
  if (!agent) throw new AgentPricingUnavailableError(slug);
  return agent.markup?.[product] ?? null;
}

function agentSlug(req: Request): string | undefined {
  const raw = req.get("x-agent-slug");
  const slug = raw?.trim();
  return slug ? slug : undefined;
}

const passthrough = (fare: number): number => fare;

/**
 * Returns a synchronous pricer for the current request:
 *   - Subdomain (x-agent-slug present): TBO fare + agent markup
 *   - Apex / agent portal / anonymous:  TBO fare unchanged
 *
 * Throws AgentPricingUnavailableError if a subdomain's markup genuinely
 * cannot be resolved — the caller decides whether that's fatal (a final price
 * quote) or safe to catch-and-passthrough (a search/listing result).
 */
export async function buildFarePricer(
  product: PricingProduct,
  req: Request,
): Promise<(fare: number) => number> {
  const slug = agentSlug(req);
  if (!slug) return passthrough;

  const rule = await getAgentMarkup(product, slug);
  return rule ? (fare) => applyMarkup(fare, rule) : passthrough;
}

/**
 * Full pricing breakdown for a subdomain booking record. Returns null when not a
 * subdomain request. platformMarkup is always 0 (settlement schema compatibility).
 * Throws AgentPricingUnavailableError under the same conditions as buildFarePricer.
 */
export async function buildTwoTierPricing(
  tboFare: number,
  product: PricingProduct,
  req: Request,
): Promise<TwoTierPricing | null> {
  const slug = agentSlug(req);
  if (!slug) return null;

  const rule = await getAgentMarkup(product, slug);
  const customerPaid = rule ? applyMarkup(tboFare, rule) : tboFare;

  return {
    tboFare,
    platformMarkup: 0,
    agentNetRate: tboFare,
    agentMarkup: customerPaid - tboFare,
    customerPaid,
  };
}
