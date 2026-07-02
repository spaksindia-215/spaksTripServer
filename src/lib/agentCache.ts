import { Types } from "mongoose";
import { UserModel, type IBranding, type MarkupRule, type UserStatus } from "../models/User";

export interface AgentConfig {
  _id:      string;
  slug:     string;
  status:   UserStatus;
  branding?: IBranding;
  markup?:  {
    flights: MarkupRule;
    hotels:  MarkupRule;
    taxi:    MarkupRule;
  };
}

type AgentLean = {
  _id:      Types.ObjectId;
  slug?:    string;
  status:   UserStatus;
  branding?: IBranding;
  markup?:  {
    flights: MarkupRule;
    hotels:  MarkupRule;
    taxi:    MarkupRule;
  };
};

interface CacheEntry {
  config:    AgentConfig;
  expiresAt: number;
}

const TTL_MS = 5 * 60 * 1000; // 5 minutes
const store  = new Map<string, CacheEntry>();

/**
 * Returns the AgentConfig for a slug, or null if not found.
 * Cache TTL: 5 minutes. Invalidate on branding/markup update.
 * Returns agents of any status so middleware can distinguish
 * "not found" (null → redirect) from "suspended" (status check → /suspended).
 */
export async function getAgentConfig(slug: string): Promise<AgentConfig | null> {
  const now    = Date.now();
  const cached = store.get(slug);
  if (cached && cached.expiresAt > now) return cached.config;

  const raw = await UserModel.findOne(
    { slug, role: { $in: ["agent", "b2b_agent"] } },
  )
    .select("slug status branding markup")
    .lean<AgentLean>();

  if (!raw?.slug) {
    store.delete(slug);
    return null;
  }

  const config: AgentConfig = {
    _id:      raw._id.toString(),
    slug:     raw.slug,
    status:   raw.status,
    branding: raw.branding,
    markup:   raw.markup,
  };

  store.set(slug, { config, expiresAt: now + TTL_MS });
  return config;
}

/** Called after agent updates branding or markup so next request re-fetches from DB. */
export function invalidateAgentCache(slug: string): void {
  store.delete(slug);
}
