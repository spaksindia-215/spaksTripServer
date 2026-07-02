-- ============================================================================
-- Migration 001 — Financial transaction ledger (PostgreSQL)
--
-- This schema lives ALONGSIDE MongoDB. It owns ONLY financial records:
-- idempotency cache, transactions, an append-only audit log, and a dead-letter
-- queue. It does NOT import, reference, or structurally depend on any MongoDB /
-- Mongoose model. resource_type / resource_id are plain string references to a
-- Mongo _id; there are no cross-database foreign keys.
--
-- Safe to re-run: every statement uses IF NOT EXISTS.
-- ============================================================================

-- gen_random_uuid() lives in pgcrypto on older PG; it is built-in on PG 13+.
-- Enabling the extension is harmless if the function is already available.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- order_attempts — idempotency guard for Razorpay order creation.
-- One row per idempotency key generated on the checkout page load.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_attempts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key   VARCHAR(255) UNIQUE NOT NULL,
  user_id           VARCHAR(255) NOT NULL,
  amount            NUMERIC(12,2) NOT NULL,
  provider_order_id VARCHAR(255),
  status            VARCHAR(50) DEFAULT 'initiated',
  response_cache    JSONB,
  created_at        TIMESTAMPTZ DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- transactions — one row per payment, mutable status column.
-- This is the source of truth for payment state.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              VARCHAR(255) NOT NULL,
  idempotency_key      VARCHAR(255),
  amount               NUMERIC(12,2) NOT NULL,
  currency             VARCHAR(10) DEFAULT 'INR',
  status               VARCHAR(50) NOT NULL DEFAULT 'created',
  provider             VARCHAR(50) DEFAULT 'razorpay',
  provider_order_id    VARCHAR(255) UNIQUE,
  provider_payment_id  VARCHAR(255) UNIQUE,
  provider_signature   VARCHAR(500),
  booking_ref          VARCHAR(255),
  resource_type        VARCHAR(50),
  resource_id          VARCHAR(255),
  metadata             JSONB,
  created_at           TIMESTAMPTZ DEFAULT now(),
  updated_at           TIMESTAMPTZ DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- transaction_events — immutable, append-only lifecycle log.
-- One row per state change: CREATED -> INITIATED -> AUTHORIZED -> CAPTURED
--                                                              -> FAILED
--                                                              -> REFUNDED
-- NEVER updated or deleted.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transaction_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id  UUID REFERENCES transactions(id),
  event_type      VARCHAR(100) NOT NULL,
  payload         JSONB,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- dlq_events — dead-letter queue for webhook payloads that failed downstream
-- processing (e.g. MongoDB heal failed). Payloads are parked here, never lost.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dlq_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint     VARCHAR(255),
  payload      JSONB NOT NULL,
  error        TEXT,
  retry_count  INT DEFAULT 0,
  resolved     BOOLEAN DEFAULT false,
  created_at   TIMESTAMPTZ DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_transaction_events_txn_id ON transaction_events(transaction_id);

-- Supporting indexes for the worker queries (pending reconciliation, DLQ scan).
CREATE INDEX IF NOT EXISTS idx_order_attempts_key ON order_attempts(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_dlq_unresolved ON dlq_events(resolved, retry_count);
