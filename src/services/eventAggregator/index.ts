import { env } from "../../config/env";
import { ExternalEventModel } from "../../models/ExternalEvent";
import { logger } from "../../lib/logger";
import type { NormalizedExternalEvent } from "./types";
import { fetchTicketmasterEvents } from "./ticketmaster";
import { fetchInsiderEvents } from "./insiderIn";

// Orchestrates the external-source adapters: fetch → normalize → upsert into the
// ExternalEvent cache. Each source is independently feature-flagged inside its
// adapter, so a disabled/unconfigured source simply returns []. Used by the
// syncExternalEvents worker and the manual seed/test path.

export interface SyncStats {
  fetched: number;
  upserted: number;
  deactivated: number;
  errors: number;
}

// Upsert one normalized event keyed by { source, sourceId }, refreshing the TTL.
async function upsertEvent(ev: NormalizedExternalEvent): Promise<void> {
  const expiresAt = new Date(Date.now() + env.externalEventsCacheTtlHours * 3_600_000);
  await ExternalEventModel.updateOne(
    { source: ev.source, sourceId: ev.sourceId },
    {
      $set: {
        sourceUrl: ev.sourceUrl,
        affiliateUrl: ev.affiliateUrl,
        title: ev.title,
        description: ev.description,
        category: ev.category,
        startDate: ev.startDate,
        endDate: ev.endDate,
        venue: ev.venue,
        images: ev.images,
        priceRange: ev.priceRange,
        fetchedAt: new Date(),
        expiresAt,
        isActive: true,
      },
    },
    { upsert: true },
  );
}

// Run one full sync cycle across all enabled sources and configured cities.
export async function syncExternalEvents(): Promise<SyncStats> {
  const stats: SyncStats = { fetched: 0, upserted: 0, deactivated: 0, errors: 0 };
  const cities = env.externalEventsSyncCities;

  for (const city of cities) {
    const sources: Array<Promise<NormalizedExternalEvent[]>> = [
      fetchTicketmasterEvents(city),
      fetchInsiderEvents(city),
    ];
    const results = await Promise.allSettled(sources);
    for (const r of results) {
      if (r.status === "rejected") {
        stats.errors += 1;
        continue;
      }
      for (const ev of r.value) {
        stats.fetched += 1;
        try {
          await upsertEvent(ev);
          stats.upserted += 1;
        } catch (err) {
          stats.errors += 1;
          logger.warn(
            { event: "external_event_upsert_failed", source: ev.source, sourceId: ev.sourceId, error: err instanceof Error ? err.message : String(err) },
            "Failed to upsert external event",
          );
        }
      }
    }
  }

  // Mark events whose end (or start) is in the past as inactive so they drop out
  // of public listings even before the TTL removes them.
  const now = new Date();
  const deactivated = await ExternalEventModel.updateMany(
    { isActive: true, $or: [{ endDate: { $lt: now } }, { endDate: null, startDate: { $lt: now } }] },
    { $set: { isActive: false } },
  );
  stats.deactivated = deactivated.modifiedCount ?? 0;

  return stats;
}
