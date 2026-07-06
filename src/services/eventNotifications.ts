import { sendMail } from "../lib/mailer";
import { UserModel } from "../models/User";
import { logger } from "../lib/logger";
import type { EventBookingDoc } from "../models/EventBooking";
import type { EventListingDoc } from "../models/partner/EventListing";

// Event-module transactional emails. Every function is fire-and-forget by
// contract: failures are logged, never thrown, so a flaky mailer can never block
// a booking/cancellation. Uses the existing mailer (console transport when SMTP
// is unset), matching the rest of the app.

function fmtDate(d?: Date): string | undefined {
  if (!d) return undefined;
  return d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
}

function fmtVenue(event: EventListingDoc): string | undefined {
  const v = event.venue;
  if (!v) return event.eventType === "virtual" ? "Online" : undefined;
  return [v.name, v.city].filter(Boolean).join(", ") || undefined;
}

function ticketSummary(booking: EventBookingDoc): string {
  return booking.tickets.map((t) => `${t.quantity}× ${t.ticketName}`).join(", ");
}

async function customerOf(booking: EventBookingDoc): Promise<{ name?: string; email?: string } | null> {
  const user = await UserModel.findById(booking.user).select("name email").lean();
  if (!user?.email) return null;
  return { name: user.name, email: user.email };
}

async function partnerEmailOf(event: EventListingDoc): Promise<{ name?: string; email?: string } | null> {
  if (event.organizer?.email) return { name: event.organizer.name, email: event.organizer.email };
  const user = await UserModel.findById(event.partner).select("name email").lean();
  if (!user?.email) return null;
  return { name: user.name, email: user.email };
}

function swallow(scenario: string): (err: unknown) => void {
  return (err) =>
    logger.warn(
      { event: "event_email_failed", scenario, error: err instanceof Error ? err.message : String(err) },
      "Event notification email failed",
    );
}

export async function notifyBookingConfirmed(booking: EventBookingDoc, event: EventListingDoc): Promise<void> {
  try {
    const customer = await customerOf(booking);
    if (customer?.email) {
      await sendMail({
        to: customer.email,
        subject: `Booking confirmed — ${event.title}`,
        template: "eventBookingConfirmed",
        data: {
          name: customer.name,
          eventTitle: event.title,
          startDate: fmtDate(event.startDate),
          venue: fmtVenue(event),
          tickets: ticketSummary(booking),
          bookingReference: booking.bookingReference,
          totalAmount: booking.totalAmount,
        },
      });
    }
    const partner = await partnerEmailOf(event);
    if (partner?.email) {
      await sendMail({
        to: partner.email,
        subject: `New booking — ${event.title}`,
        template: "eventPartnerNewBooking",
        data: {
          name: partner.name,
          eventTitle: event.title,
          bookingReference: booking.bookingReference,
          tickets: ticketSummary(booking),
          totalAmount: booking.totalAmount,
        },
      });
    }
  } catch (err) {
    swallow("bookingConfirmed")(err);
  }
}

export async function notifyBookingCancelled(booking: EventBookingDoc, event: EventListingDoc): Promise<void> {
  try {
    const customer = await customerOf(booking);
    if (customer?.email) {
      await sendMail({
        to: customer.email,
        subject: `Booking cancelled — ${event.title}`,
        template: "eventBookingCancelled",
        data: {
          name: customer.name,
          eventTitle: event.title,
          bookingReference: booking.bookingReference,
          refundAmount: booking.refundAmount ?? 0,
        },
      });
    }
    const partner = await partnerEmailOf(event);
    if (partner?.email) {
      await sendMail({
        to: partner.email,
        subject: `Booking cancelled — ${event.title}`,
        template: "eventPartnerBookingCancelled",
        data: {
          name: partner.name,
          eventTitle: event.title,
          bookingReference: booking.bookingReference,
          tickets: ticketSummary(booking),
        },
      });
    }
  } catch (err) {
    swallow("bookingCancelled")(err);
  }
}

export async function sendEventReminder(booking: EventBookingDoc, event: EventListingDoc): Promise<boolean> {
  const customer = await customerOf(booking);
  if (!customer?.email) return false;
  await sendMail({
    to: customer.email,
    subject: `Reminder — ${event.title} is coming up`,
    template: "eventReminder",
    data: {
      name: customer.name,
      eventTitle: event.title,
      startDate: fmtDate(event.startDate),
      venue: fmtVenue(event),
      bookingReference: booking.bookingReference,
    },
  });
  return true;
}

export async function notifyEventUpdated(booking: EventBookingDoc, event: EventListingDoc, changes: string): Promise<void> {
  try {
    const customer = await customerOf(booking);
    if (!customer?.email) return;
    await sendMail({
      to: customer.email,
      subject: `Update for ${event.title}`,
      template: "eventUpdated",
      data: { name: customer.name, eventTitle: event.title, bookingReference: booking.bookingReference, changes },
    });
  } catch (err) {
    swallow("eventUpdated")(err);
  }
}
