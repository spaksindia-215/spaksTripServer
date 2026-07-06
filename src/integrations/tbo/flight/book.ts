import { withRetry, tboBase, tboApiUrl, tboFetch, TBO_BOOK_TIMEOUT_MS, AIR_BOOK_SVC } from "../auth";
import { assertTboSuccess, TboFareExpiredError, TboBookingFailedError } from "../errors";
import { getTrace } from "../traceCache";
import { logRequest, logResponse, logError } from "../log";
import type { TboFlightBookResponse, TboPassengerRequest, TboFare, TboFareBreakdown } from "../types";
import { validateBookingPassengers, type BookingValidationContext } from "./validation";

// ─── Input types ──────────────────────────────────────────────────────────────

export interface GSTDetails {
  companyName: string;
  gstNumber: string;
  companyAddress: string;
  companyContactNumber: string;
  companyEmail: string;
}

export interface BookingPassenger {
  type: "ADT" | "CHD" | "INF";
  title: string;               // "Mr" | "Mrs" | "Ms" | "Mstr" | "Miss"
  firstName: string;
  lastName: string;
  gender: "M" | "F";
  dob: string;                 // "YYYY-MM-DD"
  addressLine1: string;        // required — sampleverification.html rule 5
  city: string;                // required — sampleverification.html rule 5
  countryCode?: string;        // ISO-2, defaults "IN"
  countryName?: string;        // defaults "India"
  passport?: string;
  passportExpiry?: string;     // "YYYY-MM-DD"
  passportIssueDate?: string;  // "YYYY-MM-DD" — when IsPassportFullDetailRequiredAtBook
  passportIssueCountryCode?: string; // ISO-2 — when IsPassportFullDetailRequiredAtBook
  nationality?: string;        // ISO-2, defaults "IN"
  email?: string;
  phone?: string;
  /** PAN & Passport Validation: Adult passes own PAN; Child/Infant pass guardian PAN. */
  pan?: string;
  /** Required for Child/Infant when PAN/Passport is mandatory (name as on PAN). */
  guardian?: { title?: string; firstName: string; lastName: string; pan?: string };
  /** Guideline §14: required on lead pax when FareQuote returns IsGSTMandatory=true. */
  gst?: GSTDetails;
  /** LCC: per-segment baggage selections (Guideline §7). */
  baggageSSR?: Array<{
    code: string; weight: number; price: number; currency?: string;
    origin: string; destination: string; airlineCode: string;
    flightNumber: string; wayType: number;
  }>;
  /** LCC: per-segment meal selections. */
  mealSSR?: Array<{
    code: string; description?: string; price: number; currency?: string;
    origin: string; destination: string; airlineCode: string; flightNumber: string;
  }>;
  /** LCC: per-segment seat selections (special fare isseatmandatory). */
  seatSSR?: Array<{
    code: string; price: number; currency?: string;
    origin: string; destination: string; airlineCode?: string;
    flightNumber?: string; wayType?: number;
  }>;
  /** Non-LCC: meal preference code. */
  mealCode?: string;
  mealDescription?: string;
  /** Non-LCC: seat preference code. */
  seatCode?: string;
  seatDescription?: string;
}

export interface TboBookFlightInput {
  resultIndex: string;
  /** Explicit TraceId from FareQuote — required in serverless deployments where
   *  the in-process traceCache may not survive across request boundaries. */
  traceId?: string;
  /** FareBreakdown array from the FareQuote response.
   *  Each passenger's Fare node is derived by dividing the aggregate per pax type
   *  by PassengerCount — per TBO certification requirement (general.html §10). */
  fareBreakdown: TboFareBreakdown[];
  passengers: BookingPassenger[];
  contactEmail: string;
  contactPhone: string;
  contactCountryCode?: string;
  mealCodes?: string[];
  seatCodes?: string[];
  /** Certification validation context (airline/route/requirement flags). When
   *  provided, the passenger list is validated before the request is sent. */
  validation?: Omit<BookingValidationContext, "stage" | "contactPhone">;
}

export interface TboBookFlightOutput {
  bookingId: number;
  pnr: string;
  isPriceChanged: boolean;
  /** Present for domestic return dual-PNR: inbound leg booking result. */
  returnLeg?: { bookingId: number; pnr: string };
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PAX_TYPE: Record<"ADT" | "CHD" | "INF", number> = { ADT: 1, CHD: 2, INF: 3 };
const GENDER: Record<"M" | "F", number> = { M: 1, F: 2 };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function dobToTbo(dob: string): string {
  return dob.includes("T") ? dob : `${dob}T00:00:00`;
}

/**
 * Builds a per-passenger TboFare by dividing the FareBreakdown aggregate by
 * PassengerCount for the given PaxType.
 *
 * Formula (general.html §10):
 *   per-pax BaseFare = FareBreakdown[paxType].BaseFare / PassengerCount
 *   per-pax Tax      = FareBreakdown[paxType].Tax      / PassengerCount
 *   per-pax YQTax    = FareBreakdown[paxType].YQTax    / PassengerCount
 *
 * Exported so tboLccTicket can reuse it without duplicating logic.
 */
export function buildPassengerFare(
  fareBreakdown: TboFareBreakdown[],
  paxType: number,
): TboFare {
  const bd = fareBreakdown.find((b) => b.PassengerType === paxType);
  if (!bd) {
    return {
      Currency: "INR", BaseFare: 0, Tax: 0, TaxBreakup: [], YQTax: 0,
      AdditionalTxnFeeOfrd: 0, AdditionalTxnFeePub: 0, PGCharge: 0,
      OtherCharges: 0, ChargeBU: [], Discount: 0, PublishedFare: 0,
      CommissionEarned: 0, PLBEarned: 0, IncentiveEarned: 0, OfferedFare: 0,
      TdsOnCommission: 0, TdsOnPLB: 0, TdsOnIncentive: 0, ServiceFee: 0,
      // PGCharge is not in FareBreakdown; TboFare zero-fills it
    };
  }
  const n = Math.max(1, bd.PassengerCount);
  return {
    Currency: bd.Currency ?? "INR",
    BaseFare: bd.BaseFare / n,
    Tax: bd.Tax / n,
    TaxBreakup: [],
    YQTax: bd.YQTax / n,
    AdditionalTxnFeeOfrd: (bd.AdditionalTxnFeeOfrd ?? 0) / n,
    AdditionalTxnFeePub: (bd.AdditionalTxnFeePub ?? 0) / n,
    PGCharge: 0,
    OtherCharges: 0,
    ChargeBU: [],
    Discount: 0,
    PublishedFare: 0,
    CommissionEarned: 0,
    PLBEarned: 0,
    IncentiveEarned: 0,
    OfferedFare: 0,
    TdsOnCommission: 0,
    TdsOnPLB: 0,
    TdsOnIncentive: 0,
    ServiceFee: 0,
  };
}

/**
 * Maps a BookingPassenger to the TBO wire format.
 * Exported so tboLccTicket can reuse the same passenger-building logic.
 * Caller is responsible for setting Email and ContactNo on the lead passenger.
 *
 * Guideline §6/§7 + README rule 8: LCC ADT/CHD carry Baggage/MealDynamic/SeatDynamic
 * only when a selection exists — blank SSR nodes are omitted, not sent as []. INF
 * passengers never carry these fields. Non-LCC passengers never use these array fields.
 */
export function mapPassenger(
  p: BookingPassenger,
  isLead: boolean,
  fareBreakdown: TboFareBreakdown[],
  isLCC = false,
): TboPassengerRequest {
  const passenger: TboPassengerRequest = {
    Title: p.title,
    FirstName: p.firstName,
    LastName: p.lastName,
    PaxType: PAX_TYPE[p.type],
    DateOfBirth: dobToTbo(p.dob),
    Gender: GENDER[p.gender],
    AddressLine1: p.addressLine1,
    City: p.city,
    CountryCode: p.countryCode ?? "IN",
    CountryName: p.countryName ?? "India",
    Nationality: p.nationality ?? "IN",
    ContactNo: "",   // populated by caller for lead pax
    Email: "",       // populated by caller for lead pax
    IsLeadPax: isLead,
    Fare: buildPassengerFare(fareBreakdown, PAX_TYPE[p.type]),
  };

  // Passport — only carry a real value when provided (doc: "if False and client is
  // providing then it should be the correct one"). On the Book (Non-LCC) payload we
  // additionally send empty-string placeholders to mirror sample case-01; on the LCC
  // Ticket payload blank nodes are omitted entirely (sampleVerificationLogs).
  if (p.passport) {
    passenger.PassportNo = p.passport;
    passenger.PassportExpiry = p.passportExpiry ? dobToTbo(p.passportExpiry) : "";
  } else if (!isLCC) {
    passenger.PassportNo = "";
    passenger.PassportExpiry = "";
  }

  // Passport full detail (IsPassportFullDetailRequiredAtBook) — only when present.
  if (p.passport && p.passportIssueDate) passenger.PassportIssueDate = dobToTbo(p.passportIssueDate);
  if (p.passport && p.passportIssueCountryCode) passenger.PassportIssueCountryCode = p.passportIssueCountryCode;

  // GST (Guideline §14): only on the lead pax when details are supplied. On the Book
  // payload, every pax carries empty-string GST placeholders (sample case-01); on the
  // LCC Ticket payload they are omitted when absent (sampleVerificationLogs).
  if (isLead && p.gst) {
    passenger.GSTCompanyAddress = p.gst.companyAddress ?? "";
    passenger.GSTCompanyContactNumber = p.gst.companyContactNumber ?? "";
    passenger.GSTCompanyName = p.gst.companyName ?? "";
    passenger.GSTNumber = p.gst.gstNumber ?? "";
    passenger.GSTCompanyEmail = p.gst.companyEmail ?? "";
  } else if (!isLCC) {
    passenger.GSTCompanyAddress = "";
    passenger.GSTCompanyContactNumber = "";
    passenger.GSTCompanyName = "";
    passenger.GSTNumber = "";
    passenger.GSTCompanyEmail = "";
  }

  // PAN & Passport Validation: Adult passes own PAN; Child/Infant pass GuardianDetails.
  if (p.type === "ADT") {
    if (p.pan) passenger.PAN = p.pan;
  } else if (p.guardian && (p.guardian.firstName || p.guardian.pan)) {
    passenger.GuardianDetails = {
      Title: p.guardian.title ?? "Mr",
      FirstName: p.guardian.firstName,
      LastName: p.guardian.lastName,
      ...(p.guardian.pan ? { PAN: p.guardian.pan } : {}),
    };
  }

  // Guideline §6/§7 + README rule 8: LCC ADT/CHD carry SSR arrays only when a
  // selection exists; blank SSR nodes are omitted ("do not pass blank nodes" when
  // SSR not used — sampleVerificationLogs). INF never carries SSR.
  if (isLCC && p.type !== "INF") {
    const baggage = (p.baggageSSR ?? []).map((b) => ({
      Code: b.code, Weight: b.weight, Price: b.price,
      Currency: b.currency ?? "INR",
      Origin: b.origin, Destination: b.destination,
      AirlineCode: b.airlineCode, FlightNumber: b.flightNumber,
      WayType: b.wayType, Description: 0,
    }));
    if (baggage.length) passenger.Baggage = baggage;

    const mealDynamic = (p.mealSSR ?? []).map((m) => ({
      Code: m.code, AirlineDescription: m.description ?? "",
      Price: m.price, Currency: m.currency ?? "INR",
      Origin: m.origin, Destination: m.destination,
      AirlineCode: m.airlineCode, FlightNumber: m.flightNumber,
      WayType: 1, Quantity: 1, Description: 0,
    }));
    if (mealDynamic.length) passenger.MealDynamic = mealDynamic;

    const seatDynamic = (p.seatSSR ?? []).map((s) => ({
      Code: s.code, Weight: 0, Price: s.price, Currency: s.currency ?? "INR",
      Origin: s.origin, Destination: s.destination,
      AirlineCode: s.airlineCode ?? "", FlightNumber: s.flightNumber ?? "",
      WayType: s.wayType ?? 1, Description: 0,
    }));
    if (seatDynamic.length) passenger.SeatDynamic = seatDynamic;
  }

  // Non-LCC: meal and seat preference codes (Guideline §8).
  if (!isLCC && p.mealCode) {
    passenger.Meal = { Code: p.mealCode, Description: p.mealDescription ?? "" };
  }
  if (!isLCC && p.seatCode) {
    passenger.Seat = { Code: p.seatCode, Description: p.seatDescription ?? "" };
  }

  return passenger;
}

// ─── Public ───────────────────────────────────────────────────────────────────

export async function tboBookFlight(input: TboBookFlightInput): Promise<TboBookFlightOutput> {
  const traceId = input.traceId ?? getTrace(input.resultIndex);
  if (!traceId) throw new TboFareExpiredError();

  // Certification validation (PAN/passport/LCC/title/name rules) before hitting TBO.
  if (input.validation) {
    validateBookingPassengers(input.passengers, {
      ...input.validation,
      stage: "book",
      contactPhone: input.contactPhone,
    });
  }

  const doBook = async (token: string): Promise<TboBookFlightOutput> => {
    const passengers: TboPassengerRequest[] = input.passengers.map((p, i) => {
      const mapped = mapPassenger(p, i === 0, input.fareBreakdown, false);
      if (i === 0) {
        mapped.Email = input.contactEmail;
        mapped.ContactNo = input.contactPhone;
      }
      return mapped;
    });

    const url = tboApiUrl(`${AIR_BOOK_SVC}/Book`, "book");
    const reqBody = {
      ...tboBase(token),
      ResultIndex: input.resultIndex,
      TraceId: traceId,
      Passengers: passengers,
    };
    logRequest("Flight Book", url, { ...reqBody, TokenId: "***" });

    let res: Response;
    try {
      res = await tboFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reqBody),
        // Book/Ticket can take up to 300s (CLAUDE.md "Response Timeout").
        signal: AbortSignal.timeout(TBO_BOOK_TIMEOUT_MS),
      });
    } catch (err) {
      logError("Flight Book", err);
      throw err;
    }

    const text = await res.text();
    let data: TboFlightBookResponse;
    try { data = JSON.parse(text); }
    catch { throw new Error(`TBO Book non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`); }

    logResponse("Flight Book", res.status, data);
    if (!res.ok) throw new Error(`TBO Book HTTP ${res.status}`);
    assertTboSuccess(data.Response?.Error);

    // TBO nests the booking result under Response.Response; fall back to outer level.
    const nested = data.Response?.Response;
    const itinerary = nested?.FlightItinerary ?? data.Response?.FlightItinerary;
    const bookingId = itinerary?.BookingId ?? nested?.BookingId;
    if (!bookingId) throw new TboBookingFailedError("No BookingId returned");

    return {
      bookingId,
      pnr: itinerary?.PNR ?? nested?.PNR ?? "",
      isPriceChanged: itinerary?.IsPriceChanged ?? false,
    };
  };

  try {
    return await withRetry(doBook);
  } catch (err) {
    if (err instanceof TboBookingFailedError) {
      return withRetry(doBook);
    }
    throw err;
  }
}
