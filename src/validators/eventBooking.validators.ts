import { HttpError } from "../middleware/error";

// Validates the customer booking-initiation payload. The client sends ONLY ticket
// selections ({ ticketTypeId, quantity }) and attendee details — never prices.
// The controller looks up authoritative prices from EventListing.tickets.

export interface BookingTicketSelection {
  ticketTypeId: string;
  quantity: number;
}

export interface BookingAttendeeInput {
  name: string;
  email?: string;
  phone?: string;
  age?: number;
}

export interface ValidatedBookingInput {
  tickets: BookingTicketSelection[];
  attendees: BookingAttendeeInput[];
}

function fail(msg: string): never {
  throw new HttpError(400, `booking: ${msg}`);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function validateBookingInput(body: unknown): ValidatedBookingInput {
  if (!isObject(body)) fail("request body is required");

  const rawTickets = (body as Record<string, unknown>).tickets;
  if (!Array.isArray(rawTickets) || rawTickets.length === 0) {
    fail("at least one ticket selection is required");
  }

  const tickets: BookingTicketSelection[] = (rawTickets as unknown[]).map((t) => {
    if (!isObject(t)) fail("each ticket selection must be an object");
    const ticketTypeId = t.ticketTypeId;
    if (typeof ticketTypeId !== "string" || ticketTypeId.trim().length === 0) {
      fail("ticketTypeId is required for each selection");
    }
    const quantity = typeof t.quantity === "number" ? t.quantity : Number(t.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      fail("quantity must be a positive integer");
    }
    return { ticketTypeId: (ticketTypeId as string).trim(), quantity };
  });

  // Reject duplicate ticketTypeIds — the client should aggregate quantities.
  const seen = new Set<string>();
  for (const t of tickets) {
    if (seen.has(t.ticketTypeId)) fail(`duplicate ticketTypeId "${t.ticketTypeId}" — combine into one selection`);
    seen.add(t.ticketTypeId);
  }

  const rawAttendees = (body as Record<string, unknown>).attendees;
  const attendees: BookingAttendeeInput[] = Array.isArray(rawAttendees)
    ? (rawAttendees as unknown[]).map((a) => {
        if (!isObject(a)) fail("each attendee must be an object");
        const name = a.name;
        if (typeof name !== "string" || name.trim().length === 0) fail("attendee name is required");
        const age = a.age === undefined || a.age === null || a.age === "" ? undefined : Number(a.age);
        if (age !== undefined && (!Number.isFinite(age) || age < 0)) fail("attendee age must be a non-negative number");
        return {
          name: (name as string).trim(),
          email: typeof a.email === "string" ? a.email.trim().toLowerCase() : undefined,
          phone: typeof a.phone === "string" ? a.phone.trim() : undefined,
          age,
        };
      })
    : [];

  return { tickets, attendees };
}
