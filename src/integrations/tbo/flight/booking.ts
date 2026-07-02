import { withRetry, tboBase, tboApiUrl, tboFetch, TBO_DEFAULT_TIMEOUT_MS, AIR_BOOK_SVC } from "../auth";
import { assertTboSuccess } from "../errors";
import { logRequest, logResponse, logError } from "../log";
import type { TboFlightBookingDetailResponse } from "../types";

// CLAUDE.md timeout-recovery: GetBookingDetails returns this while the supplier is
// still processing — keep polling rather than rebooking (to avoid financial loss).
function isBookingUnderProcess(error: { ErrorMessage?: string } | undefined | null): boolean {
  const m = (error?.ErrorMessage ?? "").toLowerCase();
  return m.includes("under process") || m.includes("could not be processed");
}

export type BookingStatus = "CONFIRMED" | "FAILED" | "PENDING";

export interface BookingDetailResult {
  bookingId: number;
  pnr: string;
  bookingStatus: BookingStatus;
  ticketNumbers: string[];
}

// Resolve the final booking status from a GetBookingDetails itinerary.
//
// The unambiguous signal is the issued ticket: when every passenger carries a
// ticket (Status "OK" / a TicketNumber) the booking is CONFIRMED, regardless of the
// numeric code. The itinerary-level `Status` is a secondary check (5 = ticketed/
// confirmed in the GetBookingDetails enum; 1 = successful on older sources).
//
// Genuinely in-progress bookings never reach here — they surface as a "booking under
// process" error and are reported PENDING by the caller. So once a FlightItinerary is
// returned, treat the absence of confirmation as a terminal FAILED rather than
// polling for the full timeout.
function mapBookingStatus(status: number, hasTicket: boolean): BookingStatus {
  if (hasTicket || status === 1 || status === 5) return "CONFIRMED";
  return "FAILED";
}

export async function tboGetFlightBookingDetail(
  bookingId: number,
  pnr?: string,
): Promise<BookingDetailResult> {
  return withRetry(async (token) => {
    const url = tboApiUrl(`${AIR_BOOK_SVC}/GetBookingDetails`, "book");
    // PNR sent alongside BookingId to match the certified sample
    // (sampleVerificationLogs getBookingDetails*Request.txt). Only when available.
    const reqBody = { ...tboBase(token), BookingId: bookingId, ...(pnr ? { PNR: pnr } : {}) };
    logRequest("Flight GetBookingDetails", url, { ...reqBody, TokenId: "***" });

    let res: Response;
    try {
      res = await tboFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(TBO_DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      logError("Flight GetBookingDetails", err);
      throw err;
    }

    const text = await res.text();
    let data: TboFlightBookingDetailResponse;
    try { data = JSON.parse(text); }
    catch { throw new Error(`TBO GetBookingDetails non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`); }

    logResponse("Flight GetBookingDetails", res.status, data);
    if (!res.ok) throw new Error(`TBO GetBookingDetails HTTP ${res.status}`);

    // "Booking under process" is not a failure — report PENDING so the poller retries.
    if (isBookingUnderProcess(data.Response?.Error)) {
      return { bookingId, pnr: "", bookingStatus: "PENDING", ticketNumbers: [] };
    }
    assertTboSuccess(data.Response?.Error);

    const itinerary = data.Response?.FlightItinerary;
    const passengers = itinerary?.Passenger ?? [];
    const ticketNumbers = passengers
      .map((p) => p.Ticket?.TicketNumber)
      .filter((t): t is string => Boolean(t));
    // A booking is confirmed once tickets are issued — the unambiguous signal.
    const hasTicket =
      ticketNumbers.length > 0 ||
      passengers.some((p) => (p.Ticket?.Status ?? "").toUpperCase() === "OK");
    // GetBookingDetails uses "Status"; fall back to "BookingStatus" for safety.
    const statusCode = itinerary?.Status ?? itinerary?.BookingStatus ?? 0;

    return {
      bookingId: itinerary?.BookingId ?? bookingId,
      pnr: itinerary?.PNR ?? "",
      bookingStatus: mapBookingStatus(statusCode, hasTicket),
      ticketNumbers,
    };
  });
}

/**
 * Polls GetBookingDetail until status is CONFIRMED or FAILED, or until
 * maxAttempts is exhausted (returns PENDING in that case).
 */
export async function pollFlightBookingDetail(
  bookingId: number,
  pnr?: string,
  // CLAUDE.md: poll every 10–15s until a real status returns (avoid rebooking).
  maxAttempts = 20,
  delayMs = 12000,
): Promise<BookingDetailResult> {
  let last: BookingDetailResult | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }

    last = await tboGetFlightBookingDetail(bookingId, pnr);
    if (last.bookingStatus !== "PENDING") return last;
  }

  return last ?? { bookingId, pnr: "", bookingStatus: "PENDING", ticketNumbers: [] };
}
