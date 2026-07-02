import { env } from "../config/env";
import { getPool } from "../config/postgres";
import {
  getUnresolvedDLQEvents,
  markDLQResolved,
  incrementDLQRetry,
} from "../services/transactionService";
import { processRazorpayEvent } from "../services/paymentWebhookProcessor";
import { logger } from "../lib/logger";

// DLQ worker — retries webhook payloads whose MongoDB heal failed at receive
// time. Runs every DLQ_WORKER_INTERVAL_MS (default 10m). Stops retrying a row
// after 3 attempts (handled by the < 3 filter in the query).

const MAX_RETRIES = 3;

let timer: NodeJS.Timeout | null = null;
let running = false;

async function runOnce(): Promise<void> {
  if (running) return;
  if (!getPool()) return;
  running = true;
  try {
    const events = await getUnresolvedDLQEvents(MAX_RETRIES);
    let resolved = 0;
    for (const evt of events) {
      try {
        // fromDLQ:true makes the processor rethrow on Mongo failure instead of
        // re-queuing, so we can bump retry_count here rather than duplicate.
        await processRazorpayEvent(evt.payload, null, { fromDLQ: true });
        await markDLQResolved(evt.id);
        resolved += 1;
        logger.info({ event: "dlq_resolved", dlq_id: evt.id }, "DLQ event resolved");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await incrementDLQRetry(evt.id, message);
        logger.warn(
          { event: "dlq_retry_failed", dlq_id: evt.id, retry_count: evt.retry_count + 1, error: message },
          "DLQ event retry failed — incremented retry_count",
        );
      }
    }
    if (resolved > 0) {
      logger.info({ event: "dlq_cycle_done", resolved, scanned: events.length }, "DLQ cycle complete");
    }
  } catch (err) {
    logger.warn(
      { event: "dlq_cycle_failed", error: err instanceof Error ? err.message : String(err) },
      "DLQ cycle failed — will retry next tick",
    );
  } finally {
    running = false;
  }
}

export function startDLQWorker(): void {
  if (timer) return;
  timer = setInterval(() => void runOnce(), env.dlqWorkerIntervalMs);
  timer.unref?.();
  logger.info({ event: "dlq_worker_started", intervalMs: env.dlqWorkerIntervalMs }, "DLQ worker started");
}
