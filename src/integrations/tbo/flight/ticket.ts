import { withRetry, tboBase, tboApiUrl, tboFetch, TBO_BOOK_TIMEOUT_MS, AIR_BOOK_SVC } from "../auth";
import { assertTboSuccess, TboFareExpiredError, TboError } from "../errors";
import { getTrace } from "../traceCache";
import { logRequest, logResponse, logError } from "../log";
import { getAirport } from "../data/airports";
import type { TboTicketResponse, TboFareBreakdown } from "../types";
import { type BookingPassenger, mapPassenger } from "./book";
import { validateBookingPassengers, applyMandatorySSR, type BookingValidationContext } from "./validation";
import { tboGetSSR } from "./ssr";

// AirAsia + I5 + other carriers that need free baggage explicitly included on intl LCC.
const I5 = "I5";

// ─── Input types ──────────────────────────────────────────────────────────────

/**
 * LCC airlines (IsLCC: true from Search/FareQuote):
 *   No prior Book step — Ticket issues directly.
 *   Endpoint receives: ResultIndex + TraceId + Passengers[] with fare.
 *   Sample: OB Ticket.txt (6E / IndiGo).
 */
export interface LccTicketInput {
  isLCC: true;
  resultIndex: string;
  /** Explicit TraceId for serverless environments — falls back to traceCache. */
  traceId?: string;
  fareBreakdown: TboFareBreakdown[];
  passengers: BookingPassenger[];
  contactEmail: string;
  contactPhone: string;
  preferredCurrency?: string;  // defaults "INR"
  /** Special Fare Validation: when true, free meal/seat must be included from SSR. */
  isMealMandatory?: boolean;
  isSeatMandatory?: boolean;
  /** Price change accepted by the user (re-submitting after IsPriceChanged). */
  isPriceChangedAccepted?: boolean;
  /** Certification validation context (airline/route/requirement flags). */
  validation?: Omit<BookingValidationContext, "stage" | "contactPhone">;
}

/**
 * Non-LCC airlines (IsLCC: false from Search/FareQuote):
 *   Book must be called first to obtain BookingId.
 *   Ticket endpoint receives BookingId only.
 */
export interface NonLccTicketInput {
  isLCC: false;
  bookingId: number;
  /** PNR from the preceding Book response — sent alongside BookingId to tie the
   *  Ticket to its booking, matching sample case-01 (ticketNonLccRequest.txt). */
  pnr?: string;
  /** Price change accepted by the user (re-submitting after Book/Ticket IsPriceChanged). */
  isPriceChangedAccepted?: boolean;
}

export type TicketInput = LccTicketInput | NonLccTicketInput;

export interface TicketResult {
  bookingId: number;
  pnr: string;
  ticketNumbers: string[];
  bookingStatus: number;
  /** Ticket response signalled a late price change — prompt user, then re-call
   *  Ticket with isPriceChangedAccepted=true (CLAUDE.md "Price and Cancellation Change"). */
  isPriceChanged: boolean;
  isTimeChanged: boolean;
}

// ─── Shared response parser ───────────────────────────────────────────────────

function parseTicketResponse(data: TboTicketResponse, fallbackBookingId: number): TicketResult {
  // TBO nests the result under Response.Response; fall back to the outer level.
  const nested = data.Response?.Response;
  const itinerary = nested?.FlightItinerary ?? data.Response?.FlightItinerary;
  const ticketNumbers = (itinerary?.Passenger ?? [])
    .map((p) => p.Ticket?.TicketNumber)
    .filter((t): t is string => Boolean(t));

  return {
    bookingId: itinerary?.BookingId ?? nested?.BookingId ?? fallbackBookingId,
    pnr: itinerary?.PNR ?? nested?.PNR ?? "",
    ticketNumbers,
    bookingStatus: itinerary?.BookingStatus ?? 0,
    isPriceChanged: itinerary?.IsPriceChanged ?? false,
    isTimeChanged: itinerary?.IsTimeChanged ?? false,
  };
}

// Detects TBO's "meal/seat selection is mandatory" rejection (special fares like
// SpiceMax / Super 6E). Returns which SSR is required, or null if unrelated.
function mandatorySsrError(e: unknown): { meal: boolean; seat: boolean } | null {
  if (!(e instanceof TboError)) return null;
  const m = e.message.toLowerCase();
  const meal = m.includes("meal") && m.includes("mandatory");
  const seat = m.includes("seat") && m.includes("mandatory");
  return meal || seat ? { meal, seat } : null;
}

// ─── Non-LCC path ─────────────────────────────────────────────────────────────

async function tboNonLccTicket(
  bookingId: number,
  isPriceChangedAccepted = false,
  pnr?: string,
): Promise<TicketResult> {
  return withRetry(async (token) => {
    const url = tboApiUrl(`${AIR_BOOK_SVC}/Ticket`, "book");
    const reqBody = {
      ...tboBase(token),
      BookingId: bookingId,
      // PNR from Book ties the Ticket to its booking (sample case-01).
      ...(pnr ? { PNR: pnr } : {}),
      // Pass through only when re-submitting after a confirmed price change.
      ...(isPriceChangedAccepted ? { IsPriceChangedAccepted: true } : {}),
    };
    logRequest("Flight Ticket (Non-LCC)", url, { ...reqBody, TokenId: "***" });

    let res: Response;
    try {
      res = await tboFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(TBO_BOOK_TIMEOUT_MS),
      });
    } catch (err) {
      logError("Flight Ticket (Non-LCC)", err);
      throw err;
    }

    const text = await res.text();
    let data: TboTicketResponse;
    try { data = JSON.parse(text); }
    catch { throw new Error(`TBO Ticket non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`); }

    logResponse("Flight Ticket (Non-LCC)", res.status, data);
    if (!res.ok) throw new Error(`TBO Ticket (Non-LCC) HTTP ${res.status}`);
    assertTboSuccess(data.Response?.Error);

    return parseTicketResponse(data, bookingId);
  });
}

// ─── LCC path ─────────────────────────────────────────────────────────────────

async function tboLccTicket(input: LccTicketInput): Promise<TicketResult> {
  const traceId = input.traceId ?? getTrace(input.resultIndex);
  if (!traceId) throw new TboFareExpiredError();

  // Certification validation (PAN/passport/LCC/title/name rules) before TBO.
  if (input.validation) {
    validateBookingPassengers(input.passengers, {
      ...input.validation,
      stage: "ticket",
      contactPhone: input.contactPhone,
    });
  }

  // Special Fare (isseat/ismeal mandatory) + international-LCC free baggage:
  // pull free (Price 0) meal/seat/baggage from SSR and include them. Only fills
  // selections the user didn't make, so it can't override a valid choice.
  let passengersIn = input.passengers;
  let ssrIncluded = false;
  const origin = input.validation?.origin;
  const destination = input.validation?.destination;
  const origCc = origin ? getAirport(origin)?.countryCode : undefined;
  const destCc = destination ? getAirport(destination)?.countryCode : undefined;
  const isIntl = Boolean(origCc && destCc && origCc !== destCc);
  const airline = input.validation?.airlineCode?.toUpperCase();
  const includeFreeBaggage = isIntl || airline === I5;
  // I5 domestic must also carry the free (Price 0) meal node from SSR (CLAUDE.md).
  const includeFreeMeal = airline === I5 && !isIntl;

  // Pull free (Price 0) meal/seat/baggage from SSR and attach to passengers who
  // didn't choose. Used proactively (FareQuote flagged it / intl / I5) and
  // reactively (TBO rejects Ticket with "meal/seat selection is mandatory").
  const includeMandatorySSR = async (opts: { isMealMandatory?: boolean; isSeatMandatory?: boolean }) => {
    const ssr = await tboGetSSR(input.resultIndex, traceId);
    passengersIn = applyMandatorySSR(input.passengers, ssr, {
      isMealMandatory: opts.isMealMandatory,
      isSeatMandatory: opts.isSeatMandatory,
      includeFreeBaggage,
      includeFreeMeal,
    });
    ssrIncluded = true;
  };

  if (input.isMealMandatory || input.isSeatMandatory || includeFreeBaggage || includeFreeMeal) {
    try {
      await includeMandatorySSR({ isMealMandatory: input.isMealMandatory, isSeatMandatory: input.isSeatMandatory });
    } catch (err) {
      // SSR is best-effort here; if it fails, proceed with user selections.
      logError("Flight Ticket (LCC) SSR auto-include", err);
    }
  }

  const sendTicket = () => withRetry(async (token) => {
    const passengers = passengersIn.map((p, i) => {
      const mapped = mapPassenger(p, i === 0, input.fareBreakdown, true);
      if (i === 0) {
        mapped.Email = input.contactEmail;
        mapped.ContactNo = input.contactPhone;
      }
      return mapped;
    });

    const url = tboApiUrl(`${AIR_BOOK_SVC}/Ticket`, "book");
    // PreferredCurrency and IsBaseCurrencyRequired are required for LCC Ticket
    // per the certified sample (OB Ticket.txt / IB Ticket.txt).
    const reqBody = {
      PreferredCurrency: input.preferredCurrency ?? "INR",
      IsBaseCurrencyRequired: "true",
      ...tboBase(token),
      TraceId: traceId,
      ResultIndex: input.resultIndex,
      Passengers: passengers,
      ...(input.isPriceChangedAccepted ? { IsPriceChangedAccepted: true } : {}),
    };
    logRequest("Flight Ticket (LCC)", url, { ...reqBody, TokenId: "***" });

    let res: Response;
    try {
      res = await tboFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(TBO_BOOK_TIMEOUT_MS),
      });
    } catch (err) {
      logError("Flight Ticket (LCC)", err);
      throw err;
    }

    const text = await res.text();
    let data: TboTicketResponse;
    try { data = JSON.parse(text); }
    catch { throw new Error(`TBO Ticket (LCC) non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`); }

    logResponse("Flight Ticket (LCC)", res.status, data);
    if (!res.ok) throw new Error(`TBO Ticket (LCC) HTTP ${res.status}`);
    assertTboSuccess(data.Response?.Error);

    return parseTicketResponse(data, 0);
  });

  try {
    return await sendTicket();
  } catch (e) {
    // Special fares can require a free meal/seat even when FareQuote didn't flag it.
    // TBO rejects the first Ticket with ErrorCode 3 "Meal/Seat selection is
    // mandatory" and creates NO booking, so it is safe to fetch SSR, attach the
    // free meal/seat, and retry the Ticket exactly once.
    const mandatory = mandatorySsrError(e);
    if (mandatory && !ssrIncluded) {
      logError("Flight Ticket (LCC) retry with mandatory SSR", e);
      await includeMandatorySSR({
        isMealMandatory: mandatory.meal || input.isMealMandatory,
        isSeatMandatory: mandatory.seat || input.isSeatMandatory,
      });
      return await sendTicket();
    }
    throw e;
  }
}

// ─── Public dispatch ──────────────────────────────────────────────────────────

export async function tboIssueTicket(input: TicketInput): Promise<TicketResult> {
  if (!input.isLCC) return tboNonLccTicket(input.bookingId, input.isPriceChangedAccepted, input.pnr);
  return tboLccTicket(input);
}
