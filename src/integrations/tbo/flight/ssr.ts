import { withRetry, tboBase, tboApiUrl, tboFetch, TBO_DEFAULT_TIMEOUT_MS, AIR_BOOK_SVC } from "../auth";
import { assertTboSuccess, TboFareExpiredError } from "../errors";
import { getTrace } from "../traceCache";
import { logRequest, logResponse, logError } from "../log";
import type {
  TboSSRResponse,
  TboBaggageSSROption,
  TboMealDynamicOption,
  TboSeatItem,
} from "../types";

// ─── Result types (frontend-facing) ──────────────────────────────────────────

export interface BaggageOption {
  code: string;
  weight: number;      // kg; 0 = "no baggage"
  price: number;
  currency: string;
  origin: string;
  destination: string;
  airlineCode: string;
  flightNumber: string;
  wayType: number;
  description: number; // 1=Included, 2=Purchase
  text?: string;
}

export interface MealDynamicOption {
  code: string;
  description: string; // AirlineDescription from TBO
  price: number;
  currency: string;
  origin: string;
  destination: string;
  airlineCode: string;
  flightNumber: string;
}

export interface SeatOption {
  code: string;
  rowNo: string;
  seatNo: string | null;
  seatType: number;         // 1=Window, 2=Aisle, 3=Middle
  availabilityType: number; // 1=Open, 3=Reserved/occupied, 4=Blocked
  price: number;
  currency: string;
  origin: string;
  destination: string;
  description: number;      // 1=Included, 2=Purchase
}

export interface NonLCCMealOption {
  code: string;
  description: string;
}

export interface SeatPreferenceOption {
  code: string;
  description: string;
}

export interface SSRResult {
  // LCC — one inner array per trip segment
  baggage: BaggageOption[][];
  mealDynamic: MealDynamicOption[][];
  // Flat list of bookable seats per segment (AvailablityType === 1 or not 0/4/5)
  seatMap: SeatOption[][];
  // Non-LCC
  meals: NonLCCMealOption[];
  seatPreferences: SeatPreferenceOption[];
}

// ─── Mappers ──────────────────────────────────────────────────────────────────

function mapBaggageSegment(segment: TboBaggageSSROption[]): BaggageOption[] {
  return segment.map((b) => ({
    code: b.Code,
    weight: b.Weight ?? 0,
    price: b.Price ?? 0,
    currency: b.Currency,
    origin: b.Origin,
    destination: b.Destination,
    airlineCode: b.AirlineCode,
    flightNumber: b.FlightNumber,
    wayType: b.WayType,
    description: b.Description,
    text: b.Text,
  }));
}

function mapMealSegment(segment: TboMealDynamicOption[]): MealDynamicOption[] {
  return segment.map((m) => ({
    code: m.Code,
    description: m.AirlineDescription || m.Code,
    price: m.Price ?? 0,
    currency: m.Currency,
    origin: m.Origin,
    destination: m.Destination,
    airlineCode: m.AirlineCode,
    flightNumber: m.FlightNumber,
  }));
}

function flattenSeatSegment(
  seatGroup: { SegmentSeat: Array<{ RowSeats: Array<{ Seats: TboSeatItem[] }> }> },
): SeatOption[] {
  const seats: SeatOption[] = [];
  for (const seg of seatGroup.SegmentSeat ?? []) {
    for (const row of seg.RowSeats ?? []) {
      for (const seat of row.Seats ?? []) {
        // Skip "NoSeat" placeholder rows and hard-blocked seats (AvailablityType 4 or 5)
        if (!seat.Code || seat.Code === "NoSeat") continue;
        if (seat.AvailablityType === 4 || seat.AvailablityType === 5) continue;
        seats.push({
          code: seat.Code,
          rowNo: seat.RowNo,
          seatNo: seat.SeatNo,
          seatType: seat.SeatType,
          availabilityType: seat.AvailablityType,
          price: seat.Price ?? 0,
          currency: seat.Currency,
          origin: seat.Origin,
          destination: seat.Destination,
          description: seat.Description,
        });
      }
    }
  }
  return seats;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function tboGetSSR(
  resultIndex: string,
  explicitTraceId?: string,
): Promise<SSRResult> {
  const traceId = explicitTraceId ?? getTrace(resultIndex);
  if (!traceId) throw new TboFareExpiredError();

  return withRetry(async (token) => {
    const url = tboApiUrl(`${AIR_BOOK_SVC}/SSR`);
    const body = { ...tboBase(token), ResultIndex: resultIndex, TraceId: traceId };
    logRequest("Flight SSR", url, { ...body, TokenId: "***" });

    let res: Response;
    try {
      res = await tboFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TBO_DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      logError("Flight SSR", err);
      throw err;
    }

    const text = await res.text();
    let data: TboSSRResponse;
    try { data = JSON.parse(text); }
    catch { throw new Error(`TBO SSR non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`); }

    logResponse("Flight SSR", res.status, data);
    if (!res.ok) throw new Error(`TBO SSR HTTP ${res.status}`);
    assertTboSuccess(data.Response?.Error);

    const r = data.Response;

    return {
      // LCC fields — default to empty arrays when airline doesn't support them
      baggage: (r.Baggage ?? []).map(mapBaggageSegment),
      mealDynamic: (r.MealDynamic ?? []).map(mapMealSegment),
      seatMap: (r.SeatDynamic ?? []).map(flattenSeatSegment),
      // Non-LCC fields
      meals: (r.Meal ?? []).map((m) => ({ code: m.Code, description: m.Description })),
      seatPreferences: (r.SeatPreference ?? []).map((s) => ({ code: s.Code, description: s.Description })),
    };
  });
}
