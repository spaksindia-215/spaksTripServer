import { env } from "../config/env";
import { syncExternalEvents } from "../services/eventAggregator";
import { logger } from "../lib/logger";

// External-events sync worker. Follows the same setInterval pattern as
// healWorker/reconciliationWorker (no new cron dependency). Gated behind
// EXTERNAL_EVENTS_SYNC_ENABLED — a no-op when off, so existing deployments are
// unaffected. Runs every EXTERNAL_EVENTS_SYNC_INTERVAL_MS (default 6h).

let timer: NodeJS.Timeout | null = null;
let running = false;

async function runOnce(): Promise<void> {
  if (running) return; // prevent overlap on slow ticks
  running = true;
  try {
    const stats = await syncExternalEvents();
    logger.info({ event: "external_events_sync_done", ...stats }, "External events sync complete");
  } catch (err) {
    logger.warn(
      { event: "external_events_sync_failed", error: err instanceof Error ? err.message : String(err) },
      "External events sync cycle failed — will retry next tick",
    );
  } finally {
    running = false;
  }
}

export function startExternalEventsSyncWorker(): void {
  if (!env.externalEventsSyncEnabled) return; // master switch off → never schedule
  if (timer) return;
  // Kick off one cycle shortly after boot, then on the configured interval.
  setTimeout(() => void runOnce(), 30_000).unref?.();
  timer = setInterval(() => void runOnce(), env.externalEventsSyncIntervalMs);
  timer.unref?.();
  logger.info(
    { event: "external_events_sync_worker_started", intervalMs: env.externalEventsSyncIntervalMs, cities: env.externalEventsSyncCities.length },
    "External events sync worker started",
  );
}
