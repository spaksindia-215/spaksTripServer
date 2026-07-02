import type { Request, Response } from "express";
import { tboSearchFlights, type TboFlightSearchInput } from "../integrations/tbo/flight/search";
import { tboFareQuote } from "../integrations/tbo/flight/fareQuote";
import { tboGetFareRule } from "../integrations/tbo/flight/fareRule";
import { tboGetSSR } from "../integrations/tbo/flight/ssr";
import { tboBookFlight, type TboBookFlightInput } from "../integrations/tbo/flight/book";
import { tboIssueTicket, type LccTicketInput, type NonLccTicketInput } from "../integrations/tbo/flight/ticket";
import { pollFlightBookingDetail, tboGetFlightBookingDetail } from "../integrations/tbo/flight/booking";
import { tboGetCalendarFare, tboUpdateCalendarFareOfDay } from "../integrations/tbo/flight/calendarFare";
import { issueFlightBooking, type IssueFlightInput } from "../integrations/tbo/flight/issue";
import {
  TboNoResultsError,
  TboError,
  TboFareExpiredError,
  TboValidationError,
  TboBookingFailedError,
  TboPriceChangedError,
  TboPartialBookingError,
  isDuplicateBookingError,
} from "../integrations/tbo/errors";
import { logError } from "../integrations/tbo/log";
import type { TboFareBreakdown } from "../integrations/tbo/types";
import { createOrder, verifySignature, initiateRefund, fetchPayment } from "../integrations/tbo/payments/razorpay";
import { getPaymentDb } from "../integrations/tbo/payments/db";
import { sendFlightConfirmation } from "../integrations/tbo/payments/mailer";
import { buildFarePricer, buildTwoTierPricing, type TwoTierPricing } from "../lib/tboMarkup";
import { signPriceToken, verifyPriceToken } from "../lib/priceToken";
import { recordSubdomainBooking } from "../services/subdomainBooking";
import { recordCustomerBooking } from "../services/customerBooking";
import { resolveOptionalUser } from "../middleware/auth";

// ─── Helpers ───────────────────────────────────────────────────────────────────

function fail(res: Response, message: string, status: number, extra?: Record<string, unknown>): void {
  res.status(status).json({ success: false, error: message, ...extra });
}

function ts() {
  return new Date().toISOString();
}

// Razorpay SDK rejects with a plain object ({ statusCode, error: { code, description }}),
// so String(e) is "[object Object]". Extract the real reason for logs/diagnostics.
function rzpErrMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object") {
    const o = e as { error?: { description?: string; reason?: string; code?: string }; message?: string };
    return o.error?.description || o.error?.reason || o.error?.code || o.message || JSON.stringify(o);
  }
  return String(e);
}

function qstr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

// Express 5 types route params as string | string[]; our routes use single :id
// segments, so collapse to a single string.
function pstr(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

function tboFareFrom(fareBreakdown: TboFareBreakdown[], extra?: TboFareBreakdown[]): number {
  const sum = (fbd: TboFareBreakdown[]) =>
    fbd.reduce((acc, bd) => acc + bd.BaseFare + bd.Tax + bd.YQTax, 0);
  return sum(fareBreakdown) + (extra ? sum(extra) : 0);
}

const DUPLICATE_MSG =
  "This flight was already booked with these details recently. Please wait 5 days or change the journey/passenger details.";

// ─── Search ────────────────────────────────────────────────────────────────────

export async function searchFlights(req: Request, res: Response): Promise<void> {
  let body: TboFlightSearchInput | null = null;
  try {
    body = req.body as TboFlightSearchInput;
    console.log("[API /api/flights/search] payload:", JSON.stringify(body));

    if (!body?.from || !body?.to || !body?.date) return fail(res, "from, to, and date are required.", 400);
    if (body.from === body.to) return fail(res, "Origin and destination must be different.", 400);
    if (typeof body.adults !== "number" || body.adults < 1) return fail(res, "adults must be a number >= 1.", 400);

    if (!/^\d{4}-\d{2}-\d{2}/.test(body.date)) return fail(res, "Invalid date format. Use yyyy-MM-dd.", 400);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const dep = new Date(`${body.date}T00:00:00`);
    if (Number.isNaN(dep.getTime())) return fail(res, "Invalid departure date.", 400);
    if (dep < today) return fail(res, "Departure date cannot be before today.", 400);

    const returnDate = (body as { returnDate?: string }).returnDate;
    if (returnDate) {
      const ret = new Date(`${returnDate}T00:00:00`);
      if (Number.isNaN(ret.getTime())) return fail(res, "Invalid return date.", 400);
      if (ret < dep) return fail(res, "Return date cannot be before departure date.", 400);
    }

    const totalPax = (body.adults ?? 0) + (body.children ?? 0) + (body.infants ?? 0);
    if (totalPax > 9) return fail(res, "Total passenger count cannot be more than 9.", 400);
    if ((body.infants ?? 0) > (body.adults ?? 0)) {
      return fail(res, "Number of infants cannot exceed number of adults.", 400);
    }

    const result = await tboSearchFlights(body);

    const priceFlight = await buildFarePricer("flights", req);
    for (const offer of result.offers) {
      offer.basePrice = priceFlight(offer.basePrice);
    }
    const prices = result.offers.map((o) => o.basePrice).filter((p) => p > 0);
    result.minPrice = prices.length ? Math.min(...prices) : 0;
    result.maxPrice = prices.length ? Math.max(...prices) : 0;

    res.json({ success: true, data: result });
  } catch (e) {
    const stack = e instanceof Error ? e.stack : String(e);
    console.error("[API /api/flights/search] FAILED");
    console.error("  payload:", JSON.stringify(body));
    console.error("  stack:", stack);

    if (e instanceof TboNoResultsError) return fail(res, "No flights found for the selected criteria.", 404);
    if (e instanceof TboError) return fail(res, `TBO error (${e.code}): ${e.message}`, 502);
    return fail(res, e instanceof Error ? e.message : "Flight search failed", 500);
  }
}

// ─── FareQuote ───────────────────────────────────────────────────────────────────

export async function fareQuote(req: Request, res: Response): Promise<void> {
  try {
    const id = pstr(req.params.id);
    if (!id) return fail(res, "id (ResultIndex) is required.", 400);

    const traceId = qstr(req.query.traceId);
    const returnId = qstr(req.query.returnId);
    const resultIndex = returnId
      ? `${decodeURIComponent(id)},${decodeURIComponent(returnId)}`
      : decodeURIComponent(id);

    const result = await tboFareQuote(resultIndex, traceId);

    const priceFlight = await buildFarePricer("flights", req);
    result.totalFare = priceFlight(result.totalFare);
    if (result.updatedOffer) {
      result.updatedOffer.basePrice = priceFlight(result.updatedOffer.basePrice);
    }

    // Signed price token binding the server-quoted supplier fare (the FLOOR the
    // order amount must clear) → verified at create-order. Empty when
    // PRICE_TOKEN_SECRET is unset (feature off).
    const rawFarePaise = Math.round(
      result.fareBreakdown.reduce((acc, b) => acc + b.BaseFare + b.Tax + b.YQTax, 0) * 100,
    );
    const priceToken = signPriceToken(resultIndex, rawFarePaise);

    res.json({ success: true, data: { ...result, priceToken } });
  } catch (e) {
    if (e instanceof TboFareExpiredError) return fail(res, "Fare has expired. Please search again.", 410);
    return fail(res, e instanceof Error ? e.message : "FareQuote failed", 500);
  }
}

// ─── FareRule ────────────────────────────────────────────────────────────────────

export async function fareRule(req: Request, res: Response): Promise<void> {
  try {
    const id = pstr(req.params.id);
    if (!id) return fail(res, "id (ResultIndex) is required.", 400);
    const traceId = qstr(req.query.traceId);
    const rules = await tboGetFareRule(decodeURIComponent(id), traceId);
    res.json({ success: true, data: rules });
  } catch (e) {
    if (e instanceof TboFareExpiredError) return fail(res, "Fare has expired. Please search again.", 410);
    return fail(res, e instanceof Error ? e.message : "FareRule fetch failed", 500);
  }
}

// ─── SSR ─────────────────────────────────────────────────────────────────────────

export async function ssr(req: Request, res: Response): Promise<void> {
  try {
    const id = pstr(req.params.id);
    if (!id) return fail(res, "id (ResultIndex) is required.", 400);
    const traceId = qstr(req.query.traceId);
    const result = await tboGetSSR(decodeURIComponent(id), traceId);
    res.json({ success: true, data: result });
  } catch (e) {
    if (e instanceof TboFareExpiredError) return fail(res, "Fare has expired. Please search again.", 410);
    return fail(res, e instanceof Error ? e.message : "SSR fetch failed", 500);
  }
}

// ─── Book (non-LCC) ────────────────────────────────────────────────────────────

export async function book(req: Request, res: Response): Promise<void> {
  try {
    const body: TboBookFlightInput & {
      returnResultIndex?: string;
      returnTraceId?: string;
      returnFareBreakdown?: TboBookFlightInput["fareBreakdown"];
    } = req.body;

    if (!body?.resultIndex) return fail(res, "resultIndex is required.", 400);
    if (!body?.passengers?.length) return fail(res, "At least one passenger is required.", 400);
    if (!body?.contactEmail) return fail(res, "contactEmail is required.", 400);
    if (!body?.fareBreakdown?.length) return fail(res, "fareBreakdown is required (from FareQuote response).", 400);

    const obResult = await tboBookFlight(body);

    if (body.returnResultIndex) {
      const ibResult = await tboBookFlight({
        ...body,
        resultIndex: body.returnResultIndex,
        traceId: body.returnTraceId ?? body.traceId,
        fareBreakdown: body.returnFareBreakdown ?? body.fareBreakdown,
      });
      res.json({
        success: true,
        data: {
          ...obResult,
          returnLeg: { bookingId: ibResult.bookingId, pnr: ibResult.pnr, isPriceChanged: ibResult.isPriceChanged },
        },
      });
      return;
    }

    res.json({ success: true, data: obResult });
  } catch (e) {
    if (e instanceof TboValidationError) return fail(res, e.message, 422);
    if (e instanceof TboFareExpiredError) return fail(res, "Fare has expired. Please search again.", 410);
    const rawMessage = e instanceof Error ? e.message : "Booking failed";
    if (isDuplicateBookingError(rawMessage)) return fail(res, DUPLICATE_MSG, 409);
    if (e instanceof TboBookingFailedError) return fail(res, e.message, 422);
    return fail(res, rawMessage, 500);
  }
}

// ─── Ticket ──────────────────────────────────────────────────────────────────────

export async function ticket(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body;

    // ── LCC path ──────────────────────────────────────────────────────────────
    if (body?.isLCC === true) {
      if (!body.resultIndex) return fail(res, "resultIndex is required for LCC ticket.", 400);
      if (!body.passengers?.length) return fail(res, "passengers array is required.", 400);
      if (!body.fareBreakdown?.length) return fail(res, "fareBreakdown is required.", 400);
      if (!body.contactEmail) return fail(res, "contactEmail is required.", 400);
      if (!body.contactPhone) return fail(res, "contactPhone is required.", 400);

      const obInput: LccTicketInput = {
        isLCC: true,
        resultIndex: body.resultIndex,
        traceId: body.traceId ?? undefined,
        fareBreakdown: body.fareBreakdown,
        passengers: body.passengers,
        contactEmail: body.contactEmail,
        contactPhone: body.contactPhone,
        preferredCurrency: body.preferredCurrency ?? "INR",
        isMealMandatory: body.isMealMandatory ?? false,
        isSeatMandatory: body.isSeatMandatory ?? false,
        isPriceChangedAccepted: body.isPriceChangedAccepted ?? false,
        validation: body.validation,
      };

      const ticketResult = await tboIssueTicket(obInput);
      if (!ticketResult.bookingId) {
        return fail(res, "Ticket did not return a booking reference. Check your booking queue before retrying to avoid a duplicate.", 502);
      }
      const detail = await pollFlightBookingDetail(ticketResult.bookingId, ticketResult.pnr || undefined);

      let returnLeg: { bookingId: number; pnr: string; isPriceChanged: boolean } | undefined;
      if (body.returnResultIndex) {
        const ibInput: LccTicketInput = {
          ...obInput,
          resultIndex: body.returnResultIndex,
          traceId: body.returnTraceId ?? body.traceId ?? undefined,
          fareBreakdown: body.returnFareBreakdown ?? body.fareBreakdown,
        };
        const ibResult = await tboIssueTicket(ibInput);
        returnLeg = { bookingId: ibResult.bookingId, pnr: ibResult.pnr, isPriceChanged: ibResult.isPriceChanged };
      }

      const agentId = req.get("x-agent-id");
      if (agentId) {
        const rawFare = tboFareFrom(body.fareBreakdown, body.returnFareBreakdown);
        void buildTwoTierPricing(rawFare, "flights", req).then((pricing) => {
          if (pricing) {
            return recordSubdomainBooking({ agentId, productType: "flight", pnr: ticketResult.pnr || detail.pnr, pricing });
          }
        });
      }

      res.json({
        success: true,
        data: {
          bookingId: ticketResult.bookingId,
          pnr: ticketResult.pnr || detail.pnr,
          ticketNumbers: ticketResult.ticketNumbers,
          bookingStatus: detail.bookingStatus,
          isPriceChanged: ticketResult.isPriceChanged,
          isTimeChanged: ticketResult.isTimeChanged,
          ...(returnLeg ? { returnLeg } : {}),
        },
      });
      return;
    }

    // ── Non-LCC path ────────────────────────────────────────────────────────────
    const bookingId = Number(body?.bookingId);
    if (!bookingId || isNaN(bookingId)) return fail(res, "bookingId is required for non-LCC ticket.", 400);

    const obInput: NonLccTicketInput = {
      isLCC: false,
      bookingId,
      pnr: body.pnr || undefined,
      isPriceChangedAccepted: body.isPriceChangedAccepted ?? false,
    };
    const ticketResult = await tboIssueTicket(obInput);
    const detail = await pollFlightBookingDetail(bookingId, ticketResult.pnr || body.pnr || undefined);

    let returnLeg: { bookingId: number; pnr: string; isPriceChanged: boolean } | undefined;
    if (body.returnBookingId) {
      const ibInput: NonLccTicketInput = {
        isLCC: false,
        bookingId: Number(body.returnBookingId),
        pnr: body.returnPnr || undefined,
        isPriceChangedAccepted: body.isPriceChangedAccepted ?? false,
      };
      const ibResult = await tboIssueTicket(ibInput);
      returnLeg = { bookingId: ibResult.bookingId, pnr: ibResult.pnr, isPriceChanged: ibResult.isPriceChanged };
    }

    const agentId = req.get("x-agent-id");
    if (agentId && (body as Record<string, unknown>).fareBreakdown) {
      const fareBreakdown = (body as Record<string, unknown>).fareBreakdown as TboFareBreakdown[];
      const returnFareBreakdown = (body as Record<string, unknown>).returnFareBreakdown as TboFareBreakdown[] | undefined;
      const rawFare = tboFareFrom(fareBreakdown, returnFareBreakdown);
      void buildTwoTierPricing(rawFare, "flights", req).then((pricing) => {
        if (pricing) {
          return recordSubdomainBooking({ agentId, productType: "flight", pnr: ticketResult.pnr || body.pnr || detail.pnr, pricing });
        }
      });
    }

    res.json({
      success: true,
      data: {
        bookingId,
        pnr: ticketResult.pnr || detail.pnr,
        ticketNumbers: ticketResult.ticketNumbers,
        bookingStatus: detail.bookingStatus,
        isPriceChanged: ticketResult.isPriceChanged,
        isTimeChanged: ticketResult.isTimeChanged,
        ...(returnLeg ? { returnLeg } : {}),
      },
    });
  } catch (e) {
    if (e instanceof TboValidationError) return fail(res, e.message, 422);
    if (e instanceof TboFareExpiredError) return fail(res, "Fare has expired. Please search again.", 410);
    const message = e instanceof Error ? e.message : "Ticket issuance failed";
    if (isDuplicateBookingError(message)) return fail(res, DUPLICATE_MSG, 409);
    return fail(res, message, 500);
  }
}

// ─── Booking detail ──────────────────────────────────────────────────────────────

export async function bookingDetail(req: Request, res: Response): Promise<void> {
  try {
    const bookingId = Number(req.params.id);
    if (!bookingId || isNaN(bookingId)) return fail(res, "bookingId must be a number.", 400);
    const pnr = qstr(req.query.pnr) || undefined;
    const result = await tboGetFlightBookingDetail(bookingId, pnr);
    res.json({ success: true, data: result });
  } catch (e) {
    return fail(res, e instanceof Error ? e.message : "GetBookingDetail failed", 500);
  }
}

// ─── Calendar fare ───────────────────────────────────────────────────────────────

export async function calendarFare(req: Request, res: Response): Promise<void> {
  let body: { from?: string; to?: string; cabin?: string; month?: string } | null = null;
  try {
    body = req.body;
    console.log("[API /api/flights/calendar-fare] payload:", JSON.stringify(body));

    if (!body?.from || !body?.to || !body?.month) return fail(res, "from, to, and month are required.", 400);
    if (!/^\d{4}-\d{2}$/.test(body.month)) return fail(res, "month must be in YYYY-MM format.", 400);
    if (body.from === body.to) return fail(res, "Origin and destination must be different.", 400);

    const data = await tboGetCalendarFare({
      from: body.from,
      to: body.to,
      cabin: body.cabin ?? "ECONOMY",
      month: body.month,
    });

    res.json({ success: true, data });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isDomesticOnlyError =
      msg.includes("HTTP 400") || msg.includes("non-JSON") || msg.includes("ErrorCode") || msg.includes("ResponseStatus");
    if (isDomesticOnlyError) {
      console.warn("[API /api/flights/calendar-fare] TBO rejected (likely international route):", msg);
      res.json({ success: true, data: [] });
      return;
    }
    console.error("[API /api/flights/calendar-fare] FAILED");
    console.error("  payload:", JSON.stringify(body));
    console.error("  stack:", e instanceof Error ? e.stack : String(e));
    return fail(res, msg, 500);
  }
}

export async function calendarFareUpdate(req: Request, res: Response): Promise<void> {
  let body: { from?: string; to?: string; cabin?: string; date?: string } | null = null;
  try {
    body = req.body;
    console.log("[API /api/flights/calendar-fare/update] payload:", JSON.stringify(body));

    if (!body?.from || !body?.to || !body?.date) return fail(res, "from, to, and date are required.", 400);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date)) return fail(res, "date must be in YYYY-MM-DD format.", 400);
    if (body.from === body.to) return fail(res, "Origin and destination must be different.", 400);

    const data = await tboUpdateCalendarFareOfDay({
      from: body.from,
      to: body.to,
      cabin: body.cabin ?? "ECONOMY",
      date: body.date,
    });

    res.json({ success: true, data });
  } catch (e) {
    console.error("[API /api/flights/calendar-fare/update] FAILED");
    console.error("  payload:", JSON.stringify(body));
    console.error("  stack:", e instanceof Error ? e.stack : String(e));
    return fail(res, e instanceof Error ? e.message : "Update calendar fare failed", 500);
  }
}

// ─── Razorpay: create order ──────────────────────────────────────────────────────

export async function createPaymentOrder(req: Request, res: Response): Promise<void> {
  try {
    const { amountPaise, clientReferenceId, route, priceToken } = req.body ?? {};

    if (typeof amountPaise !== "number" || amountPaise < 100) {
      return fail(res, "amountPaise must be a number >= 100 (smallest INR unit: paise).", 400);
    }
    if (!clientReferenceId || typeof clientReferenceId !== "string") {
      return fail(res, "clientReferenceId is required.", 400);
    }

    // Anti-tamper: the order amount must clear the signed price floor minted at
    // FareQuote. No-op (skipped) when PRICE_TOKEN_SECRET is unset.
    const priceCheck = verifyPriceToken(
      typeof priceToken === "string" ? priceToken : undefined,
      amountPaise,
    );
    if (!priceCheck.ok) {
      console.error(`\n[RZP ${ts()}] ✗ PRICE TOKEN INVALID (flight)\n  reason: ${priceCheck.reason}\n  amount_paise: ${amountPaise}`);
      return fail(res, "Price verification failed. Please search again for the latest fare.", 409, { priceTokenError: priceCheck.reason });
    }

    console.log(
      `\n[RZP ${ts()}] → CREATE_ORDER (flight)` +
        `\n  receipt: ${clientReferenceId}\n  amount_paise: ${amountPaise}\n  currency: INR\n  route: ${route ?? "unknown"}`,
    );

    const order = await createOrder({
      amountPaise,
      receipt: clientReferenceId,
      notes: { clientReferenceId, product: "flight", route: String(route ?? "") },
    });

    console.log(
      `\n[RZP ${ts()}] ← CREATE_ORDER (flight) [OK]\n  orderId: ${order.id}\n  amount_paise: ${order.amount}\n  currency: ${order.currency}`,
    );

    res.json({ success: true, orderId: order.id, amount: order.amount, currency: order.currency });
  } catch (e) {
    console.error(`\n[RZP ${ts()}] ✗ CREATE_ORDER (flight) FAILED\n  ERROR: ${e instanceof Error ? e.message : String(e)}`);
    return fail(res, "Failed to create payment order. Please try again.", 500);
  }
}

// ─── Razorpay: verify payment → Book/Ticket (lift-and-shift, identical semantics) ─

type PaymentStatus =
  | "payment_verified"
  | "tbo_confirmed"
  | "tbo_failed"
  | "tbo_timeout"
  | "tbo_partial"
  | "refund_initiated"
  | "refunded";

interface FlightPaymentRecord {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  amountPaise: number;
  currency: string;
  clientReferenceId: string;
  status: PaymentStatus;
  pnr?: string | null;
  bookingId?: number | null;
  returnPnr?: string | null;
  returnBookingId?: number | null;
  ticketNumbers?: string[];
  partialPnr?: string | null;
  tboError?: string;
  refundId?: string;
  refundInitiated: boolean;
  agentId?: string;
  pricing?: TwoTierPricing;
  createdAt: Date;
  updatedAt: Date;
}

const COLLECTION = "flight_payment_records";

function isTimeoutError(msg: string): boolean {
  const m = msg.toLowerCase();
  return m.includes("timed out") || m.includes("timeout") || m.includes("aborted") || m.includes("abort");
}

// Idempotent refund: atomically flips refundInitiated false→true so only one
// concurrent caller (or retry) ever reaches Razorpay. The refund amount comes from
// the PERSISTED record (Razorpay-captured amount), never from the client request.
async function tryInitiateRefund(
  paymentId: string,
  clientReferenceId: string,
  db: ReturnType<typeof getPaymentDb>,
): Promise<string | null> {
  const col = db.collection<FlightPaymentRecord>(COLLECTION);
  const matched = await col.findOneAndUpdate(
    { razorpayPaymentId: paymentId, refundInitiated: { $ne: true } },
    { $set: { refundInitiated: true, status: "refund_initiated", updatedAt: new Date() } },
    { returnDocument: "after" },
  );
  if (!matched) {
    console.log(`\n[RZP ${ts()}] REFUND idempotent skip — already initiated\n  paymentId: ${paymentId}`);
    return null;
  }
  try {
    const refund = await initiateRefund({ paymentId, amountPaise: matched.amountPaise, notes: { clientReferenceId, product: "flight" } });
    await col.updateOne(
      { razorpayPaymentId: paymentId },
      { $set: { refundId: refund.id as string, status: "refunded", updatedAt: new Date() } },
    );
    console.log(`\n[RZP ${ts()}] ← INITIATE_REFUND (flight) [OK]\n  refundId: ${refund.id}\n  paymentId: ${paymentId}`);
    return refund.id as string;
  } catch (e) {
    console.error(`\n[RZP ${ts()}] ✗ INITIATE_REFUND (flight) FAILED\n  paymentId: ${paymentId}\n  ERROR: ${rzpErrMsg(e)}`);
    return null;
  }
}

export async function verifyPayment(req: Request, res: Response): Promise<void> {
  let razorpayOrderId: string | undefined;
  let razorpayPaymentId: string | undefined;
  let amountPaise: number | undefined;
  let clientReferenceId: string | undefined;

  try {
    const body = req.body;
    razorpayOrderId = body?.razorpayOrderId;
    razorpayPaymentId = body?.razorpayPaymentId;
    const razorpaySignature: string | undefined = body?.razorpaySignature;
    amountPaise = body?.amountPaise;
    clientReferenceId = body?.clientReferenceId;
    const booking = body?.booking as IssueFlightInput | undefined;

    if (!razorpayOrderId) return fail(res, "razorpayOrderId is required.", 400);
    if (!razorpayPaymentId) return fail(res, "razorpayPaymentId is required.", 400);
    if (!razorpaySignature) return fail(res, "razorpaySignature is required.", 400);
    if (typeof amountPaise !== "number" || amountPaise < 100) return fail(res, "amountPaise must be a number >= 100.", 400);
    if (!clientReferenceId) return fail(res, "clientReferenceId is required.", 400);
    if (!booking?.resultIndex || !booking?.passengers?.length || !booking?.fareBreakdown?.length) {
      return fail(res, "booking payload (resultIndex, passengers, fareBreakdown) is required.", 400);
    }
    if (!booking.contactEmail || !booking.contactPhone) {
      return fail(res, "booking contactEmail and contactPhone are required.", 400);
    }

    const signatureValid = verifySignature(razorpayOrderId, razorpayPaymentId, razorpaySignature);
    console.log(
      `\n[RZP ${ts()}] → VERIFY_SIGNATURE (flight)\n  orderId: ${razorpayOrderId}\n  paymentId: ${razorpayPaymentId}\n  signatureMatch: ${signatureValid}\n  clientRef: ${clientReferenceId}`,
    );
    if (!signatureValid) {
      console.error(`\n[RZP ${ts()}] ✗ SIGNATURE MISMATCH (flight)\n  paymentId: ${razorpayPaymentId}`);
      return fail(
        res,
        "Payment signature verification failed. If any amount was deducted, contact support with your payment ID.",
        400,
        { signatureMismatch: true, razorpayPaymentId },
      );
    }

    const db = getPaymentDb();
    const col = db.collection<FlightPaymentRecord>(COLLECTION);

    const existing = await col.findOne({ razorpayOrderId, razorpayPaymentId });
    if (existing) {
      console.log(`\n[RZP ${ts()}] VERIFY_PAYMENT (flight) idempotent hit\n  paymentId: ${razorpayPaymentId}\n  status: ${existing.status}`);
      if (existing.status === "tbo_confirmed") {
        res.json({
          success: true,
          data: {
            pnr: existing.pnr,
            bookingId: existing.bookingId,
            ticketNumbers: existing.ticketNumbers ?? [],
            ...(existing.returnPnr ? { returnLeg: { pnr: existing.returnPnr, bookingId: existing.returnBookingId } } : {}),
          },
        });
        return;
      }
      if (existing.status === "tbo_timeout") {
        res.status(202).json({
          success: false, tboTimedOut: true, razorpayPaymentId, clientReferenceId,
          error: "Booking request timed out. Your payment was received — we will confirm by email or you can contact support with your reference ID.",
        });
        return;
      }
      if (existing.status === "tbo_partial") {
        res.status(202).json({
          success: false, tboPartial: true, razorpayPaymentId, clientReferenceId,
          partialPnr: existing.partialPnr,
          error: "Your outbound flight is ticketed but the return leg could not be confirmed. Our team will contact you to complete or adjust the return — no extra charge without your consent.",
        });
        return;
      }
      return fail(
        res,
        "Booking failed. " +
          (existing.refundInitiated
            ? "A full refund has been initiated and will reflect in 5-7 business days."
            : "Please contact support with your payment ID: " + razorpayPaymentId),
        422,
        { tboFailed: true, razorpayPaymentId, refundInitiated: existing.refundInitiated, refundId: existing.refundId },
      );
    }

    let capturedPaise = amountPaise;
    try {
      const payment = await fetchPayment(razorpayPaymentId);
      capturedPaise = payment.amountPaise;
      if (payment.orderId && payment.orderId !== razorpayOrderId) {
        console.error(`\n[RZP ${ts()}] ✗ ORDER MISMATCH (flight)\n  payment.order_id: ${payment.orderId}\n  body.orderId: ${razorpayOrderId}`);
        return fail(res, "Payment does not match this order.", 400, { razorpayPaymentId });
      }
      if (capturedPaise !== amountPaise) {
        console.warn(`\n[RZP ${ts()}] ⚠ client amountPaise (${amountPaise}) ≠ captured (${capturedPaise}); using captured.`);
      }
    } catch (e) {
      console.error(`\n[RZP ${ts()}] ⚠ fetchPayment failed; falling back to body amount\n  ERROR: ${e instanceof Error ? e.message : String(e)}`);
    }

    const agentId = req.get("x-agent-id") ?? undefined;
    const rawFare = tboFareFrom(booking.fareBreakdown, booking.returnFareBreakdown);
    const pricing = agentId ? await buildTwoTierPricing(rawFare, "flights", req) : null;

    const now = new Date();
    await col.insertOne({
      razorpayOrderId,
      razorpayPaymentId,
      amountPaise: capturedPaise,
      currency: "INR",
      clientReferenceId,
      status: "payment_verified",
      refundInitiated: false,
      ...(agentId ? { agentId } : {}),
      ...(pricing ? { pricing } : {}),
      createdAt: now,
      updatedAt: now,
    });
    console.log(`\n[RZP ${ts()}] ← VERIFY_SIGNATURE (flight) [OK] — payment record persisted\n  paymentId: ${razorpayPaymentId}`);

    // ── Anti-tamper: captured amount must cover at least the raw supplier fare ──
    // `amountPaise` is chosen by the client at order creation, so a tampered
    // order could charge far less than the real fare. `capturedPaise` is what
    // Razorpay ACTUALLY captured; the raw TBO fare is the hard floor (the
    // customer always pays markup on top). A capture below the fare means the
    // order amount was tampered — refund and abort BEFORE booking with TBO.
    const expectedFloorPaise = Math.round(rawFare * 100);
    const PRICE_TOLERANCE_PAISE = 100; // ₹1 slack for rounding
    if (capturedPaise + PRICE_TOLERANCE_PAISE < expectedFloorPaise) {
      console.error(
        `\n[RZP ${ts()}] ✗ AMOUNT TAMPER (flight)` +
          `\n  capturedPaise: ${capturedPaise}\n  expectedFloorPaise: ${expectedFloorPaise}\n  paymentId: ${razorpayPaymentId}`,
      );
      await col.updateOne(
        { razorpayOrderId, razorpayPaymentId },
        { $set: { status: "tbo_failed", tboError: "amount_below_fare", updatedAt: new Date() } },
      );
      const refundId = await tryInitiateRefund(razorpayPaymentId, clientReferenceId ?? "", db);
      return fail(
        res,
        "Payment amount did not match the fare for this booking. A refund has been initiated and will reflect in 5-7 business days.",
        422,
        { tboFailed: true, reason: "amount_mismatch", razorpayPaymentId, razorpayRefundInitiated: refundId !== null, refundId },
      );
    }

    const result = await issueFlightBooking(booking);

    await col.updateOne(
      { razorpayOrderId, razorpayPaymentId },
      {
        $set: {
          status: "tbo_confirmed",
          pnr: result.pnr,
          bookingId: result.bookingId,
          ticketNumbers: result.ticketNumbers,
          returnPnr: result.returnPnr ?? null,
          returnBookingId: result.returnBookingId ?? null,
          updatedAt: new Date(),
        },
      },
    );

    // Confirmation email (fire-and-forget).
    {
      const passengers = booking.passengers as Array<{ firstName: string; lastName: string; title?: string }>;
      const passengerNames = passengers.map((p) => `${p.title ?? ""} ${p.firstName} ${p.lastName}`.trim());
      const origin = (booking as { validation?: { origin?: string } }).validation?.origin ?? "";
      const destination = (booking as { validation?: { destination?: string } }).validation?.destination ?? "";
      const totalAmount = Math.round(capturedPaise / 100);
      sendFlightConfirmation({
        to: booking.contactEmail,
        pnr: result.pnr,
        bookingReference: clientReferenceId,
        origin,
        destination,
        passengerNames,
        totalAmount,
      }).catch((e: unknown) => console.error("[mailer] flight confirmation email failed:", e instanceof Error ? e.message : String(e)));
    }

    // Settlement attribution (fire-and-forget, in-process).
    if (agentId && pricing) {
      void recordSubdomainBooking({ agentId, productType: "flight", pnr: result.pnr, pricing });
    }

    // Customer dashboard: record the trip so it lands in the customer's history.
    // Logged-in customer → owned immediately; otherwise a guest booking tagged with
    // the contact email, claimed when they register/log in with that same email.
    // Skip agent-subdomain bookings (those are attributed to the agent above).
    if (!agentId) {
      const customer = resolveOptionalUser(req);
      const v = booking.validation;
      void recordCustomerBooking({
        productType: "flight",
        pnr: result.pnr,
        amount: Math.round(capturedPaise / 100),
        details: {
          origin: v?.origin,
          destination: v?.destination,
          passengers: booking.passengers.length,
          airline: v?.airlineCode,
        },
        ...(customer?.role === "customer"
          ? { ownerId: customer.sub, ownerRole: "customer" as const }
          : { claimEmail: booking.contactEmail }),
      });
    }

    res.json({
      success: true,
      data: {
        pnr: result.pnr,
        bookingId: result.bookingId,
        ticketNumbers: result.ticketNumbers,
        bookingStatus: result.bookingStatus,
        ...(result.returnPnr ? { returnLeg: { pnr: result.returnPnr, bookingId: result.returnBookingId } } : {}),
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const timeout = isTimeoutError(msg);
    const priceChanged = e instanceof TboPriceChangedError;
    logError("FLIGHT_VERIFY_PAYMENT", e, { razorpayPaymentId, razorpayOrderId, timeout, priceChanged });

    if (!razorpayPaymentId || !razorpayOrderId || !amountPaise) {
      return fail(res, "Payment verification failed.", 400);
    }

    try {
      const db = getPaymentDb();
      const col = db.collection<FlightPaymentRecord>(COLLECTION);

      if (e instanceof TboPartialBookingError) {
        await col.updateOne(
          { razorpayOrderId, razorpayPaymentId },
          {
            $set: {
              status: "tbo_partial",
              partialPnr: e.issued.pnr,
              bookingId: e.issued.bookingId,
              ticketNumbers: e.issued.ticketNumbers,
              tboError: e.reason,
              updatedAt: new Date(),
            },
          },
        );
        console.error(`\n[RZP ${ts()}] ⚠ FLIGHT PARTIAL BOOKING (outbound ticketed, inbound failed)\n  paymentId: ${razorpayPaymentId}\n  outboundPNR: ${e.issued.pnr}\n  reason: ${e.reason}\n  action: manual_reconciliation (NO auto-refund)`);
        res.status(202).json({
          success: false,
          tboPartial: true,
          razorpayPaymentId,
          clientReferenceId,
          partialPnr: e.issued.pnr,
          error: "Your outbound flight is ticketed but the return leg could not be confirmed. Our team will contact you to complete or adjust the return — no extra charge without your consent.",
        });
        return;
      }

      if (timeout) {
        await col.updateOne(
          { razorpayOrderId, razorpayPaymentId },
          { $set: { status: "tbo_timeout", tboError: msg, updatedAt: new Date() } },
        );
        console.error(`\n[RZP ${ts()}] ✗ FLIGHT BOOKING TIMEOUT\n  paymentId: ${razorpayPaymentId}\n  clientRef: ${clientReferenceId}\n  action: reconcile_via_GetBookingDetails`);
        res.status(202).json({
          success: false, tboTimedOut: true, razorpayPaymentId, clientReferenceId,
          error: "Booking request timed out. Your payment was received — we will confirm by email or you can contact support with reference ID: " + clientReferenceId,
        });
        return;
      }

      await col.updateOne(
        { razorpayOrderId, razorpayPaymentId },
        { $set: { status: "tbo_failed", tboError: msg, updatedAt: new Date() } },
      );
      const refundId = await tryInitiateRefund(razorpayPaymentId, clientReferenceId ?? "", db);
      const reason = priceChanged ? "price_changed" : "booking_failed";
      const userMessage = priceChanged
        ? "The fare changed before your ticket could be issued. A full refund has been initiated and will reflect in 5-7 business days — please search again for the latest price."
        : "Flight booking failed. A full refund has been initiated and will reflect in 5-7 business days.";
      console.error(`\n[RZP ${ts()}] ✗ FLIGHT BOOKING FAILURE\n  reason: ${reason}\n  paymentId: ${razorpayPaymentId}\n  refundInitiated: ${refundId !== null}`);
      res.status(422).json({
        success: false, tboFailed: true, reason, razorpayPaymentId, razorpayRefundInitiated: refundId !== null, refundId, error: userMessage,
      });
    } catch (dbErr) {
      console.error(`\n[RZP ${ts()}] ✗ DB ERROR during failure handling\n  ERROR: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`);
      if (e instanceof TboError) {
        return fail(res, `Booking failed. Please contact support with payment ID: ${razorpayPaymentId}`, 422, { tboFailed: true, razorpayPaymentId, razorpayRefundInitiated: false });
      }
      return fail(res, "An unexpected error occurred. Please contact support.", 500, { razorpayPaymentId });
    }
  }
}
