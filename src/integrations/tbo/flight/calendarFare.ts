import { withRetry, tboBase, tboApiUrl, tboFetch } from "../auth";
import { logRequest, logResponse, logError } from "../log";

const CABIN_TO_TBO: Record<string, string> = {
  ECONOMY: "2",
  PREMIUM_ECONOMY: "3",
  BUSINESS: "4",
  FIRST: "6",
};

export interface CalendarFareDay {
  date: string; // YYYY-MM-DD derived from DepartureTime
  totalFare: number;
  baseFare: number;
  tax: number;
  isLowestFareOfMonth: boolean;
  airlineCode: string;
  airlineName: string;
}

export interface CalendarFareInput {
  from: string;
  to: string;
  cabin: string;
  month: string; // "YYYY-MM" — first day of this month is used as PreferredDepartureTime
}

// ─── Internal TBO shapes ──────────────────────────────────────────────────────

interface TboCalendarResult {
  AirlineCode: string;
  AirlineName: string;
  DepartureDate: string; // "yyyy-MM-ddTHH:mm:ss"
  IsLowestFareOfMonth: boolean;
  Fare: number;
  BaseFare: number;
  Tax: number;
  FuelSurcharge: number;
  OtherCharges: number;
}

interface TboCalendarResponse {
  Response: {
    TraceId: string;
    Origin: string;
    Destination: string;
    SearchResults: TboCalendarResult[] | null;
    ResponseStatus: number;
    Error: { ErrorCode: number; ErrorMessage: string };
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mapResult(r: TboCalendarResult): CalendarFareDay {
  return {
    date: r.DepartureDate.slice(0, 10),
    totalFare: Math.round(r.Fare ?? r.BaseFare + r.Tax + r.OtherCharges),
    baseFare: r.BaseFare,
    tax: r.Tax,
    isLowestFareOfMonth: r.IsLowestFareOfMonth ?? false,
    airlineCode: r.AirlineCode,
    airlineName: r.AirlineName,
  };
}

function buildSegment(
  from: string,
  to: string,
  cabin: string,
  departureTime: string,
): object {
  return {
    Origin: from,
    Destination: to,
    FlightCabinClass: CABIN_TO_TBO[cabin] ?? "2",
    PreferredDepartureTime: departureTime,
    PreferredArrivalTime: departureTime,
  };
}

// TBO calendar fare only covers domestic Indian routes. Check by IATA country codes
// is not practical here — so we detect by checking if both codes are 3-letter and let
// the API fail gracefully for international pairs (caught in the route handler).


async function callCalendarEndpoint(
  endpointPath: string,
  label: string,
  body: object,
): Promise<TboCalendarResponse> {
  const url = tboApiUrl(endpointPath);
  logRequest(label, url, { ...(body as Record<string, unknown>), TokenId: "***" });

  let res: Response;
  try {
    res = await tboFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    logError(label, err, { url });
    throw new Error(
      `TBO ${label} network error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const text = await res.text();
  let data: TboCalendarResponse;
  try {
    data = JSON.parse(text);
  } catch {
    logError(label, new Error("non-JSON response"), {
      status: res.status,
      text: text.slice(0, 500),
    });
    throw new Error(`TBO ${label} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }

  logResponse(label, res.status, data);

  if (!res.ok) throw new Error(`TBO ${label} HTTP ${res.status}: ${res.statusText}`);
  if (!data?.Response) throw new Error(`TBO ${label} missing Response envelope`);

  return data;
}

// ─── Public ───────────────────────────────────────────────────────────────────

/**
 * GetCalendarFare — cheapest fare per day for the entire month.
 * Call once per (route, cabin, month) combination to populate the date strip.
 */
export async function tboGetCalendarFare(
  input: CalendarFareInput,
): Promise<CalendarFareDay[]> {
  return withRetry(async (token) => {
    const departureTime = `${input.month}-01T00:00:00`;

    const body = {
      ...tboBase(token),
      AdultCount: "1",
      ChildCount: "0",
      InfantCount: "0",
      DirectFlight: "false",
      OneStopFlight: "false",
      JourneyType: "1",
      PreferredAirlines: null,
      Segments: [buildSegment(input.from, input.to, input.cabin, departureTime)],
      Sources: null,
    };

    const data = await callCalendarEndpoint(
      "AirAPI_V10/AirService.svc/rest/GetCalendarFare",
      "GetCalendarFare",
      body,
    );

    const { ResponseStatus, Error: err, SearchResults } = data.Response;
    if (ResponseStatus !== 1) {
      throw new Error(`TBO GetCalendarFare non-success ResponseStatus: ${ResponseStatus}`);
    }
    if (err?.ErrorCode !== 0) {
      throw new Error(`TBO GetCalendarFare error ${err?.ErrorCode}: ${err?.ErrorMessage}`);
    }

    return (SearchResults ?? []).map(mapResult);
  });
}

/**
 * UpdateCalendarFareOfDay — real-time fare refresh for a single day.
 * Must be called after GetCalendarFare; returns updated fares for the given date.
 */
export async function tboUpdateCalendarFareOfDay(
  input: Omit<CalendarFareInput, "month"> & { date: string },
): Promise<CalendarFareDay[]> {
  return withRetry(async (token) => {
    const departureTime = `${input.date}T00:00:00`;

    const body = {
      ...tboBase(token),
      AdultCount: "1",
      ChildCount: "0",
      InfantCount: "0",
      DirectFlight: "false",
      OneStopFlight: "false",
      JourneyType: "1",
      PreferredAirlines: null,
      Segments: [buildSegment(input.from, input.to, input.cabin, departureTime)],
      Sources: null,
    };

    const data = await callCalendarEndpoint(
      "AirAPI_V10/AirService.svc/rest/UpdateCalendarFareOfDay",
      "UpdateCalendarFareOfDay",
      body,
    );

    const { ResponseStatus, Error: err, SearchResults } = data.Response;
    if (ResponseStatus !== 1 || err?.ErrorCode !== 0) return [];

    return (SearchResults ?? []).map(mapResult);
  });
}
