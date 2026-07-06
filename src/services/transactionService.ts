import { query } from "../config/postgres";

// PostgreSQL data-access layer for financial transactions.
//
// HARD RULE: this module NEVER touches MongoDB and NEVER imports a Mongoose
// model. It is pure Postgres. It also does NOT swallow errors with try/catch —
// it throws to the caller, who decides how to react (webhook -> 500 so Razorpay
// retries; workers -> log and continue).

export interface OrderAttempt {
  id: string;
  idempotency_key: string;
  user_id: string;
  amount: string; // NUMERIC comes back as string from pg
  provider_order_id: string | null;
  status: string;
  response_cache: unknown;
  created_at: Date;
}

export interface Transaction {
  id: string;
  user_id: string;
  idempotency_key: string | null;
  amount: string;
  currency: string;
  status: string;
  provider: string;
  provider_order_id: string | null;
  provider_payment_id: string | null;
  provider_signature: string | null;
  booking_ref: string | null;
  resource_type: string | null;
  resource_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateTransactionInput {
  userId: string;
  idempotencyKey?: string;
  amount: number;
  currency?: string;
  status?: string;
  providerOrderId?: string;
  bookingRef?: string;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Idempotency: record an order-creation attempt. Unique on idempotency_key, so a
 * duplicate insert raises a unique-violation the caller can treat as "already
 * seen". Returns the inserted row.
 */
export async function createOrderAttempt(
  idempotencyKey: string,
  userId: string,
  amount: number,
): Promise<OrderAttempt> {
  const res = await query<OrderAttempt>(
    `INSERT INTO order_attempts (idempotency_key, user_id, amount, status)
     VALUES ($1, $2, $3, 'initiated')
     RETURNING *`,
    [idempotencyKey, userId, amount],
  );
  return res.rows[0];
}

/** Look up a prior attempt by idempotency key. Returns null if none exists. */
export async function getOrderAttempt(idempotencyKey: string): Promise<OrderAttempt | null> {
  const res = await query<OrderAttempt>(
    `SELECT * FROM order_attempts WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  return res.rows[0] ?? null;
}

/**
 * Persist the Razorpay result against an order attempt so a repeated request
 * with the same key can be answered from cache without calling Razorpay again.
 */
export async function updateOrderAttempt(
  idempotencyKey: string,
  providerOrderId: string,
  status: string,
  responseCache: Record<string, unknown>,
): Promise<void> {
  await query(
    `UPDATE order_attempts
        SET provider_order_id = $2, status = $3, response_cache = $4
      WHERE idempotency_key = $1`,
    [idempotencyKey, providerOrderId, status, JSON.stringify(responseCache)],
  );
}

/** Create a transaction row (one per payment). */
export async function createTransaction(data: CreateTransactionInput): Promise<Transaction> {
  const res = await query<Transaction>(
    `INSERT INTO transactions
       (user_id, idempotency_key, amount, currency, status, provider_order_id,
        booking_ref, resource_type, resource_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      data.userId,
      data.idempotencyKey ?? null,
      data.amount,
      data.currency ?? "INR",
      data.status ?? "created",
      data.providerOrderId ?? null,
      data.bookingRef ?? null,
      data.resourceType ?? null,
      data.resourceId ?? null,
      data.metadata ? JSON.stringify(data.metadata) : null,
    ],
  );
  return res.rows[0];
}

/**
 * Move a transaction to a new status, recording the payment id + signature.
 * Matched by provider_order_id. Returns the updated row (or null if no match).
 */
export async function updateTransactionStatus(
  orderId: string,
  paymentId: string | null,
  signature: string | null,
  status: string,
): Promise<Transaction | null> {
  const res = await query<Transaction>(
    `UPDATE transactions
        SET status = $4,
            provider_payment_id = COALESCE($2, provider_payment_id),
            provider_signature  = COALESCE($3, provider_signature),
            updated_at = now()
      WHERE provider_order_id = $1
      RETURNING *`,
    [orderId, paymentId, signature, status],
  );
  return res.rows[0] ?? null;
}

/** Fetch a single transaction by its Razorpay order id. */
export async function getTransactionByOrderId(orderId: string): Promise<Transaction | null> {
  const res = await query<Transaction>(
    `SELECT * FROM transactions WHERE provider_order_id = $1`,
    [orderId],
  );
  return res.rows[0] ?? null;
}

/** All transactions for a user, newest first. */
export async function getUserTransactions(userId: string): Promise<Transaction[]> {
  const res = await query<Transaction>(
    `SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return res.rows;
}

/**
 * Transactions stuck in `pending` longer than `minutes` — used by the
 * reconciliation worker to find payments whose webhook may have been missed.
 */
export async function getStalePendingTransactions(minutes: number): Promise<Transaction[]> {
  const res = await query<Transaction>(
    `SELECT * FROM transactions
      WHERE status = 'pending'
        AND created_at < now() - ($1 || ' minutes')::interval`,
    [String(minutes)],
  );
  return res.rows;
}

/** Transactions in a terminal success state — used by the heal worker. */
export async function getSuccessfulTransactions(): Promise<Transaction[]> {
  const res = await query<Transaction>(
    `SELECT * FROM transactions WHERE status = 'success'`,
  );
  return res.rows;
}

/** Append an immutable lifecycle event. This table is never updated or deleted. */
export async function logEvent(
  transactionId: string | null,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await query(
    `INSERT INTO transaction_events (transaction_id, event_type, payload)
     VALUES ($1, $2, $3)`,
    [transactionId, eventType, JSON.stringify(payload)],
  );
}

/** Park a failed webhook payload in the dead-letter queue instead of dropping it. */
export async function pushToDLQ(
  endpoint: string,
  payload: Record<string, unknown>,
  error: string,
): Promise<void> {
  await query(
    `INSERT INTO dlq_events (endpoint, payload, error)
     VALUES ($1, $2, $3)`,
    [endpoint, JSON.stringify(payload), error],
  );
}

export interface DLQEvent {
  id: string;
  endpoint: string | null;
  payload: Record<string, unknown>;
  error: string | null;
  retry_count: number;
  resolved: boolean;
  created_at: Date;
}

/** Unresolved DLQ rows below the retry ceiling — used by the DLQ worker. */
export async function getUnresolvedDLQEvents(maxRetries: number): Promise<DLQEvent[]> {
  const res = await query<DLQEvent>(
    `SELECT * FROM dlq_events
      WHERE resolved = false AND retry_count < $1
      ORDER BY created_at ASC`,
    [maxRetries],
  );
  return res.rows;
}

export async function markDLQResolved(id: string): Promise<void> {
  await query(`UPDATE dlq_events SET resolved = true WHERE id = $1`, [id]);
}

export async function incrementDLQRetry(id: string, error: string): Promise<void> {
  await query(
    `UPDATE dlq_events SET retry_count = retry_count + 1, error = $2 WHERE id = $1`,
    [id, error],
  );
}
