import mongoose, { Types } from "mongoose";
import { WalletModel, LedgerEntryModel, type LedgerEntryDoc, type WalletDoc } from "../models/Wallet";
import { BookingModel } from "../models/Booking";
import { HttpError } from "../middleware/error";

// Transactional wallet operations. Every balance movement:
//   1. conditionally $inc's the wallet (debits require balance >= amount, so
//      the balance can never go negative — even under concurrent requests the
//      losing writer simply matches no document),
//   2. appends exactly one immutable LedgerEntry with the resulting balance,
// both inside one Mongo transaction so ledger ⇄ balance never drift.

export class InsufficientWalletBalanceError extends HttpError {
  constructor(available: number, required: number) {
    super(
      402,
      `Insufficient wallet balance: ₹${available} available, ₹${required} required. Please top up your wallet.`,
    );
    this.name = "InsufficientWalletBalanceError";
  }
}

/** Lazily creates the agent's wallet on first touch (opening balance 0). */
export async function getOrCreateWallet(agentId: string | Types.ObjectId): Promise<WalletDoc> {
  const id = new Types.ObjectId(agentId);
  const existing = await WalletModel.findOne({ agentId: id });
  if (existing) return existing;
  try {
    return await WalletModel.create({ agentId: id, balance: 0, currency: "INR" });
  } catch (e) {
    // Concurrent first-touch: the unique agentId index makes one creator win.
    const again = await WalletModel.findOne({ agentId: id });
    if (again) return again;
    throw e;
  }
}

type MovementInput = {
  agentId: string | Types.ObjectId;
  type: "TOPUP" | "ADJUSTMENT";
  /** Signed ₹: positive credits, negative debits (ADJUSTMENT may be either). */
  amount: number;
  meta?: Record<string, unknown>;
};

/**
 * Superadmin-recorded movement (TOPUP or ADJUSTMENT). Negative adjustments
 * are refused when they would take the balance below zero.
 */
export async function recordManualMovement(input: MovementInput): Promise<LedgerEntryDoc> {
  const agentId = new Types.ObjectId(input.agentId);
  if (!Number.isFinite(input.amount) || input.amount === 0) {
    throw new HttpError(400, "amount must be a non-zero number");
  }
  if (input.type === "TOPUP" && input.amount < 0) {
    throw new HttpError(400, "TOPUP amount must be positive — use ADJUSTMENT for corrections");
  }

  await getOrCreateWallet(agentId);

  const session = await mongoose.startSession();
  try {
    let entry: LedgerEntryDoc | null = null;
    await session.withTransaction(async () => {
      const filter =
        input.amount < 0
          ? { agentId, balance: { $gte: -input.amount } }
          : { agentId };
      const wallet = await WalletModel.findOneAndUpdate(
        filter,
        { $inc: { balance: input.amount } },
        { new: true, session },
      );
      if (!wallet) {
        const current = await WalletModel.findOne({ agentId }).session(session);
        throw new InsufficientWalletBalanceError(current?.balance ?? 0, -input.amount);
      }
      const [created] = await LedgerEntryModel.create(
        [
          {
            agentId,
            type: input.type,
            amount: input.amount,
            balanceAfter: wallet.balance,
            meta: input.meta,
          },
        ],
        { session },
      );
      entry = created;
    });
    return entry!;
  } finally {
    await session.endSession();
  }
}

/**
 * Debits the agent's net cost when a booking becomes ACTIVE. Fail CLOSED:
 * insufficient balance throws InsufficientWalletBalanceError and the booking
 * transition the caller wraps in `apply` is rolled back with it. The unique
 * {bookingId, BOOKING_DEBIT} index makes a double-debit structurally impossible.
 *
 * @param apply booking-state mutation to commit atomically with the debit
 */
export async function debitForBooking(
  agentId: string | Types.ObjectId,
  bookingId: string | Types.ObjectId,
  amount: number,
  apply: (session: mongoose.ClientSession) => Promise<void>,
  meta?: Record<string, unknown>,
): Promise<void> {
  const aid = new Types.ObjectId(agentId);
  const bid = new Types.ObjectId(bookingId);
  if (!Number.isFinite(amount) || amount < 0) throw new HttpError(400, "Invalid debit amount");

  await getOrCreateWallet(aid);

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const wallet = await WalletModel.findOneAndUpdate(
        { agentId: aid, balance: { $gte: amount } },
        { $inc: { balance: -amount } },
        { new: true, session },
      );
      if (!wallet) {
        const current = await WalletModel.findOne({ agentId: aid }).session(session);
        throw new InsufficientWalletBalanceError(current?.balance ?? 0, amount);
      }
      await LedgerEntryModel.create(
        [
          {
            agentId: aid,
            bookingId: bid,
            type: "BOOKING_DEBIT",
            amount: -amount,
            balanceAfter: wallet.balance,
            meta,
          },
        ],
        { session },
      );
      await apply(session);
    });
  } finally {
    await session.endSession();
  }
}

/**
 * Reverses a booking's debit on cancellation — a NEW crediting entry, never a
 * mutation. No-op (returns false) when the booking was never debited; the
 * unique {bookingId, REFUND} index blocks a second refund.
 */
export async function refundForBooking(
  agentId: string | Types.ObjectId,
  bookingId: string | Types.ObjectId,
  apply: (session: mongoose.ClientSession) => Promise<void>,
  meta?: Record<string, unknown>,
): Promise<boolean> {
  const aid = new Types.ObjectId(agentId);
  const bid = new Types.ObjectId(bookingId);

  const debit = await LedgerEntryModel.findOne({ bookingId: bid, type: "BOOKING_DEBIT" });

  const session = await mongoose.startSession();
  try {
    let refunded = false;
    await session.withTransaction(async () => {
      if (debit) {
        const alreadyRefunded = await LedgerEntryModel.findOne({
          bookingId: bid,
          type: "REFUND",
        }).session(session);
        if (!alreadyRefunded) {
          const amount = -debit.amount; // debit.amount is negative → credit back
          const wallet = await WalletModel.findOneAndUpdate(
            { agentId: aid },
            { $inc: { balance: amount } },
            { new: true, session },
          );
          if (!wallet) throw new HttpError(500, "Wallet missing for refund");
          await LedgerEntryModel.create(
            [
              {
                agentId: aid,
                bookingId: bid,
                type: "REFUND",
                amount,
                balanceAfter: wallet.balance,
                meta,
              },
            ],
            { session },
          );
          refunded = true;
        }
      }
      await apply(session);
    });
    return refunded;
  } finally {
    await session.endSession();
  }
}

/** Paginated, tenant-scoped ledger history (newest first). */
export async function listLedger(
  agentId: string | Types.ObjectId,
  page: number,
  pageSize: number,
): Promise<{ items: LedgerEntryDoc[]; total: number; page: number; pageSize: number }> {
  const aid = new Types.ObjectId(agentId);
  const safePage = Math.max(1, Math.floor(page) || 1);
  const safeSize = Math.min(100, Math.max(1, Math.floor(pageSize) || 20));
  const [items, total] = await Promise.all([
    LedgerEntryModel.find({ agentId: aid })
      .sort({ createdAt: -1, _id: -1 })
      .skip((safePage - 1) * safeSize)
      .limit(safeSize),
    LedgerEntryModel.countDocuments({ agentId: aid }),
  ]);
  return { items, total, page: safePage, pageSize: safeSize };
}

/**
 * Earnings summary: the agent's own markup earned per month (subdomain
 * customer bookings carry agentMarkup). Never includes tboFare/platformMarkup.
 */
export async function earningsSummary(
  agentId: string | Types.ObjectId,
  months: number,
): Promise<Array<{ period: string; earnings: number; bookings: number }>> {
  const aid = new Types.ObjectId(agentId);
  const since = new Date();
  since.setMonth(since.getMonth() - Math.min(24, Math.max(1, months)));
  const rows = await BookingModel.aggregate<{ _id: string; earnings: number; bookings: number }>([
    {
      $match: {
        agentId: aid,
        status: { $in: ["active", "completed"] },
        createdAt: { $gte: since },
      },
    },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } },
        earnings: { $sum: { $ifNull: ["$agentMarkup", 0] } },
        bookings: { $sum: 1 },
      },
    },
    { $sort: { _id: -1 } },
  ]);
  return rows.map((r) => ({ period: r._id, earnings: r.earnings, bookings: r.bookings }));
}
