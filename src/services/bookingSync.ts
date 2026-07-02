import { Types } from "mongoose";
import { BookingModel } from "../models/Booking";
import { logger } from "../lib/logger";
import type { Transaction } from "./transactionService";

// MongoDB-side reconciliation for payments. This module is the ONLY payment
// module permitted to import a Mongoose model — it is the bridge that "heals"
// Mongo state from the Postgres source of truth. It does NOT touch Postgres.
//
// The relationship: a transaction's booking_ref holds the Mongo Booking _id.
// MongoDB is treated as a derived value for payment status — Postgres decides
// whether the payment succeeded; we patch Mongo to match.

/**
 * Bring the Mongo Booking referenced by a successful transaction in line with
 * the payment outcome. Idempotent: if the booking is already in the target
 * state it is a no-op. Returns true if a write was needed (a heal happened).
 *
 * Throws on DB error so callers can decide (webhook -> DLQ; worker -> log).
 */
export async function syncBookingForTransaction(txn: Transaction): Promise<boolean> {
  const bookingRef = txn.booking_ref;
  if (!bookingRef || !Types.ObjectId.isValid(bookingRef)) {
    // No booking attached (e.g. wallet top-up) — nothing to heal.
    return false;
  }

  const correlationId = txn.provider_order_id ?? txn.idempotency_key ?? txn.id;

  // A captured/successful payment confirms a held booking into active.
  if (txn.status === "success") {
    const result = await BookingModel.updateOne(
      { _id: bookingRef, status: { $in: ["held"] } },
      { $set: { status: "active", customerPaid: Number(txn.amount) } },
    );
    const healed = result.modifiedCount > 0;
    if (healed) {
      logger.info(
        { event: "booking_healed", correlation_id: correlationId, booking_ref: bookingRef, to: "active" },
        "Healed MongoDB booking to active from successful transaction",
      );
    }
    return healed;
  }

  return false;
}
