import { withRetry, tboBase, tboApiUrl, tboFetch, TBO_DEFAULT_TIMEOUT_MS, AIR_SEARCH_SVC } from "../auth";
import { assertTboSuccess } from "../errors";
import { storeTrace } from "../traceCache";
import { logRequest, logResponse, logError } from "../log";
import type {
  TboFlightSearchResponse,
  TboFlightResult,
  TboSegmentGroup,
  TboFareFamily,
} from "../types";
import type {
  FlightOffer,
  FlightSearchInput,
  FlightSegment,
  FareFamily,
  CabinClass,
} from "../data/flights.types";

// ─── Cabin class mapping (per TBO docs Section 10.3) ──────────────────────────
// TBO enum: 1=All, 2=Economy, 3=PremiumEconomy, 4=Business, 5=PremiumBusiness, 6=First
const CABIN_TO_TBO: Record<CabinClass, string> = {
  ECONOMY: "2",
  PREMIUM_ECONOMY: "3",
  BUSINESS: "4",
  FIRST: "6",
};

const TBO_CABIN_TO_FRONTEND: Record<number, CabinClass> = {
  2: "ECONOMY",
  3: "PREMIUM_ECONOMY",
  4: "BUSINESS",
  5: "BUSINESS",        // PremiumBusiness collapses to BUSINESS in our UI
  6: "FIRST",
};

export interface TboFlightSearchInput extends FlightSearchInput {
  returnDate?: string; // YYYY-MM-DD, present for round-trip
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseBaggageKg(raw: string | undefined | null): number {
  if (!raw) return 0;
  const m = raw.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

function ensureUtc(iso: string): string {
  if (!iso) return iso;
  // TBO returns local times like "2024-12-30T11:15:00" — treat as UTC for display consistency
  return iso.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + "Z";
}

function segmentId(seg: TboSegmentGroup): string {
  return `${seg.Airline?.AirlineCode ?? "XX"}${seg.Airline?.FlightNumber ?? "0"}-${seg.Origin?.DepTime ?? ""}`;
}

function mapSegment(seg: TboSegmentGroup): FlightSegment {
  return {
    id: segmentId(seg),
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
  return [
    {
      id: "standard",
      name: "Standard",
      baggageCabin,
      baggageCheckin,
      refundable,
      changeable: refundable,
      mealIncluded: false,
      seatSelection: "paid" as const,
      priceDelta: 0,
    },
  ];
}

function buildTaxBreakdown(fare: TboFlightResult["Fare"]): FlightOffer["taxBreakdown"] {
  if (!fare) return undefined;
  const items: { key: string; amount: number }[] = [];

  for (const t of fare.TaxBreakup ?? []) {
    if (t.value > 0) items.push({ key: t.key, amount: Math.round(t.value) });
  }
  // OtherCharges and ServiceFee are top-level on TboFare, not in TaxBreakup
  if (fare.OtherCharges > 0) items.push({ key: "OtherCharges", amount: Math.round(fare.OtherCharges) });
  if (fare.ServiceFee > 0) items.push({ key: "ServiceFee", amount: Math.round(fare.ServiceFee) });

  return items.length > 0 ? items : undefined;
}

function mapResult(result: TboFlightResult): FlightOffer {
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

  // Per HTML response spec: Fare.PublishedFare is the canonical price field.
  // For API customers Discount is always 0, so PublishedFare === OfferedFare.
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
    taxBreakdown: buildTaxBreakdown(result.Fare),
  };
}

// ─── Public ───────────────────────────────────────────────────────────────────

export async function tboSearchFlights(
  input: TboFlightSearchInput,
): Promise<{ offers: FlightOffer[]; minPrice: number; maxPrice: number }> {
  return withRetry(async (token) => {
    const isRoundTrip = Boolean(input.returnDate);
    // JourneyType: 1=OneWay, 2=Return, 3=MultiStop, 4=AdvanceSearch, 5=SpecialReturn
    const journeyType = isRoundTrip ? "2" : "1";

    const segments: object[] = [
      {
        Origin: input.from,
        Destination: input.to,
        FlightCabinClass: CABIN_TO_TBO[input.cabin],
        PreferredDepartureTime: `${input.date}T00:00:00`,
        PreferredArrivalTime: `${input.date}T00:00:00`,
      },
    ];

    if (isRoundTrip && input.returnDate) {
      segments.push({
        Origin: input.to,
        Destination: input.from,
        FlightCabinClass: CABIN_TO_TBO[input.cabin],
        PreferredDepartureTime: `${input.returnDate}T00:00:00`,
        PreferredArrivalTime: `${input.returnDate}T00:00:00`,
      });
    }

    // TBO B2B convention: numeric counts and enums sent as strings
    const body = {
      ...tboBase(token),
      AdultCount: String(input.adults),
      ChildCount: String(input.children),
      InfantCount: String(input.infants),
      DirectFlight: input.directOnly ? "true" : "false",
      OneStopFlight: "false",
      JourneyType: journeyType,
      PreferredAirlines: null,
      Segments: segments,
      Sources: null,
    };

    // Per TBO docs: Search uses the Search service (BookingEngineService_Air).
    const url = tboApiUrl(`${AIR_SEARCH_SVC}/Search`);
    logRequest("Flight Search", url, { ...body, TokenId: "***" });

    let res: Response;
    try {
      res = await tboFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TBO_DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      logError("Flight Search", err, { url });
      throw new Error(
        `TBO Search network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const text = await res.text();
    let data: TboFlightSearchResponse;
    try {
      data = JSON.parse(text);
    } catch {
      logError("Flight Search", new Error("non-JSON response"), {
        status: res.status,
        text: text.slice(0, 500),
      });
      throw new Error(
        `TBO Search returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`,
      );
    }

    logResponse("Flight Search", res.status, data);

    if (!res.ok) {
      throw new Error(`TBO Search HTTP ${res.status}: ${res.statusText}`);
    }

    // The Response envelope may itself be missing if TBO returns an unexpected shape
    if (!data?.Response) {
      throw new Error(
        `TBO Search response missing 'Response' envelope. Got keys: ${Object.keys(data ?? {}).join(", ")}`,
      );
    }

    if (data.Response.ResponseStatus !== 1) {
      throw new Error(
        `TBO Search returned non-success ResponseStatus (expected 1, got ${data.Response.ResponseStatus ?? "undefined"})`,
      );
    }

    assertTboSuccess(data.Response.Error);

    const traceId = data.Response.TraceId ?? "";
    const rawResults = data.Response.Results;

    // TBO domestic return: Results is Results[0][]=OB, Results[1][]=IB.
    // One-way: Results[0][] only. We detect by checking if [1] is a non-empty array.
    const resultsArray = Array.isArray(rawResults) ? rawResults as unknown[] : [];
    const obResults: TboFlightResult[] = Array.isArray(resultsArray[0])
      ? resultsArray[0] as TboFlightResult[]
      : resultsArray as TboFlightResult[];
    const ibResults: TboFlightResult[] = (isRoundTrip && Array.isArray(resultsArray[1]) && (resultsArray[1] as unknown[]).length > 0)
      ? resultsArray[1] as TboFlightResult[]
      : [];

    if (obResults.length === 0) {
      console.log("[TBO] Flight Search returned 0 results");
      return { offers: [], minPrice: 0, maxPrice: 0 };
    }

    // Cache traceIds for all result indexes.
    for (const r of [...obResults, ...ibResults]) {
      if (r?.ResultIndex && traceId) storeTrace(r.ResultIndex, traceId);
    }

    const offers: FlightOffer[] = [];

    if (ibResults.length > 0) {
      // Domestic return: pair each OB with each IB result, combine price.
      for (const ob of obResults) {
        if (!ob?.ResultIndex) continue;
        for (const ib of ibResults) {
          if (!ib?.ResultIndex) continue;
          try {
            const obOffer = mapResult(ob);
            const ibOffer = mapResult(ib);
            offers.push({
              ...obOffer,
              // Combined price — both legs are booked under one selection.
              basePrice: obOffer.basePrice + ibOffer.basePrice,
              returnResultIndex: ib.ResultIndex,
              returnSegments: ibOffer.segments,
              traceId,
            });
          } catch (err) {
            logError("Flight Search mapResult (return pair)", err, {
              ob: ob.ResultIndex, ib: ib.ResultIndex,
            });
          }
        }
      }
    } else {
      // One-way or international return (single ResultIndex per offer).
      for (const result of obResults) {
        if (!result?.ResultIndex) continue;
        try {
          offers.push({ ...mapResult(result), traceId });
        } catch (err) {
          logError("Flight Search mapResult", err, { resultIndex: result.ResultIndex });
        }
      }
    }

    if (offers.length === 0) {
      return { offers: [], minPrice: 0, maxPrice: 0 };
    }

    const prices = offers.map((o) => o.basePrice).filter((p) => p > 0);
    const minPrice = prices.length > 0 ? Math.min(...prices) : 0;
    const maxPrice = prices.length > 0 ? Math.max(...prices) : 0;

    console.log(
      `[TBO] Flight Search returned ${offers.length} offers (price range ${minPrice}–${maxPrice})`,
    );

    return { offers, minPrice, maxPrice };
  });
}
