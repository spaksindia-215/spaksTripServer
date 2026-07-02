import { PlatformConfigModel, type IPlatformConfig } from "../models/PlatformConfig";

interface CacheEntry {
  doc: IPlatformConfig;
  expiresAt: number;
}

const TTL_MS = 60 * 60 * 1000; // 1 hour
let cache: CacheEntry | null = null;

/**
 * Returns the singleton PlatformConfig, using an in-memory cache (TTL 1 hour).
 * Throws if the document is absent — server startup seed should prevent this.
 */
export async function getPlatformConfig(): Promise<IPlatformConfig> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.doc;

  const doc = await PlatformConfigModel.findOne().lean<IPlatformConfig>();
  if (!doc) {
    throw new Error("PlatformConfig missing — seedPlatformConfig() must run on startup");
  }

  cache = { doc, expiresAt: now + TTL_MS };
  return doc;
}

/** Called by the superadmin save handler after updating markup. */
export function invalidatePlatformConfigCache(): void {
  cache = null;
}
