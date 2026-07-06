import { tboBookFlight, type BookingPassenger } from "./book";
import { tboIssueTicket } from "./ticket";
import { pollFlightBookingDetail, type BookingStatus } from "./booking";
import { TboPriceChangedError, TboPartialBookingError } from "../errors";
import type { TboFareBreakdown } from "../types";
import type { BookingValidationContext } from "./validation";

// ─────────────────────────────────────────────────────────────────────────────
// Server-side flight booking orchestrator.
//
// Runs the full Book → Ticket flow (LCC issues Ticket directly; Non-LCC Books then
// Tickets), including the domestic-return dual-PNR case. It is called ONLY after a
// Razorpay payment has been verified, so there are no interactive prompts: the
// customer already accepted the FareQuote price before paying. Any fare change
// reported by TBO at Book/Ticket is therefore a price the customer never saw — we
// throw TboPriceChangedError and the caller refunds.
// ─────────────────────────────────────────────────────────────────────────────

export interface IssueFlightInput {
  isLCC: boolean;
  resultIndex: string;
  traceId?: string;
  fareBreakdown: TboFareBreakdown[];
  passengers: BookingPassenger[];
  contactEmail: string;
  contactPhone: string;
  validation?: Omit<BookingValidationContext, "stage" | "contactPhone">;
  isMealMandatory?: boolean;
  isSeatMandatory?: boolean;
  preferredCurrency?: string;
  // Domestic return dual-PNR.
  returnResultIndex?: string;
  returnTraceId?: string;
  returnFareBreakdown?: TboFareBreakdown[];
}

export interface IssueFlightOutput {
  pnr: string;
  bookingId: number;
  ticketNumbers: string[];
  bookingStatus: BookingStatus;
  returnPnr?: string;
  returnBookingId?: number;
}

export async function issueFlightBooking(input: IssueFlightInput): Promise<IssueFlightOutput> {
  return input.isLCC ? issueLcc(input) : issueNonLcc(input);
}

// ─── LCC: Ticket directly (no Book step) ───────────────────────────────────────

async function issueLcc(input: IssueFlightInput): Promise<IssueFlightOutput> {
  const lcc = (resultIndex: string, traceId: string | undefined, fb: TboFareBreakdown[]) =>
    tboIssueTicket({
      isLCC: true,
      resultIndex,
      traceId,
      fareBreakdown: fb,
      passengers: input.passengers,
      contactEmail: input.contactEmail,
      contactPhone: input.contactPhone,
      preferredCurrency: input.preferredCurrency ?? "INR",
      isMealMandatory: input.isMealMandatory,
      isSeatMandatory: input.isSeatMandatory,
      validation: input.validation,
    });

  const ob = await lcc(input.resultIndex, input.traceId, input.fareBreakdown);
  if (ob.isPriceChanged) throw new TboPriceChangedError("Outbound fare changed after payment.");
  if (!ob.bookingId) throw new Error("Ticket did not return a booking reference.");

  const detail = await pollFlightBookingDetail(ob.bookingId, ob.pnr || undefined);
  const issued = { pnr: ob.pnr || detail.pnr, bookingId: ob.bookingId, ticketNumbers: ob.ticketNumbers };

  let returnPnr: string | undefined;
  let returnBookingId: number | undefined;
  if (input.returnResultIndex) {
    // OB ticket is now real money. Any inbound failure must NOT trigger a blanket
    // refund — surface a partial-booking error for manual reconciliation instead.
    try {
      const ib = await lcc(
        input.returnResultIndex,
        input.returnTraceId ?? input.traceId,
        input.returnFareBreakdown ?? input.fareBreakdown,
      );
      if (ib.isPriceChanged) throw new TboPriceChangedError("Inbound fare changed after payment.");
      returnPnr = ib.pnr;
      returnBookingId = ib.bookingId;
    } catch (e) {
      throw new TboPartialBookingError(issued, e instanceof Error ? e.message : String(e));
    }
  }

  return {
    pnr: issued.pnr,
    bookingId: ob.bookingId,
    ticketNumbers: ob.ticketNumbers,
    bookingStatus: detail.bookingStatus,
    returnPnr,
    returnBookingId,
  };
}

// ─── Non-LCC: Book then Ticket ─────────────────────────────────────────────────

async function issueNonLcc(input: IssueFlightInput): Promise<IssueFlightOutput> {
  const book = (resultIndex: string, traceId: string | undefined, fb: TboFareBreakdown[]) =>
    tboBookFlight({
      resultIndex,
      traceId,
      fareBreakdown: fb,
      passengers: input.passengers,
      contactEmail: input.contactEmail,
      contactPhone: input.contactPhone,
      validation: input.validation,
    });

  // Book both legs first — a price change here means the fare is no longer what
  // the customer paid, so bail before any ticket is issued.
  const obBook = await book(input.resultIndex, input.traceId, input.fareBreakdown);
  if (obBook.isPriceChanged) throw new TboPriceChangedError("Outbound fare changed after payment.");

  let ibBook: Awaited<ReturnType<typeof book>> | undefined;
  if (input.returnResultIndex) {
    ibBook = await book(
      input.returnResultIndex,
      input.returnTraceId ?? input.traceId,
      input.returnFareBreakdown ?? input.fareBreakdown,
    );
    if (ibBook.isPriceChanged) throw new TboPriceChangedError("Inbound fare changed after payment.");
  }

  // Ticket the outbound leg.
  const obTicket = await tboIssueTicket({ isLCC: false, bookingId: obBook.bookingId, pnr: obBook.pnr });
  if (obTicket.isPriceChanged) throw new TboPriceChangedError("Outbound fare changed at ticketing.");
  const detail = await pollFlightBookingDetail(obBook.bookingId, obBook.pnr || undefined);
  const issued = { pnr: obTicket.pnr || detail.pnr, bookingId: obBook.bookingId, ticketNumbers: obTicket.ticketNumbers };

  let returnPnr: string | undefined;
  let returnBookingId: number | undefined;
  if (ibBook) {
    // OB ticket is issued (real money). An inbound ticketing failure must surface
    // as a partial booking for reconciliation, NOT a full auto-refund.
    try {
      const ibTicket = await tboIssueTicket({ isLCC: false, bookingId: ibBook.bookingId, pnr: ibBook.pnr });
      if (ibTicket.isPriceChanged) throw new TboPriceChangedError("Inbound fare changed at ticketing.");
      returnPnr = ibTicket.pnr || ibBook.pnr;
      returnBookingId = ibBook.bookingId;
    } catch (e) {
      throw new TboPartialBookingError(issued, e instanceof Error ? e.message : String(e));
    }
  }

  return {
    pnr: issued.pnr,
    bookingId: obBook.bookingId,
    ticketNumbers: obTicket.ticketNumbers,
    bookingStatus: detail.bookingStatus,
    returnPnr,
    returnBookingId,
  };
}
