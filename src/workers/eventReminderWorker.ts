import { env } from "../config/env";
import { EventListingModel } from "../models/partner/EventListing";
import { EventBookingModel } from "../models/EventBooking";
import { sendEventReminder } from "../services/eventNotifications";
import { logger } from "../lib/logger";

// Event reminder worker. Same setInterval pattern as the other workers (no cron
// dependency). Opt-in via EVENT_REMINDERS_ENABLED so non-prod envs never email.
// Each cycle finds published events starting within the lead window and emails a
// one-time reminder to every confirmed booking (de-duped via reminderSentAt).

let timer: NodeJS.Timeout | null = null;
let running = false;

async function runOnce(): Promise<void> {
  if (running) return; // prevent overlap on slow ticks
  running = true;
  try {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + env.eventReminderLeadHours * 3_600_000);

    // Events that start between now and the lead window (i.e. ~24h out).
    const events = await EventListingModel.find({
      status: "published",
      startDate: { $gt: now, $lte: windowEnd },
    }).select("title startDate venue eventType");

    let sent = 0;
    for (const event of events) {
      const bookings = await EventBookingModel.find({
        event: event._id,
        status: "confirmed",
        reminderSentAt: { $exists: false },
      });
      for (const booking of bookings) {
        try {
          const delivered = await sendEventReminder(booking, event);
          // Mark as reminded even if the user had no email, so we don't re-scan it.
          booking.reminderSentAt = new Date();
          await booking.save();
          if (delivered) sent += 1;
        } catch (err) {
          logger.warn(
            { event: "event_reminder_item_failed", booking: booking.bookingReference, error: err instanceof Error ? err.message : String(err) },
            "Event reminder failed for one booking",
          );
        }
      }
    }
    if (sent > 0) logger.info({ event: "event_reminders_done", sent, scanned: events.length }, "Event reminder cycle complete");
  } catch (err) {
    logger.warn(
      { event: "event_reminder_cycle_failed", error: err instanceof Error ? err.message : String(err) },
      "Event reminder cycle failed — will retry next tick",
    );
  } finally {
    running = false;
  }
}

export function startEventReminderWorker(): void {
  if (!env.eventRemindersEnabled) return; // opt-in master switch
  if (timer) return;
  timer = setInterval(() => void runOnce(), env.eventReminderIntervalMs);
  timer.unref?.();
  logger.info(
    { event: "event_reminder_worker_started", intervalMs: env.eventReminderIntervalMs, leadHours: env.eventReminderLeadHours },
    "Event reminder worker started",
  );
}
