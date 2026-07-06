import refData from "../data/airportReference.json";
import { withRetry, tboBase, tboApiUrl, tboFetch, getTboAgencyId } from "../auth";
import { logRequest, logResponse, logError } from "../log";

// ─── GetAirlineSectorList ───────────────────────────────────────────────────────
//
// TBO's sector-list API returns, per airline "source", the valid Origin → Destination
// airport-code pairs it operates. It is the authoritative list of *served* airports
// (~3.5k codes) — but it returns CODES ONLY (no station names). We enrich those codes
// with names/city/country/tz from a committed static reference (airportReference.json,
// derived from the open mwgg/Airports dataset) to produce the airport picker dataset.
//
// This call MUST run from the whitelisted server egress IP (EndUserIp = server IP),
// which is why it lives on the Express server and not in the Vercel/Next layer.

export interface AirportRecord {
  code: string; // IATA
  name: string;
  city: string;
  country: string; // full name
  countryCode: string; // ISO-2
  tz: string;
}

export interface AirportDataset {
  airports: AirportRecord[];
  /** TBO airline "source" names that operate at least one sector (e.g. "Indigo"). */
  airlineSources: string[];
  /** Total distinct served codes returned by TBO (incl. ones we could not name). */
  servedCount: number;
  /** Count of served codes we could enrich with a name (== airports.length). */
  namedCount: number;
  updatedAt: string; // ISO timestamp of the refresh
}

interface TboSectorSource {
  SourceName: string;
  SectorLists: { Origin: string; Destinations: string[] }[] | null;
}

interface TboAirlineSectorResponse {
  Response: {
    Error: { ErrorCode: number; ErrorMessage: string };
    ResponseStatus: number;
    SectorLists: TboSectorSource[] | null;
  };
}

// reference: IATA code → [name, city, country(full), countryCode(ISO-2), tz]
// JSON tuples are inferred as string[]; assert the fixed 5-field shape.
const reference = refData as unknown as Record<string, [string, string, string, string, string]>;

/** Raw TBO call. Throws on transport / TBO error. */
export async function tboGetAirlineSectorList(): Promise<TboAirlineSectorResponse> {
  return withRetry(async (token) => {
    const agencyId = await getTboAgencyId();
    const body = { ...tboBase(token), TraceId: "", AgencyId: agencyId };
    const url = tboApiUrl("AirAPI_V10/AirService.svc/rest/GetAirlineSectorList");

    logRequest("GetAirlineSectorList", url, { ...body, TokenId: "***" });

    let res: Response;
    try {
      res = await tboFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      logError("GetAirlineSectorList", err, { url });
      throw new Error(
        `TBO GetAirlineSectorList network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const text = await res.text();
    let data: TboAirlineSectorResponse;
    try {
      data = JSON.parse(text);
    } catch {
      logError("GetAirlineSectorList", new Error("non-JSON response"), {
        status: res.status,
        text: text.slice(0, 500),
      });
      throw new Error(
        `TBO GetAirlineSectorList returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`,
      );
    }

    // The payload is large (~600KB+) — log only a summary, never the full body.
    logResponse("GetAirlineSectorList", res.status, {
      ResponseStatus: data?.Response?.ResponseStatus,
      Error: data?.Response?.Error,
      airlineSources: data?.Response?.SectorLists?.length ?? 0,
    });

    if (!res.ok) {
      throw new Error(`TBO GetAirlineSectorList HTTP ${res.status}: ${res.statusText}`);
    }
    const r = data?.Response;
    if (!r) throw new Error("TBO GetAirlineSectorList missing Response envelope");
    if (r.ResponseStatus !== 1) {
      throw new Error(`TBO GetAirlineSectorList non-success ResponseStatus: ${r.ResponseStatus}`);
    }
    if (r.Error?.ErrorCode !== 0) {
      throw new Error(
        `TBO GetAirlineSectorList error ${r.Error?.ErrorCode}: ${r.Error?.ErrorMessage}`,
      );
    }
    return data;
  });
}

/** Reduce the raw TBO response to the enriched, picker-ready airport dataset. */
export function buildDatasetFromResponse(data: TboAirlineSectorResponse): AirportDataset {
  const sources = data.Response.SectorLists ?? [];
  const served = new Set<string>();
  for (const src of sources) {
    for (const sec of src.SectorLists ?? []) {
      if (sec.Origin) served.add(sec.Origin);
      for (const d of sec.Destinations ?? []) served.add(d);
    }
  }

  const airports: AirportRecord[] = [];
  for (const code of served) {
    // Drop TBO meta/junk codes (".LKO", "BLR,GOI", city pseudo-codes) — keep only
    // codes that are real 3-letter IATA AND present in the names reference.
    if (!/^[A-Z]{3}$/.test(code)) continue;
    const ref = reference[code];
    if (!ref) continue;
    airports.push({
      code,
      name: ref[0],
      city: ref[1] || code,
      country: ref[2],
      countryCode: ref[3],
      tz: ref[4],
    });
  }
  airports.sort((a, b) => a.city.localeCompare(b.city) || a.code.localeCompare(b.code));

  return {
    airports,
    airlineSources: sources.map((s) => s.SourceName),
    servedCount: served.size,
    namedCount: airports.length,
    updatedAt: new Date().toISOString(),
  };
}
