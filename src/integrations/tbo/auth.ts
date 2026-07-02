import { assertTboSuccess, TboInvalidSessionError } from "./errors";
import { logRequest, logResponse, logError } from "./log";
import { tboFetch } from "./proxyFetch";
import type { TboAuthResponse } from "./types";

// Re-exported so the flight modules can pull tboFetch from the same place as
// tboApiUrl/withRetry without adding a separate import line each.
export { tboFetch } from "./proxyFetch";

// Per HTML FAQ Q3: token is valid from 00:00:00 till 23:59:59 of the current
// day. Bullet on the page also notes "After 12:02 AM no new booking with old
// token." So we expire the cache at end-of-day, with a small safety buffer.
const TOKEN_RENEW_BUFFER_MS = 5 * 60 * 1000;

// Response Timeout Benchmarking (CLAUDE.md):
//   Book/Ticket may take up to 300s — set a 300s timeout to avoid financial loss.
//   All other methods (Search/FareQuote/SSR/GetBookingDetails) → 60s.
export const TBO_BOOK_TIMEOUT_MS = 300_000;
export const TBO_DEFAULT_TIMEOUT_MS = 60_000;

// Search & Book URL Validation (CLAUDE.md): TBO splits the Air API across two hosts.
// Production routing (per TBO live endpoints):
//   Search host  → tboapi.travelboutiqueonline.com/AirAPI_V10/AirService.svc
//     Methods: Search, FareRule, FareQuote, SSR, Calendar Fare, Price RBD
//   Book host    → booking.travelboutiqueonline.com/AirAPI_V10/AirService.svc
//     Methods: Book, Ticket, GetBookingDetails, SendChangeRequest, GetChangeRequest, ReleasePNR
//
// The path PREFIX is identical on both hosts (AirAPI_V10/AirService.svc/rest); only the
// host differs, and the host is selected by the `service` arg to tboApiUrl ("air" vs "book").
// Certification/Integration URLs differ from production (TBO support) — flip via env vars
// (TBO_AIR_API_URL / TBO_BOOK_API_URL / TBO_SHARED_API_URL), not code.
export const AIR_SEARCH_SVC = "AirAPI_V10/AirService.svc/rest";
export const AIR_BOOK_SVC = "AirAPI_V10/AirService.svc/rest";

function endOfDayMs(): number {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

interface TokenEntry {
  tokenId: string;
  expiresAt: number;
}

let tokenCache: TokenEntry | null = null;
let refreshPromise: Promise<string> | null = null;
// AgencyId is returned alongside the token in the Authenticate response (Member.AgencyId).
// Some endpoints (e.g. GetAirlineSectorList) require it in the request body, so we cache
// it whenever we authenticate. An explicit env override wins if set.
let agencyIdCache: number | null = null;

/**
 * Returns the base URL for a given TBO service.
 *
 * Priority: explicit env var (e.g. TBO_SHARED_API_URL) → hardcoded PRODUCTION
 * fallback base URL. We never derive from TBO_API_URL via hostname surgery — that
 * silently dropped path segments (e.g. "/SharedAPI") and the protocol, which sent
 * auth to the wrong host when the env var was absent.
 *
 * TBO base URLs per service (production):
 *   shared → https://api.travelboutiqueonline.com/SharedAPI   (+ /SharedData.svc/rest/...)
 *   air    → https://tboapi.travelboutiqueonline.com          (+ /AirAPI_V10/AirService.svc/rest/...)
 *   book   → https://booking.travelboutiqueonline.com         (+ /AirAPI_V10/AirService.svc/rest/...)
 *   hotel  → https://api.tektravels.com                       (+ /HotelAPI/...)
 *
 * The fallbacks ARE production, so even with no env var set the codebase can never
 * reach a certification/test host. Flip cert↔prod by setting the env vars.
 */
function getServiceBaseUrl(envKey: string, fallbackBaseUrl: string): string {
  const explicit = process.env[envKey];
  return (explicit || fallbackBaseUrl).replace(/\/$/, "");
}

export function tboApiUrl(
  path: string,
  service: "shared" | "air" | "book" | "hotel" = "air",
): string {
  const cleanPath = path.replace(/^\//, "");
  const baseUrl =
    service === "shared"
      ? getServiceBaseUrl("TBO_SHARED_API_URL", "https://api.travelboutiqueonline.com/SharedAPI")
      : service === "hotel"
        ? getServiceBaseUrl("TBO_HOTEL_API_URL", "https://api.tektravels.com")
        : service === "book"
          ? getServiceBaseUrl("TBO_BOOK_API_URL", "https://booking.travelboutiqueonline.com")
          : getServiceBaseUrl("TBO_AIR_API_URL", "https://tboapi.travelboutiqueonline.com");
  return `${baseUrl}/${cleanPath}`;
}

function maskToken(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "<empty>";
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}***${value.slice(-2)}`;
}

async function authenticate(): Promise<string> {
  const userName = process.env.TBO_USER_NAME;
  const password = process.env.TBO_PASSWORD;
  const endUserIp = process.env.TBO_END_USER_IP ?? "1.1.1.1";
  const clientId = process.env.TBO_CLIENT_ID ?? "ApiIntegrationNew";

  if (!userName || !password) {
    throw new Error(
      "TBO credentials not configured. Set TBO_USER_NAME and TBO_PASSWORD in .env.local",
    );
  }

  // Per TBO B2B docs: auth endpoint is /SharedServices/SharedData.svc/rest/Authenticate
  const url = tboApiUrl("SharedData.svc/rest/Authenticate", "shared");
  const body = {
    ClientId: clientId,
    UserName: userName,
    Password: password,
    EndUserIp: endUserIp,
  };

  logRequest("Authenticate", url, { ...body, Password: "***" });

  let res: Response;
  try {
    res = await tboFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch (err) {
    logError("Authenticate", err);
    throw new Error(
      `TBO auth network error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const text = await res.text();

  if (!res.ok) {
    logError("Authenticate", new Error(`HTTP ${res.status}`), {
      status: res.status,
      bodyPreview: text.slice(0, 500),
    });
    throw new Error(`TBO auth HTTP ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  }

  let data: TboAuthResponse;
  try {
    data = JSON.parse(text);
  } catch {
    logError("Authenticate", new Error("non-JSON response"), {
      status: res.status,
      bodyPreview: text.slice(0, 500),
    });
    throw new Error(
      `TBO auth returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`,
    );
  }

  logResponse("Authenticate", res.status, {
    ...data,
    TokenId: maskToken(data.TokenId),
  });

  if (data.Status !== 1) {
    throw new Error(
      `TBO auth returned non-success Status (expected 1, got ${data.Status ?? "undefined"})`,
    );
  }

  assertTboSuccess(data.Error);

  if (!data.TokenId) {
    throw new Error("TBO auth response missing TokenId");
  }

  tokenCache = { tokenId: data.TokenId, expiresAt: endOfDayMs() };
  if (typeof data.Member?.AgencyId === "number") {
    agencyIdCache = data.Member.AgencyId;
  }
  return data.TokenId;
}

/**
 * Returns the agency id for the authenticated account. Prefers the TBO_AGENCY_ID
 * env override; otherwise ensures we have a token (which populates the cache from
 * the Authenticate response's Member.AgencyId).
 */
export async function getTboAgencyId(): Promise<number> {
  const override = process.env.TBO_AGENCY_ID;
  if (override && override.trim().length > 0) return Number(override);
  await getTboToken();
  if (agencyIdCache == null) {
    throw new Error("TBO AgencyId unavailable: not present in Authenticate response and TBO_AGENCY_ID not set");
  }
  return agencyIdCache;
}

export async function getTboToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt - Date.now() > TOKEN_RENEW_BUFFER_MS) {
    return tokenCache.tokenId;
  }

  if (refreshPromise) return refreshPromise;

  refreshPromise = authenticate().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

export function clearTokenCache(): void {
  tokenCache = null;
  refreshPromise = null;
}

export async function withRetry<T>(fn: (token: string) => Promise<T>): Promise<T> {
  const token = await getTboToken();
  try {
    return await fn(token);
  } catch (err) {
    if (err instanceof TboInvalidSessionError) {
      clearTokenCache();
      const freshToken = await getTboToken();
      return fn(freshToken);
    }
    throw err;
  }
}

export function tboBase(token: string): { TokenId: string; EndUserIp: string } {
  return {
    TokenId: token,
    EndUserIp: process.env.TBO_END_USER_IP ?? "1.1.1.1",
  };
}
