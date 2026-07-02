/**
 * One-time backfill: copy existing MongoDB Booking documents into the Postgres
 * `transactions` table. Run MANUALLY, never at startup:
 *
 *   cd server && npx tsx --env-file=.env src/scripts/migrateTransactions.ts
 *
 * - Safe to re-run: each booking maps to a deterministic synthetic
 *   provider_order_id ("migrated_<bookingId>"), and inserts use
 *   ON CONFLICT (provider_order_id) DO NOTHING, so duplicates are skipped.
 * - Does NOT delete any MongoDB data — manual cleanup after verification.
 *
 * This is the ONLY payment-side script permitted to read a Mongoose model.
 */
import mongoose from "mongoose";
import { env } from "../config/env";
import { query, getPool } from "../config/postgres";
import { BookingModel } from "../models/Booking";
import { logger } from "../lib/logger";

// Map a Mongo booking status to the Postgres transaction vocabulary.
function mapStatus(bookingStatus: string): string {
  switch (bookingStatus) {
    case "active":
    case "completed":
      return "success";
    case "cancelled":
      return "failed";
    default:
      return "pending"; // held
  }
}

async function main(): Promise<void> {
  if (!getPool()) {
    throw new Error("DATABASE_URL is not set — cannot migrate without PostgreSQL");
  }

  mongoose.set("strictQuery", true);
  await mongoose.connect(env.mongoUri);
  logger.info({ event: "migrate_start" }, "Connected to MongoDB — starting transaction backfill");

  const bookings = await BookingModel.find({}).lean();
  let migrated = 0;
  let skipped = 0;

  for (const b of bookings) {
    const bookingId = String(b._id);
    const syntheticOrderId = `migrated_${bookingId}`;
    const userId = String(b.ownerId);
    const amount = Number(b.customerPaid ?? b.amount ?? 0);
    const status = mapStatus(String(b.status));

    try {
      const res = await query(
        `INSERT INTO transactions
           (user_id, amount, currency, status, provider, provider_order_id,
            booking_ref, resource_type, resource_id, metadata, created_at)
         VALUES ($1, $2, $3, $4, 'legacy', $5, $6, $7, $8, $9, $10)
         ON CONFLICT (provider_order_id) DO NOTHING`,
        [
          userId,
          amount,
          b.currency ?? "INR",
          status,
          syntheticOrderId,
          bookingId,
          "Booking",
          bookingId,
          JSON.stringify({ productType: b.productType, pnr: b.pnr ?? null, source: "migrateTransactions" }),
          b.createdAt ?? new Date(),
        ],
      );
      if (res.rowCount && res.rowCount > 0) migrated += 1;
      else skipped += 1;
    } catch (err) {
      skipped += 1;
      logger.warn(
        { event: "migrate_item_failed", booking_ref: bookingId, error: err instanceof Error ? err.message : String(err) },
        "Failed to migrate one booking",
      );
    }
  }

  logger.info(
    { event: "migrate_done", found: bookings.length, migrated, skipped },
    `Backfill complete — found ${bookings.length}, migrated ${migrated}, skipped ${skipped}`,
  );

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  logger.error({ event: "migrate_fatal", error: err instanceof Error ? err.message : String(err) }, "Migration failed");
  process.exit(1);
});
