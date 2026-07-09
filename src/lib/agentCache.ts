import { Types } from "mongoose";
import { UserModel, type IBranding, type MarkupRule, type UserStatus } from "../models/User";
import { env } from "../config/env";
import { logger } from "./logger";

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
  configVersion?: number;
};

interface CacheEntry {
  config:        AgentConfig;
  version:       number;
  softExpiresAt: number; // trust blindly (zero DB hits) until this point
  hardExpiresAt: number; // absolute ceiling — always refetch fully past this
}

const SOFT_TTL_MS  = env.agentCacheSoftTtlMs;
const HARD_TTL_MS  = env.agentCacheHardTtlMs;
const MAX_ENTRIES  = env.agentCacheMaxEntries;

const store = new Map<string, CacheEntry>();

function remember(slug: string, config: AgentConfig, version: number, now: number): void {
  if (!store.has(slug) && store.size >= MAX_ENTRIES) {
    // Unbounded-growth guard: evict the oldest-inserted entry. Not true LRU,
    // but bounds memory with zero bookkeeping cost on the hot read path —
    // agent count is in the thousands at most, so approximate eviction is fine.
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(slug, {
    config,
    version,
    softExpiresAt: now + SOFT_TTL_MS,
    hardExpiresAt: now + HARD_TTL_MS,
  });
}

async function fetchFresh(slug: string, now: number): Promise<AgentConfig | null> {
  const raw = await UserModel.findOne(
    { slug, role: { $in: ["agent", "b2b_agent"] } },
  )
    .select("slug status branding markup configVersion")
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
  remember(slug, config, raw.configVersion ?? 1, now);
  return config;
}

/**
 * Returns the AgentConfig for a slug, or null if not found.
 *
 * Two-tier TTL bounds cross-instance staleness without a shared cache
 * service (no Redis in this deployment). Within SOFT_TTL every instance
 * trusts its own memory — zero DB hits, the actual scale-safety win. Between
 * SOFT_TTL and HARD_TTL, a cheap single-field version check (`configVersion`,
 * bumped by invalidateAgentCache on every write) decides whether to keep
 * serving the cached config or do a full refetch — so an update made on
 * instance A becomes visible on instance B within SOFT_TTL rather than the
 * full HARD_TTL. Past HARD_TTL a full refetch always happens regardless
 * (same absolute staleness ceiling the old single-TTL cache gave).
 *
 * Returns agents of any status so middleware can distinguish "not found"
 * (null → redirect) from "not active" (status check → /suspended).
 */
export async function getAgentConfig(slug: string): Promise<AgentConfig | null> {
  const now    = Date.now();
  const cached = store.get(slug);

  if (cached && now < cached.softExpiresAt) {
    return cached.config;
  }

  if (cached && now < cached.hardExpiresAt) {
    try {
      const check = await UserModel.findOne({ slug })
        .select("configVersion")
        .lean<{ configVersion?: number }>();
      if (check && (check.configVersion ?? 1) === cached.version) {
        cached.softExpiresAt = now + SOFT_TTL_MS;
        return cached.config;
      }
      // Version bumped elsewhere, or the agent no longer exists — fall
      // through to a full refetch.
    } catch {
      // Fail open: a DB blip during the cheap check must not error the page
      // render — keep serving the last known-good config a bit longer.
      cached.softExpiresAt = now + SOFT_TTL_MS;
      return cached.config;
    }
  }

  return fetchFresh(slug, now);
}

/**
 * Called after an agent's branding/markup/status changes. Clears this
 * instance's own cache immediately AND bumps `configVersion` in Mongo so
 * peer instances (multiple Express processes behind a load balancer, each
 * with their own in-process cache) pick up the change within SOFT_TTL
 * instead of waiting out the full HARD_TTL. The Mongo bump is best-effort —
 * a failure here must never fail the branding/markup/status update it's
 * attached to (this instance is already correct via the local delete;
 * peers self-correct at worst by HARD_TTL).
 */
export async function invalidateAgentCache(slug: string): Promise<void> {
  store.delete(slug);
  try {
    await UserModel.updateOne({ slug }, { $inc: { configVersion: 1 } });
  } catch (err) {
    // Best-effort — see doc comment above. Logged (not silent) because a
    // sustained failure here means peer instances silently drift for up to
    // HARD_TTL after every branding/markup/status change for this agent.
    logger.warn(
      { event: "agent_cache_invalidate_failed", slug, error: err instanceof Error ? err.message : String(err) },
      "Failed to bump configVersion for cache invalidation — this instance is correct, peers may serve stale config until HARD_TTL",
    );
  }
}
