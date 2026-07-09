import { Schema, model, Types, HydratedDocument } from "mongoose";

// Pre-funded agent wallet + append-only settlement ledger.
//
// Model: the agent tops up in advance (superadmin records the TOPUP); each
// agent-portal booking that becomes ACTIVE debits the agent's net cost from
// the wallet; cancelling a debited booking credits it back (REFUND). The
// customer-paid Razorpay checkout on subdomains is a separate flow and does
// NOT touch the wallet.
//
// The LEDGER is the audit trail; the WALLET's `balance` is the enforcement
// point (atomic conditional $inc — a debit only succeeds when balance covers
// it, so the balance can never go negative even under concurrent bookings).
// Every balance movement writes exactly one ledger entry inside the same
// Mongo transaction, so ledger ⇄ balance can never drift.

export interface IWallet {
  agentId: Types.ObjectId;
  balance: number; // ₹ — never negative (enforced by conditional debit + min:0)
  currency: string;
  createdAt: Date;
  updatedAt: Date;
}

const walletSchema = new Schema<IWallet>(
  {
    agentId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    balance: { type: Number, required: true, min: 0, default: 0 },
    currency: { type: String, required: true, default: "INR", trim: true },
  },
  { timestamps: true },
);

export type WalletDoc = HydratedDocument<IWallet>;
export const WalletModel = model<IWallet>("Wallet", walletSchema);

// ── Ledger ────────────────────────────────────────────────────────────────────

export const LEDGER_ENTRY_TYPES = [
  "TOPUP", // superadmin records agent's deposit           (+)
  "BOOKING_DEBIT", // active booking consumes the net cost (−)
  "REFUND", // cancelled booking reverses its debit        (+)
  "ADJUSTMENT", // superadmin correction, either sign — corrections are NEW
  //              entries; existing entries are never edited or deleted
  "CUSTOMER_CREDIT", // reserved for a future customer-pays-agent flow; unused
] as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];

export interface ILedgerEntry {
  agentId: Types.ObjectId;
  bookingId?: Types.ObjectId;
  type: LedgerEntryType;
  /** Signed ₹ amount: positive credits the wallet, negative debits it. */
  amount: number;
  /** Wallet balance immediately after this entry was applied. */
  balanceAfter: number;
  /** Free-form audit context (superadmin note, pnr, actor, …). */
  meta?: Record<string, unknown>;
  createdAt: Date;
}

const ledgerEntrySchema = new Schema<ILedgerEntry>(
  {
    agentId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    bookingId: { type: Schema.Types.ObjectId, ref: "Booking" },
    type: { type: String, enum: LEDGER_ENTRY_TYPES, required: true },
    amount: { type: Number, required: true },
    balanceAfter: { type: Number, required: true, min: 0 },
    meta: { type: Schema.Types.Mixed },
  },
  // Append-only: no updatedAt because entries are immutable once written.
  { timestamps: { createdAt: true, updatedAt: false } },
);

ledgerEntrySchema.index({ agentId: 1, createdAt: -1 });
// Idempotency at the storage layer: a booking can be debited at most once and
// refunded at most once, even if two requests race past the service checks.
ledgerEntrySchema.index(
  { bookingId: 1, type: 1 },
  { unique: true, partialFilterExpression: { type: { $in: ["BOOKING_DEBIT", "REFUND"] } } },
);

// Immutability guards — the ledger is append-only; corrections are new
// ADJUSTMENT entries. These hooks make accidental mutation a hard error.
const IMMUTABLE = "LedgerEntry is append-only — write an ADJUSTMENT instead of editing history";
for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace"] as const) {
  ledgerEntrySchema.pre(op, function (next) {
    next(new Error(IMMUTABLE));
  });
}
for (const op of ["deleteOne", "deleteMany", "findOneAndDelete"] as const) {
  ledgerEntrySchema.pre(op, function (next) {
    next(new Error(IMMUTABLE));
  });
}

ledgerEntrySchema.set("toJSON", {
  transform: (_doc, ret) => {
    const out = ret as unknown as Record<string, unknown>;
    out.id = String(out._id);
    delete out._id;
    delete out.__v;
    return out;
  },
});

export type LedgerEntryDoc = HydratedDocument<ILedgerEntry>;
export const LedgerEntryModel = model<ILedgerEntry>("LedgerEntry", ledgerEntrySchema);
