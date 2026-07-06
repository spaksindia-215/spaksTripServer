-- ============================================================================
-- Migration 002 — Commissions, payouts & refunds ledger (PostgreSQL)
--
-- Hybrid finance scaffolding for the new partner-service modules (SightSeeing
-- first). These tables sit ALONGSIDE MongoDB and the 001 transaction ledger;
-- they own ONLY financial records and never reference a Mongoose model.
-- partner_id / booking_id are plain string references to a Mongo _id / bookingId
-- — there are NO cross-database foreign keys.
--
-- DORMANT in the enquiry-first phase: the SightSeeing template captures leads
-- only, so nothing writes here yet. The schema exists so the future online-booking
-- flow (commission split on a confirmed booking, partner payout runs, refunds)
-- wires straight in without another migration.
--
-- Apply the same way 001 is applied (manually via psql / Supabase SQL editor —
-- there is no TS migration runner). Safe to re-run: every statement uses
-- IF NOT EXISTS.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- commissions — the platform's cut on a confirmed booking, plus the net owed
-- to the partner. One row per booking.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commissions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id         VARCHAR(255) NOT NULL,          -- Mongo bookingId (bridge key)
  vertical           VARCHAR(30)  NOT NULL,          -- sightseeing | transfer | ...
  partner_id         VARCHAR(255) NOT NULL,          -- Mongo partner _id
  currency           VARCHAR(3)   NOT NULL DEFAULT 'INR',
  gross_amount       NUMERIC(12,2) NOT NULL,         -- total the customer paid
  commission_rate    NUMERIC(6,4)  NOT NULL DEFAULT 0, -- e.g. 0.1500 = 15%
  commission_amount  NUMERIC(12,2) NOT NULL DEFAULT 0,
  net_to_partner     NUMERIC(12,2) NOT NULL DEFAULT 0, -- gross - commission
  status             VARCHAR(20)  NOT NULL DEFAULT 'accrued', -- accrued | settled | reversed
  payout_id          UUID,                            -- set when rolled into a payout
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS commissions_booking_uq ON commissions (booking_id);
CREATE INDEX IF NOT EXISTS commissions_partner_idx ON commissions (partner_id, status);
CREATE INDEX IF NOT EXISTS commissions_vertical_idx ON commissions (vertical, created_at DESC);

-- ---------------------------------------------------------------------------
-- payouts — a settlement run that pays a partner the net of many commissions
-- over a period.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payouts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id         VARCHAR(255) NOT NULL,
  currency           VARCHAR(3)   NOT NULL DEFAULT 'INR',
  period_start       DATE,
  period_end         DATE,
  gross_total        NUMERIC(12,2) NOT NULL DEFAULT 0,
  commission_total   NUMERIC(12,2) NOT NULL DEFAULT 0,
  amount             NUMERIC(12,2) NOT NULL DEFAULT 0, -- net paid to the partner
  status             VARCHAR(20)  NOT NULL DEFAULT 'pending', -- pending | processing | paid | failed
  reference          VARCHAR(255),                    -- bank/UTR reference
  processed_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payouts_partner_idx ON payouts (partner_id, status);
CREATE INDEX IF NOT EXISTS payouts_created_idx ON payouts (created_at DESC);

-- ---------------------------------------------------------------------------
-- refunds — money returned to a customer for a cancelled/disputed booking.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refunds (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id         VARCHAR(255) NOT NULL,
  vertical           VARCHAR(30),
  currency           VARCHAR(3)   NOT NULL DEFAULT 'INR',
  amount             NUMERIC(12,2) NOT NULL,
  reason             TEXT,
  status             VARCHAR(20)  NOT NULL DEFAULT 'pending', -- pending | processed | failed
  provider_refund_id VARCHAR(255),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS refunds_booking_idx ON refunds (booking_id);
CREATE INDEX IF NOT EXISTS refunds_status_idx ON refunds (status, created_at DESC);
