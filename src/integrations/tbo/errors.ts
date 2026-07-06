import type { TboError as TboErrorShape } from "./types";

export class TboError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "TboError";
  }
}

// TBO session token expired — auto re-authenticate and retry
export class TboInvalidSessionError extends TboError {
  constructor() {
    super(10001, "TBO session is invalid or expired");
    this.name = "TboInvalidSessionError";
  }
}

// TraceId / ResultIndex has expired (>15 min) — caller must re-run search
export class TboFareExpiredError extends TboError {
  constructor() {
    super(10002, "Fare has expired; please search again");
    this.name = "TboFareExpiredError";
  }
}

// Requested seat is no longer available
export class TboSeatUnavailableError extends TboError {
  constructor(detail?: string) {
    super(10003, detail ?? "Selected seat is no longer available");
    this.name = "TboSeatUnavailableError";
  }
}

// Booking submission failed — retry once before surfacing to user
export class TboBookingFailedError extends TboError {
  constructor(detail?: string) {
    super(10004, detail ?? "Booking failed");
    this.name = "TboBookingFailedError";
  }
}

// No results (not an error per se, but treated uniformly)
export class TboNoResultsError extends TboError {
  constructor() {
    super(10005, "No results returned by TBO");
    this.name = "TboNoResultsError";
  }
}

// A certification/business validation failed before the request was sent to TBO
// (e.g. missing PAN/guardian, passport required, invalid name). Surfaced to the
// user as a 422 so they can correct the input.
export class TboValidationError extends TboError {
  constructor(detail: string) {
    super(10006, detail);
    this.name = "TboValidationError";
  }
}

// TBO reported a fare change at Book/Ticket AFTER the customer paid the FareQuote
// price. We do not silently accept a price the customer never saw — the payment is
// refunded and the user is asked to re-book at the new price.
export class TboPriceChangedError extends TboError {
  constructor(detail?: string) {
    super(10007, detail ?? "Fare changed before the ticket could be issued");
    this.name = "TboPriceChangedError";
  }
}

// Domestic-return dual-PNR: the OUTBOUND ticket was issued but the INBOUND leg then
// failed. We must NOT blanket-refund (the outbound ticket is real) — the caller flags
// the booking for manual reconciliation and records the issued outbound PNR.
export class TboPartialBookingError extends TboError {
  constructor(
    public readonly issued: { pnr: string; bookingId: number; ticketNumbers: string[] },
    public readonly reason: string,
  ) {
    super(10008, `Outbound ticket issued (PNR ${issued.pnr || issued.bookingId}) but the inbound leg failed: ${reason}`);
    this.name = "TboPartialBookingError";
  }
}

/**
 * Duplicate Booking Validation: per TBO support (Jun 2026), an identical booking is
 * blocked for 5 days for the same passenger criteria + sector — "Booking is already
 * done for the same criteria for PNR ...". (CLAUDE.md's 24h figure is superseded.)
 * We can't reliably pre-check client-side, so we surface a clear message instead.
 */
export function isDuplicateBookingError(message: string | undefined | null): boolean {
  const m = (message ?? "").toLowerCase();
  return (
    (m.includes("already") && (m.includes("book") || m.includes("done"))) ||
    m.includes("duplicate booking") ||
    m.includes("same criteria")
  );
}

/**
 * Inspects the TBO error envelope and throws the appropriate typed error.
 * Returns void when the response indicates success (ErrorCode === 0).
 */
export function assertTboSuccess(error: TboErrorShape | undefined | null): void {
  if (!error || error.ErrorCode === 0) return;

  const { ErrorCode, ErrorMessage } = error;
  const msg = ErrorMessage ?? "";
  const lower = msg.toLowerCase();

  // Token ID Validation (CLAUDE.md): "Always check ErrorCode: 6 for Invalid Token
  // rather than checking the error message." A fresh token must be regenerated —
  // withRetry() clears the cache and re-authenticates on TboInvalidSessionError.
  if (
    ErrorCode === 6 ||
    lower.includes("invalid session") ||
    lower.includes("session expired") ||
    lower.includes("invalid token") ||
    ErrorCode === 10001
  ) {
    throw new TboInvalidSessionError();
  }

  // Trace ID Validation: TraceId expires after booking or after 15 minutes,
  // surfacing as "Your session (TraceId) is expired." — caller must re-run Search.
  if (
    lower.includes("fare expired") ||
    lower.includes("traceid expired") ||
    lower.includes("trace id") ||
    lower.includes("traceid") ||
    (lower.includes("session") && lower.includes("expired")) ||
    ErrorCode === 10002
  ) {
    throw new TboFareExpiredError();
  }

  if (msg.toLowerCase().includes("seat") && msg.toLowerCase().includes("unavailable")) {
    throw new TboSeatUnavailableError(msg);
  }

  if (
    msg.toLowerCase().includes("booking failed") ||
    msg.toLowerCase().includes("unable to book")
  ) {
    throw new TboBookingFailedError(msg);
  }

  throw new TboError(ErrorCode, msg || `TBO error code ${ErrorCode}`);
}
