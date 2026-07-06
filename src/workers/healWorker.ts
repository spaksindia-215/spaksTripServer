import { env } from "../config/env";
import { getPool } from "../config/postgres";
import { getSuccessfulTransactions } from "../services/transactionService";
import { syncBookingForTransaction } from "../services/bookingSync";
import { logger } from "../lib/logger";

// Heal worker — closes the gap when the server crashed after a Postgres write
// but before the MongoDB update. Runs every HEAL_WORKER_INTERVAL_MS (default 5m).
// Idempotent: syncBookingForTransaction is a no-op when Mongo already matches.

let timer: NodeJS.Timeout | null = null;
let running = false;

async function runOnce(): Promise<void> {
  if (running) return; // prevent overlap on slow ticks
  if (!getPool()) return; // Postgres not configured — nothing to heal
  running = true;
  try {
    const txns = await getSuccessfulTransactions();
    let healed = 0;
    for (const txn of txns) {
      try {
        if (await syncBookingForTransaction(txn)) healed += 1;
      } catch (err) {
        logger.warn(
          {
            event: "heal_item_failed",
            correlation_id: txn.provider_order_id ?? txn.id,
            error: err instanceof Error ? err.message : String(err),
          },
          "Heal worker failed for one transaction",
        );
      }
    }
    if (healed > 0) {
      logger.info({ event: "heal_cycle_done", healed, scanned: txns.length }, "Heal cycle complete");
    }
  } catch (err) {
    logger.warn(
      { event: "heal_cycle_failed", error: err instanceof Error ? err.message : String(err) },
      "Heal worker cycle failed (Postgres unavailable?) — will retry next tick",
    );
  } finally {
    running = false;
  }
}

export function startHealWorker(): void {
  if (timer) return;
  timer = setInterval(() => void runOnce(), env.healWorkerIntervalMs);
  timer.unref?.(); // don't keep the event loop alive solely for this timer
  logger.info({ event: "heal_worker_started", intervalMs: env.healWorkerIntervalMs }, "Heal worker started");
}
