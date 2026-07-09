import mongoose, { Types } from "mongoose";
import { connectDb } from "../src/config/db";
import { WalletModel, LedgerEntryModel } from "../src/models/Wallet";
import {
  getOrCreateWallet,
  recordManualMovement,
  debitForBooking,
  refundForBooking,
  InsufficientWalletBalanceError,
} from "../src/services/walletService";

// Phase 3 DoD verification (run from server/: npm run verify:wallet).
// DB-backed (needs a replica-set Mongo for transactions) — not part of `npm test`.
// Uses a synthetic agentId so it never touches real agent data; cleans up after
// itself via the native driver (the mongoose layer correctly refuses to delete
// ledger entries — that's one of the assertions).
//
//   1. Ledger invariant: balanceAfter of entry N == balanceAfter of N-1 + amount,
//      for a generated sequence of 50 random ops.
//   2. Insufficient balance: debit is blocked with the named error; wallet and
//      ledger untouched.
//   3. Concurrency: two simultaneous debits against funds for one → exactly one
//      succeeds, balance never negative (repeated 5×).
//   4. Ledger immutability: mongoose update/delete are hard errors.
//   5. Refund idempotency: cancelling twice produces exactly one REFUND.

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function cleanup(agentId: Types.ObjectId): Promise<void> {
  // Native driver bypasses the append-only mongoose hooks — intentional, this
  // is test cleanup, not application code.
  await WalletModel.collection.deleteMany({ agentId });
  await LedgerEntryModel.collection.deleteMany({ agentId });
}

async function testLedgerInvariant(): Promise<void> {
  const agentId = new Types.ObjectId();
  await getOrCreateWallet(agentId);
  // Opening float so random debits usually have funds.
  await recordManualMovement({ agentId, type: "TOPUP", amount: 100_000, meta: { note: "test float" } });

  let ops = 0;
  const debited: Types.ObjectId[] = [];
  while (ops < 49) {
    const roll = Math.random();
    try {
      if (roll < 0.35) {
        await recordManualMovement({ agentId, type: "TOPUP", amount: 1 + Math.floor(Math.random() * 5000), meta: { note: "t" } });
      } else if (roll < 0.55) {
        const amt = Math.floor(Math.random() * 4000) - 2000;
        if (amt === 0) continue;
        await recordManualMovement({ agentId, type: "ADJUSTMENT", amount: amt, meta: { note: "a" } });
      } else if (roll < 0.85 || debited.length === 0) {
        const bookingId = new Types.ObjectId();
        await debitForBooking(agentId, bookingId, 1 + Math.floor(Math.random() * 3000), async () => {}, {});
        debited.push(bookingId);
      } else {
        const bookingId = debited.pop()!;
        await refundForBooking(agentId, bookingId, async () => {}, {});
      }
      ops += 1;
    } catch (e) {
      if (e instanceof InsufficientWalletBalanceError) continue; // valid outcome, not an op
      throw e;
    }
  }

  const entries = await LedgerEntryModel.find({ agentId }).sort({ createdAt: 1, _id: 1 });
  check("ledger has 50 entries (49 ops + opening topup)", entries.length === 50, `got ${entries.length}`);

  let prev = 0;
  let chainOk = true;
  for (const e of entries) {
    if (Math.abs(prev + e.amount - e.balanceAfter) > 1e-9) {
      chainOk = false;
      check("ledger chain", false, `entry ${String(e._id)}: ${prev} + ${e.amount} != ${e.balanceAfter}`);
      break;
    }
    prev = e.balanceAfter;
  }
  if (chainOk) check("ledger chain: balanceAfter[N] == balanceAfter[N-1] + amount for all 50", true);

  const wallet = await WalletModel.findOne({ agentId });
  check("wallet balance == last balanceAfter", wallet?.balance === prev, `${wallet?.balance} vs ${prev}`);
  check("balance never negative anywhere in the chain", entries.every((e) => e.balanceAfter >= 0));

  await cleanup(agentId);
}

async function testInsufficientBalance(): Promise<void> {
  const agentId = new Types.ObjectId();
  await getOrCreateWallet(agentId);
  await recordManualMovement({ agentId, type: "TOPUP", amount: 100, meta: { note: "t" } });

  let named = false;
  try {
    await debitForBooking(agentId, new Types.ObjectId(), 500, async () => {}, {});
  } catch (e) {
    named = e instanceof InsufficientWalletBalanceError && e.status === 402;
  }
  const wallet = await WalletModel.findOne({ agentId });
  const debits = await LedgerEntryModel.countDocuments({ agentId, type: "BOOKING_DEBIT" });
  check("insufficient balance → named InsufficientWalletBalanceError (402)", named);
  check("wallet unchanged after blocked debit", wallet?.balance === 100, `balance ${wallet?.balance}`);
  check("no ledger entry written for blocked debit", debits === 0, `${debits} debit entries`);

  await cleanup(agentId);
}

async function testConcurrency(round: number): Promise<void> {
  const agentId = new Types.ObjectId();
  await getOrCreateWallet(agentId);
  await recordManualMovement({ agentId, type: "TOPUP", amount: 500, meta: { note: "t" } });

  const results = await Promise.allSettled([
    debitForBooking(agentId, new Types.ObjectId(), 500, async () => {}, {}),
    debitForBooking(agentId, new Types.ObjectId(), 500, async () => {}, {}),
  ]);
  const wins = results.filter((r) => r.status === "fulfilled").length;
  const losses = results.filter(
    (r) => r.status === "rejected" && r.reason instanceof InsufficientWalletBalanceError,
  ).length;
  const wallet = await WalletModel.findOne({ agentId });
  const debits = await LedgerEntryModel.countDocuments({ agentId, type: "BOOKING_DEBIT" });

  check(
    `concurrency round ${round}: exactly one debit wins`,
    wins === 1 && losses === 1 && wallet?.balance === 0 && debits === 1,
    `wins=${wins} losses=${losses} balance=${wallet?.balance} debitEntries=${debits}`,
  );

  await cleanup(agentId);
}

async function testImmutability(): Promise<void> {
  const agentId = new Types.ObjectId();
  await getOrCreateWallet(agentId);
  const entry = await recordManualMovement({ agentId, type: "TOPUP", amount: 10, meta: { note: "t" } });

  let updateBlocked = false;
  try {
    await LedgerEntryModel.updateOne({ _id: entry._id }, { $set: { amount: 999 } });
  } catch {
    updateBlocked = true;
  }
  let deleteBlocked = false;
  try {
    await LedgerEntryModel.deleteOne({ _id: entry._id });
  } catch {
    deleteBlocked = true;
  }
  check("ledger update is a hard error (append-only)", updateBlocked);
  check("ledger delete is a hard error (append-only)", deleteBlocked);

  await cleanup(agentId);
}

async function testRefundIdempotency(): Promise<void> {
  const agentId = new Types.ObjectId();
  await getOrCreateWallet(agentId);
  await recordManualMovement({ agentId, type: "TOPUP", amount: 1000, meta: { note: "t" } });
  const bookingId = new Types.ObjectId();
  await debitForBooking(agentId, bookingId, 400, async () => {}, {});

  const first = await refundForBooking(agentId, bookingId, async () => {}, {});
  const second = await refundForBooking(agentId, bookingId, async () => {}, {});
  const refunds = await LedgerEntryModel.countDocuments({ agentId, type: "REFUND" });
  const wallet = await WalletModel.findOne({ agentId });

  check("first cancel refunds", first === true);
  check("second cancel is a no-op (returns false)", second === false);
  check("exactly one REFUND entry", refunds === 1, `${refunds}`);
  check("balance restored exactly once", wallet?.balance === 1000, `${wallet?.balance}`);

  await cleanup(agentId);
}

async function main(): Promise<void> {
  await connectDb();
  await testLedgerInvariant();
  await testInsufficientBalance();
  for (let i = 1; i <= 5; i++) await testConcurrency(i);
  await testImmutability();
  await testRefundIdempotency();
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  await mongoose.disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(2);
});
