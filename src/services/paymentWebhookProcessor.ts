import {
  updateTransactionStatus,
  getTransactionByOrderId,
  logEvent,
  pushToDLQ,
} from "./transactionService";
import { syncBookingForTransaction } from "./bookingSync";
import { logger } from "../lib/logger";

export const WEBHOOK_ENDPOINT = "/api/webhooks/razorpay";

// Events that mean "money captured". order.paid and payment.captured both land
// a payment as successful for our purposes.
const SUCCESS_EVENTS = new Set(["payment.captured", "order.paid"]);
const FAILED_EVENTS = new Set(["payment.failed"]);

interface RazorpayWebhookEvent {
  event?: string;
  payload?: {
    payment?: { entity?: { id?: string; order_id?: string; status?: string } };
    order?: { entity?: { id?: string } };
  };
}

interface ProcessOutcome {
  // The Postgres side succeeded. If false, the webhook must return non-200 so
  // Razorpay retries (Postgres is the source of truth and must not be lost).
  postgresOk: boolean;
  // The Mongo heal succeeded. If false, the payload was parked in the DLQ — the
  // webhook still returns 200 because the source of truth (Postgres) is safe.
  mongoOk: boolean;
}

function extractIds(event: RazorpayWebhookEvent): { orderId: string | null; paymentId: string | null } {
  const paymentEntity = event.payload?.payment?.entity;
  const orderId = paymentEntity?.order_id ?? event.payload?.order?.entity?.id ?? null;
  const paymentId = paymentEntity?.id ?? null;
  return { orderId, paymentId };
}

/**
 * Core Razorpay webhook handling, shared by the live webhook route and the DLQ
 * retry worker so both behave identically.
 *
 * Two independent failure domains:
 *  1. Postgres write — if it throws, we rethrow (caller returns 500, Razorpay retries).
 *  2. Mongo heal — wrapped so it NEVER throws to the caller; on failure the
 *     payload is parked in the DLQ and we still report postgresOk.
 *
 * When `fromDLQ` is true the Mongo failure is rethrown instead of re-queued, so
 * the DLQ worker can increment retry_count rather than create a duplicate row.
 */
export async function processRazorpayEvent(
  event: RazorpayWebhookEvent,
  signature: string | null,
  opts: { fromDLQ?: boolean } = {},
): Promise<ProcessOutcome> {
  const eventType = event.event ?? "unknown";
  const { orderId, paymentId } = extractIds(event);
  const correlationId = orderId ?? paymentId ?? "unknown";

  if (!SUCCESS_EVENTS.has(eventType) && !FAILED_EVENTS.has(eventType)) {
    // Acknowledged but not actionable (e.g. payment.authorized) — record and move on.
    logger.info({ event: "webhook_ignored", correlation_id: correlationId, type: eventType }, "Webhook event ignored");
    return { postgresOk: true, mongoOk: true };
  }

  if (!orderId) {
    logger.warn({ event: "webhook_no_order_id", type: eventType }, "Webhook missing order id");
    return { postgresOk: true, mongoOk: true };
  }

  const targetStatus = SUCCESS_EVENTS.has(eventType) ? "success" : "failed";

  // --- Domain 1: Postgres (source of truth). Throws propagate to caller. ---
  const txn = await updateTransactionStatus(orderId, paymentId, signature, targetStatus);
  await logEvent(txn?.id ?? null, eventType, {
    correlation_id: correlationId,
    order_id: orderId,
    payment_id: paymentId,
    status: targetStatus,
  });
  logger.info(
    { event: "txn_status_updated", correlation_id: correlationId, status: targetStatus },
    "Transaction status updated in Postgres",
  );

  // Only heal Mongo for successful payments with a resolved transaction.
  if (targetStatus !== "success" || !txn) {
    return { postgresOk: true, mongoOk: true };
  }

  // --- Domain 2: Mongo heal. Never throws to the webhook caller. ---
  try {
    await syncBookingForTransaction(txn);
    return { postgresOk: true, mongoOk: true };
  } catch (mongoErr) {
    const message = mongoErr instanceof Error ? mongoErr.message : String(mongoErr);
    logger.warn(
      { event: "mongo_heal_failed", correlation_id: correlationId, error: message },
      "MongoDB heal failed — parking payload for retry",
    );
    if (opts.fromDLQ) {
      // Let the DLQ worker bump retry_count instead of inserting a duplicate.
      throw mongoErr;
    }
    try {
      await pushToDLQ(WEBHOOK_ENDPOINT, event as Record<string, unknown>, message);
    } catch (dlqErr) {
      // Even the DLQ insert failed (Postgres down mid-request). Log loudly; the
      // reconciliation worker is the final safety net via Razorpay ground truth.
      logger.error(
        { event: "dlq_push_failed", correlation_id: correlationId, error: String(dlqErr) },
        "Failed to push to DLQ",
      );
    }
    return { postgresOk: true, mongoOk: false };
  }
}

export { getTransactionByOrderId };
