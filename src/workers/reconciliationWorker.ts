import { env } from "../config/env";
import { getPool } from "../config/postgres";
import {
  getStalePendingTransactions,
  updateTransactionStatus,
  logEvent,
  type Transaction,
} from "../services/transactionService";
import { syncBookingForTransaction } from "../services/bookingSync";
import { fetchPaymentCircuit, fetchPaymentsForOrderCircuit } from "../lib/circuitBreaker";
import { logger } from "../lib/logger";

// Reconciliation worker — the fallback for silent webhook failures (e.g. user's
// phone died after authorising). Runs every RECONCILIATION_WORKER_INTERVAL_MS
// (default 60m). For each transaction stuck in `pending` > 15 min it asks
// Razorpay for ground truth and heals Postgres + Mongo to match.

const STALE_MINUTES = 15;

// Map a Razorpay payment status to our transaction status vocabulary.
function mapRazorpayStatus(rpStatus: string): string | null {
  switch (rpStatus) {
    case "captured":
      return "success";
    case "failed":
      return "failed";
    case "authorized":
      return "authorized";
    default:
      return null; // created/refunded etc. — leave pending for now
  }
}

async function resolveStatus(txn: Transaction): Promise<{ status: string; paymentId: string | null } | null> {
  // Prefer the known payment id; otherwise discover it from the order.
  if (txn.provider_payment_id) {
    const payment = await fetchPaymentCircuit.fire(txn.provider_payment_id);
    const mapped = mapRazorpayStatus(payment.status);
    return mapped ? { status: mapped, paymentId: payment.id } : null;
  }
  if (txn.provider_order_id) {
    const payments = await fetchPaymentsForOrderCircuit.fire(txn.provider_order_id);
    const captured = payments.find((p) => p.status === "captured");
    if (captured) return { status: "success", paymentId: captured.id };
    if (payments.length > 0 && payments.every((p) => p.status === "failed")) {
      return { status: "failed", paymentId: payments[0].id };
    }
  }
  return null;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

async function runOnce(): Promise<void> {
  if (running) return;
  if (!getPool()) return;
  running = true;
  try {
    const stale = await getStalePendingTransactions(STALE_MINUTES);
    let reconciled = 0;
    for (const txn of stale) {
      const correlationId = txn.provider_order_id ?? txn.id;
      try {
        const resolved = await resolveStatus(txn);
        if (!resolved) continue;
        const updated = await updateTransactionStatus(
          txn.provider_order_id ?? "",
          resolved.paymentId,
          txn.provider_signature,
          resolved.status,
        );
        await logEvent(txn.id, "reconciled", {
          correlation_id: correlationId,
          status: resolved.status,
          source: "reconciliation_worker",
        });
        if (updated && resolved.status === "success") {
          await syncBookingForTransaction(updated);
        }
        reconciled += 1;
        logger.info(
          { event: "txn_reconciled", correlation_id: correlationId, status: resolved.status },
          "Reconciled stale pending transaction",
        );
      } catch (err) {
        // Includes the circuit-open fallback message — log and move on.
        logger.warn(
          { event: "reconcile_item_failed", correlation_id: correlationId, error: err instanceof Error ? err.message : String(err) },
          "Reconciliation failed for one transaction",
        );
      }
    }
    if (reconciled > 0) {
      logger.info({ event: "reconcile_cycle_done", reconciled, scanned: stale.length }, "Reconciliation cycle complete");
    }
  } catch (err) {
    logger.warn(
      { event: "reconcile_cycle_failed", error: err instanceof Error ? err.message : String(err) },
      "Reconciliation cycle failed — will retry next tick",
    );
  } finally {
    running = false;
  }
}

export function startReconciliationWorker(): void {
  if (timer) return;
  timer = setInterval(() => void runOnce(), env.reconciliationWorkerIntervalMs);
  timer.unref?.();
  logger.info(
    { event: "reconciliation_worker_started", intervalMs: env.reconciliationWorkerIntervalMs },
    "Reconciliation worker started",
  );
}
