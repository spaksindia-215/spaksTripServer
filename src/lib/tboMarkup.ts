import type { Request } from "express";
import { getAgentConfig } from "./agentCache";
import type { MarkupRule } from "../models/User";

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

export type TwoTierPricing = {
  tboFare: number;
  platformMarkup: number; // always 0 — kept for booking-record schema compatibility
  agentNetRate: number; // == tboFare (no L1)
  agentMarkup: number;
  customerPaid: number;
};

type PricingProduct = "flights" | "hotels" | "taxi";

function applyMarkup(fare: number, rule: MarkupRule): number {
  const raw =
    rule.type === "percent"
      ? Math.round(fare * (1 + rule.value / 100))
      : fare + rule.value;
  if (rule.cap != null && rule.cap > 0) return Math.min(raw, fare + rule.cap);
  return raw;
}

async function getAgentMarkup(
  product: PricingProduct,
  slug: string,
): Promise<MarkupRule | null> {
  try {
    const agent = await getAgentConfig(slug);
    return agent?.markup?.[product] ?? null;
  } catch {
    return null;
  }
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
