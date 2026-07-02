import { withRetry, tboBase, tboApiUrl, tboFetch, TBO_DEFAULT_TIMEOUT_MS, AIR_BOOK_SVC } from "../auth";
import { assertTboSuccess, TboFareExpiredError } from "../errors";
import { getTrace } from "../traceCache";
import { logRequest, logResponse, logError } from "../log";
import type { TboFareRuleResponse } from "../types";

export interface FareRuleResult {
  origin: string;
  destination: string;
  airline: string;
  fareBasis: string;
  detail: string;         // raw text from TBO, rendered as-is in the UI
  restriction: string;
}

export async function tboGetFareRule(
  resultIndex: string,
  explicitTraceId?: string,
): Promise<FareRuleResult[]> {
  const traceId = explicitTraceId ?? getTrace(resultIndex);
  if (!traceId) throw new TboFareExpiredError();

  return withRetry(async (token) => {
    const url = tboApiUrl(`${AIR_BOOK_SVC}/FareRule`);
    const body = { ...tboBase(token), ResultIndex: resultIndex, TraceId: traceId };
    logRequest("Flight FareRule", url, { ...body, TokenId: "***" });

    let res: Response;
    try {
      res = await tboFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TBO_DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      logError("Flight FareRule", err);
      throw err;
    }

    const text = await res.text();
    let data: TboFareRuleResponse;
    try { data = JSON.parse(text); }
    catch { throw new Error(`TBO FareRule non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`); }

    logResponse("Flight FareRule", res.status, data);
    if (!res.ok) throw new Error(`TBO FareRule HTTP ${res.status}`);
    assertTboSuccess(data.Response?.Error);

    return (data.Response?.FareRules ?? []).map((r) => ({
      origin: r.Origin,
      destination: r.Destination,
      airline: r.Airline,
      fareBasis: r.FareBasisCode,   // TBO field is FareBasisCode not FareBasis
      detail: r.FareRuleDetail ?? "",
      restriction: r.FareRestriction ?? "",
    }));
  });
}
