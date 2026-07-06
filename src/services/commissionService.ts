import { query } from "../config/postgres";

// PostgreSQL data-access layer for the commissions / payouts / refunds ledger
// (migration 002). Hybrid finance scaffolding for the new partner-service modules.
//
// HARD RULE (same as transactionService): NEVER touches MongoDB, NEVER imports a
// Mongoose model — pure Postgres, references Mongo ids as plain strings.
//
// DORMANT in the enquiry-first phase: nothing calls these yet. They exist so the
// future online-booking flow records a commission on a confirmed booking, rolls
// accrued commissions into partner payouts, and logs refunds — without further
// schema work. `query()` throws in MongoDB-only mode (DATABASE_URL unset); every
// caller must wrap in try/catch and treat a throw as "finance ledger unavailable".

export interface CommissionRow {
  id: string;
  booking_id: string;
  vertical: string;
  partner_id: string;
  currency: string;
  gross_amount: string; // NUMERIC comes back as string from pg
  commission_rate: string;
  commission_amount: string;
  net_to_partner: string;
  status: string;
  payout_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface RecordCommissionInput {
  bookingId: string;
  vertical: string;
  partnerId: string;
  grossAmount: number;
  commissionRate: number; // fraction, e.g. 0.15
  currency?: string;
}

// Records (or upserts, keyed by booking) the platform commission on a confirmed
// booking. Commission + net-to-partner are derived here so the math lives in one place.
export async function recordCommission(input: RecordCommissionInput): Promise<CommissionRow> {
  const commissionAmount = Number((input.grossAmount * input.commissionRate).toFixed(2));
  const netToPartner = Number((input.grossAmount - commissionAmount).toFixed(2));
  const result = await query<CommissionRow>(
    `INSERT INTO commissions
       (booking_id, vertical, partner_id, currency, gross_amount, commission_rate, commission_amount, net_to_partner)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (booking_id) DO UPDATE SET
       gross_amount = EXCLUDED.gross_amount,
       commission_rate = EXCLUDED.commission_rate,
       commission_amount = EXCLUDED.commission_amount,
       net_to_partner = EXCLUDED.net_to_partner,
       updated_at = now()
     RETURNING *`,
    [
      input.bookingId,
      input.vertical,
      input.partnerId,
      input.currency ?? "INR",
      input.grossAmount,
      input.commissionRate,
      commissionAmount,
      netToPartner,
    ],
  );
  return result.rows[0];
}

export interface PayoutRow {
  id: string;
  partner_id: string;
  currency: string;
  period_start: Date | null;
  period_end: Date | null;
  gross_total: string;
  commission_total: string;
  amount: string;
  status: string;
  reference: string | null;
  processed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

// Lists a partner's payout history (most recent first).
export async function listPartnerPayouts(partnerId: string): Promise<PayoutRow[]> {
  const result = await query<PayoutRow>(
    `SELECT * FROM payouts WHERE partner_id = $1 ORDER BY created_at DESC`,
    [partnerId],
  );
  return result.rows;
}

export interface RecordRefundInput {
  bookingId: string;
  vertical?: string;
  amount: number;
  reason?: string;
  currency?: string;
}

export interface RefundRow {
  id: string;
  booking_id: string;
  vertical: string | null;
  currency: string;
  amount: string;
  reason: string | null;
  status: string;
  provider_refund_id: string | null;
  created_at: Date;
  updated_at: Date;
}

// Logs a refund against a booking (status starts "pending"; the payment provider
// callback later flips it to processed/failed).
export async function recordRefund(input: RecordRefundInput): Promise<RefundRow> {
  const result = await query<RefundRow>(
    `INSERT INTO refunds (booking_id, vertical, currency, amount, reason)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [input.bookingId, input.vertical ?? null, input.currency ?? "INR", input.amount, input.reason ?? null],
  );
  return result.rows[0];
}
