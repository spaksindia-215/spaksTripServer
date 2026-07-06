import mongoose from "mongoose";
import type { Db } from "mongodb";

// The flight/hotel payment idempotency records are stored as raw MongoDB
// collections (flight_payment_records, hotel_payment_records) — the same shape the
// Next.js app used. Rather than port client/src/lib/mongodb.ts (which spins up its
// own MongoClient), we reuse the already-connected mongoose connection's native
// driver handle so there is a single connection pool for the whole server.

export function getPaymentDb(): Db {
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error("MongoDB connection is not ready (mongoose.connection.db is undefined)");
  }
  return db as unknown as Db;
}
