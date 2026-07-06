import { withRetry, tboBase, tboApiUrl, tboFetch, TBO_DEFAULT_TIMEOUT_MS, AIR_BOOK_SVC } from "../auth";
import { assertTboSuccess, TboFareExpiredError } from "../errors";
import { getTrace, storeTrace } from "../traceCache";
import { logRequest, logResponse, logError } from "../log";
import type {
  TboFareQuoteResponse,
  TboFlightResult,
  TboSegmentGroup,
  TboFareFamily,
  TboFareBreakdown,
} from "../types";
import type { FlightOffer, FlightSegment, FareFamily, CabinClass } from "../data/flights.types";

const TBO_CABIN_TO_FRONTEND: Record<number, CabinClass> = {
  2: "ECONOMY",
  3: "PREMIUM_ECONOMY",
  4: "BUSINESS",
  5: "BUSINESS",
  6: "FIRST",
};

function parseBaggageKg(raw: string | undefined | null): number {
  if (!raw) return 0;
  const m = raw.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

function ensureUtc(iso: string): string {
  if (!iso) return iso;
  return iso.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + "Z";
}

function mapSegment(seg: TboSegmentGroup): FlightSegment {
  return {
    id: `${seg.Airline?.AirlineCode ?? ""}${seg.Airline?.FlightNumber ?? ""}-${seg.Origin?.DepTime ?? ""}`,
    airlineCode: seg.Airline?.AirlineCode ?? "",
    flightNumber: seg.Airline?.FlightNumber ?? "",
    aircraft: seg.Craft || "Unknown",
    from: seg.Origin?.Airport?.AirportCode ?? "",
    to: seg.Destination?.Airport?.AirportCode ?? "",
    depart: ensureUtc(seg.Origin?.DepTime ?? ""),
    arrive: ensureUtc(seg.Destination?.ArrTime ?? ""),
    durationMin: seg.Duration ?? 0,
    fromTerminal: seg.Origin?.Airport?.Terminal || undefined,
    toTerminal: seg.Destination?.Airport?.Terminal || undefined,
  };
}

function mapFareFamilies(
  tbFamilies: TboFareFamily[] | null | undefined,
  basePrice: number,
  refundable: boolean,
  baggageCabin: number,
  baggageCheckin: number,
): FareFamily[] {
  if (tbFamilies && tbFamilies.length > 0) {
    return tbFamilies.map((f, i) => ({
      id: f.FareFamilyCode || `ff-${i}`,
      name: f.FareFamilyName || "Standard",
      baggageCabin: parseBaggageKg(f.CabinBaggage),
      baggageCheckin: parseBaggageKg(f.Baggage),
      refundable: f.IsRefundable,
      changeable: f.IsRefundable,
      mealIncluded: false,
      seatSelection: "paid" as const,
      priceDelta: i === 0 ? 0 : Math.round(basePrice * 0.12 * i),
    }));
  }
  return [{
    id: "standard",
    name: "Standard",
    baggageCabin,
    baggageCheckin,
    refundable,
    changeable: refundable,
    mealIncluded: false,
    seatSelection: "paid" as const,
    priceDelta: 0,
  }];
}

function resultToOffer(result: TboFlightResult): FlightOffer {
  const outboundSegs: TboSegmentGroup[] = result.Segments?.[0] ?? [];
  const segments = outboundSegs.map(mapSegment);
  const totalDurationMin =
    outboundSegs.reduce((sum, s) => sum + (s.Duration ?? 0) + (s.GroundTime ?? 0), 0) -
    (outboundSegs.at(-1)?.GroundTime ?? 0);
  const stops = Math.max(0, outboundSegs.length - 1);
  const seatsLeft = outboundSegs[0]?.NoOfSeatAvailable ?? 9;
  const cabinNum = outboundSegs[0]?.CabinClass ?? 2;
  const cabin: CabinClass = TBO_CABIN_TO_FRONTEND[cabinNum] ?? "ECONOMY";
  const baggageCheckin = parseBaggageKg(outboundSegs[0]?.Baggage);
  const baggageCabin = parseBaggageKg(outboundSegs[0]?.CabinBaggage);
  // Use PublishedFare consistently — it is the customer-facing price.
  const basePrice = result.Fare?.PublishedFare ?? 0;

  return {
    id: result.ResultIndex,
    segments,
    stops,
    totalDurationMin,
    basePrice,
    currency: "INR",
    cabin,
    seatsLeft,
    fareFamilies: mapFareFamilies(
      result.FareFamilies,
      basePrice,
      result.IsRefundable,
      baggageCabin,
      baggageCheckin,
    ),
    refundable: result.IsRefundable,
    baggage: { cabin: baggageCabin, checkin: baggageCheckin },
  };
}

export interface FareQuoteResult {
  resultIndex: string;
  /** The (possibly refreshed) TraceId from TBO — pass this explicitly in all
   *  subsequent requests (book, ticket) to avoid serverless traceCache misses. */
  traceId: string;
  totalFare: number;
  isPriceChanged: boolean;
  isTimeChanged: boolean;
  /** True for LCC airlines (IndiGo, SpiceJet, etc.) — determines whether
   *  the booking flow calls /Ticket directly or /Book then /Ticket. */
  isLCC: boolean;
  /** Guideline §14: when true, GST details must be passed on the lead passenger
   *  in the Book/Ticket request. */
  isGSTMandatory: boolean;
  /** Per-pax-type aggregates from TBO FareBreakdown.
   *  Must be passed to book/ticket so each passenger receives the correct Fare node. */
  fareBreakdown: TboFareBreakdown[];
  // PAN & Passport Validation flags — drive required passenger inputs/enforcement.
  isPanRequiredAtBook: boolean;
  isPanRequiredAtTicket: boolean;
  isPassportRequiredAtBook: boolean;
  isPassportRequiredAtTicket: boolean;
  isPassportFullDetailRequiredAtBook: boolean;
  // Special Fare Validation — free meal/seat must be included in Ticket.
  isMealMandatory: boolean;
  isSeatMandatory: boolean;
  // Flight Information Change — e.g. "Time" / "Baggage"; must be acknowledged.
  flightDetailChangeInfo: string | null;
  // Airline + route — used to build the booking validation context client-side.
  airlineCode: string;
  origin: string;
  destination: string;
  updatedOffer?: FlightOffer;
}

export async function tboFareQuote(
  resultIndex: string,
  /** Explicit TraceId — required in serverless environments where the in-process
   *  traceCache may not be populated (different function instance than Search). */
  explicitTraceId?: string,
): Promise<FareQuoteResult> {
  const traceId = explicitTraceId ?? getTrace(resultIndex);
  if (!traceId) throw new TboFareExpiredError();

  return withRetry(async (token) => {
    const url = tboApiUrl(`${AIR_BOOK_SVC}/FareQuote`);
    const body = { ...tboBase(token), ResultIndex: resultIndex, TraceId: traceId };
    logRequest("Flight FareQuote", url, { ...body, TokenId: "***" });

    let res: Response;
    try {
      res = await tboFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TBO_DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      logError("Flight FareQuote", err);
      throw err;
    }

    const text = await res.text();
    let data: TboFareQuoteResponse;
    try { data = JSON.parse(text); }
    catch { throw new Error(`TBO FareQuote non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`); }

    logResponse("Flight FareQuote", res.status, data);
    if (!res.ok) throw new Error(`TBO FareQuote HTTP ${res.status}`);
    assertTboSuccess(data.Response?.Error);

    const result = data.Response?.Results;
    if (!result) throw new TboFareExpiredError();

    const isPriceChanged = data.Response?.IsPriceChanged ?? false;
    const isTimeChanged = data.Response?.IsTimeChanged ?? false;
    const refreshedTraceId = data.Response?.TraceId ?? traceId;

    // Refresh the in-process cache (helps local dev / single-instance deploys).
    storeTrace(result.ResultIndex, refreshedTraceId);

    const firstSeg = result.Segments?.[0]?.[0];
    const lastLeg = result.Segments?.[0] ?? [];
    const lastSeg = lastLeg[lastLeg.length - 1];

    return {
      resultIndex: result.ResultIndex,
      traceId: refreshedTraceId,
      totalFare: result.Fare?.PublishedFare ?? 0,
      isPriceChanged,
      isTimeChanged,
      isLCC: result.IsLCC,
      isGSTMandatory: result.IsGSTMandatory ?? false,
      fareBreakdown: result.FareBreakdown ?? [],
      isPanRequiredAtBook: result.IsPanRequiredAtBook ?? false,
      isPanRequiredAtTicket: result.IsPanRequiredAtTicket ?? false,
      isPassportRequiredAtBook: result.IsPassportRequiredAtBook ?? false,
      isPassportRequiredAtTicket: result.IsPassportRequiredAtTicket ?? false,
      isPassportFullDetailRequiredAtBook: result.IsPassportFullDetailRequiredAtBook ?? false,
      // TBO confirmed (Jun 2026) these are PascalCase in the FareQuote response.
      isMealMandatory: result.IsMealMandatory ?? false,
      isSeatMandatory: result.IsSeatMandatory ?? false,
      flightDetailChangeInfo: result.FlightDetailChangeInfo ?? null,
      airlineCode: firstSeg?.Airline?.AirlineCode ?? result.AirlineCode ?? "",
      origin: firstSeg?.Origin?.Airport?.AirportCode ?? "",
      destination: lastSeg?.Destination?.Airport?.AirportCode ?? "",
      updatedOffer: resultToOffer(result),
    };
  });
}
