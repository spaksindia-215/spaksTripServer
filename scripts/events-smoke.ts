// Seed + end-to-end smoke test for the Events module (instruct.md Step 7).
//
// Run from server/:  npm run smoke:events
// (needs MONGO_URI in .env)
//
// Drives the REAL controller functions through lightweight mock req/res objects,
// so it exercises validation, the atomic inventory hold, server-side pricing, QR
// generation, the public merged listing and cancellation/refund — without needing
// a running HTTP server or auth middleware. Razorpay is NOT required: the paid
// path is covered by asserting it fails cleanly when unconfigured, and the happy
// path uses a FREE ticket (which skips Razorpay entirely).
//
// Idempotent: removes its own seeded event + bookings on each run.

import mongoose, { Types } from "mongoose";
import type { Request, Response } from "express";
import { connectDb } from "../src/config/db";
import { UserModel } from "../src/models/User";
import { EventListingModel } from "../src/models/partner/EventListing";
import { EventBookingModel } from "../src/models/EventBooking";
import {
  createEvent,
  listMyEvents,
  initiateBooking,
  listEvents,
  getEventBySlug,
  cancelBooking,
} from "../src/controllers/events.controller";

// ── Tiny test harness ────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}${detail !== undefined ? `  →  ${JSON.stringify(detail)}` : ""}`);
  }
}

// Captured controller outcome: either a JSON response (status + body) or the
// error passed to next().
interface Outcome {
  status: number;
  body: unknown;
  error?: { status?: number; message?: string };
}

function mockReq(opts: {
  user?: { sub: string; role: string; email: string };
  params?: Record<string, string>;
  body?: unknown;
  query?: Record<string, unknown>;
}): Request {
  const headers: Record<string, string> = {};
  return {
    user: opts.user,
    params: opts.params ?? {},
    body: opts.body ?? {},
    query: opts.query ?? {},
    ip: "127.0.0.1",
    get: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

async function run(
  handler: (req: Request, res: Response, next: (e?: unknown) => void) => Promise<void>,
  req: Request,
): Promise<Outcome> {
  const outcome: Outcome = { status: 200, body: undefined };
  const res = {
    status(code: number) {
      outcome.status = code;
      return this;
    },
    json(payload: unknown) {
      outcome.body = payload;
      return this;
    },
    end() {
      return this;
    },
  } as unknown as Response;
  await handler(req, res, (e?: unknown) => {
    if (e) {
      const err = e as { status?: number; message?: string };
      outcome.error = { status: err.status, message: err.message };
      outcome.status = err.status ?? 500;
    }
  });
  return outcome;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Seed helpers ─────────────────────────────────────────────────────────────
async function ensureUser(role: "partner" | "customer", phone: string, email: string, name: string): Promise<string> {
  const user = await UserModel.findOneAndUpdate(
    { phone },
    { $set: { name, phone, email, role, status: "active", aadhar: "123412341234", passwordHash: "x", walletBalance: 0 } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return String(user!._id);
}

function buildEventBody() {
  const start = new Date(Date.now() + 7 * 86_400_000);
  const end = new Date(start.getTime() + 3 * 3_600_000);
  return {
    event: JSON.stringify({
      title: "Smoke Test Live Concert",
      description: "An end-to-end smoke test event with a long-enough description to satisfy the 50-char minimum validation rule.",
      category: "concert",
      eventType: "in_person",
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      organizer: { name: "Smoke Organizer", email: "organizer@spakstrip.dev" },
      cancellationPolicy: "full_refund",
    }),
    venue: JSON.stringify({ name: "Smoke Arena", city: "Mumbai", country: "India" }),
    tickets: JSON.stringify([
      { name: "Free Pass", price: 0, totalQuantity: 5, maxPerOrder: 5 },
      { name: "VIP", price: 1500, totalQuantity: 10, maxPerOrder: 4 },
    ]),
  };
}

async function main(): Promise<void> {
  await connectDb();

  const partnerId = await ensureUser("partner", "9000009001", "smoke-partner@spakstrip.dev", "Smoke Partner");
  const customerId = await ensureUser("customer", "9000009002", "smoke-customer@spakstrip.dev", "Smoke Customer");
  const partner = { sub: partnerId, role: "partner", email: "smoke-partner@spakstrip.dev" };
  const customer = { sub: customerId, role: "customer", email: "smoke-customer@spakstrip.dev" };

  // Clean any prior smoke data for idempotency.
  const prior = await EventListingModel.find({ partner: partnerId, title: "Smoke Test Live Concert" }).select("_id");
  await EventBookingModel.deleteMany({ event: { $in: prior.map((p) => p._id) } });
  await EventListingModel.deleteMany({ partner: partnerId, title: "Smoke Test Live Concert" });

  console.log("\n── Partner: create event ──");
  // createEvent uploads images from req.files; none here, so the validator should
  // reject (≥1 image required) — assert that guard, then seed directly via model.
  const noImage = await run(createEvent, mockReq({ user: partner, body: buildEventBody() }));
  check("createEvent rejects with no images (400)", noImage.status === 400, noImage.error);

  // Seed a published event directly (bypassing Cloudinary) to test the rest.
  const start = new Date(Date.now() + 7 * 86_400_000);
  const event = await EventListingModel.create({
    partner: new Types.ObjectId(partnerId),
    status: "published",
    title: "Smoke Test Live Concert",
    description: "An end-to-end smoke test event with a long-enough description to satisfy the 50-char minimum validation rule.",
    category: "concert",
    eventType: "in_person",
    startDate: start,
    endDate: new Date(start.getTime() + 3 * 3_600_000),
    venue: { name: "Smoke Arena", city: "Mumbai", country: "India" },
    images: [{ url: "https://example.com/a.jpg", isPrimary: true }],
    tickets: [
      { name: "Free Pass", price: 0, totalQuantity: 5, maxPerOrder: 5 },
      { name: "VIP", price: 1500, totalQuantity: 10, maxPerOrder: 4 },
    ],
    totalCapacity: 15,
    organizer: { name: "Smoke Organizer", email: "organizer@spakstrip.dev" },
    cancellationPolicy: "full_refund",
  });

  console.log("\n── Model hooks ──");
  check("slug auto-generated", typeof event.slug === "string" && event.slug.length > 0, event.slug);
  check("priceRange derived {min:0,max:1500}", event.priceRange.min === 0 && event.priceRange.max === 1500, event.priceRange);
  check("isFree false (mixed prices)", event.isFree === false);
  const freeTicket = event.tickets.find((t) => t.name === "Free Pass")!;
  const vipTicket = event.tickets.find((t) => t.name === "VIP")!;
  check("availableQuantity seeded = totalQuantity", freeTicket.availableQuantity === 5 && vipTicket.availableQuantity === 10);

  const freeTicketId = String(freeTicket._id);
  const vipTicketId = String(vipTicket._id);
  const slug = event.slug;

  console.log("\n── Partner: list my events ──");
  const myEvents = await run(listMyEvents, mockReq({ user: partner }));
  const myItems = (myEvents.body as { items?: unknown[] })?.items ?? [];
  check("listMyEvents returns the event", myItems.length >= 1);

  console.log("\n── Public discovery ──");
  const pub = await run(listEvents, mockReq({ query: { city: "Mumbai" } }));
  const pubItems = ((pub.body as { items?: Array<Record<string, unknown>> })?.items ?? []);
  const card = pubItems.find((c) => c.slug === slug);
  check("listEvents returns published event card", !!card);
  check("card isExternal=false, bookingType=direct", !!card && card.isExternal === false && card.bookingType === "direct", card);
  const bySlug = await run(getEventBySlug, mockReq({ params: { slug } }));
  check("getEventBySlug 200", bySlug.status === 200, bySlug.error);

  console.log("\n── Booking: validation guards ──");
  const noTickets = await run(initiateBooking, mockReq({ user: customer, params: { slug }, body: { tickets: [] } }));
  check("empty tickets → 400", noTickets.status === 400, noTickets.error);

  const overMax = await run(
    initiateBooking,
    mockReq({ user: customer, params: { slug }, body: { tickets: [{ ticketTypeId: vipTicketId, quantity: 99 }] } }),
  );
  check("quantity over maxPerOrder → 400", overMax.status === 400, overMax.error);

  console.log("\n── Booking: free happy path ──");
  const free = await run(
    initiateBooking,
    mockReq({
      user: customer,
      params: { slug },
      body: {
        tickets: [{ ticketTypeId: freeTicketId, quantity: 2 }],
        attendees: [{ name: "Alice" }, { name: "Bob" }],
      },
    }),
  );
  check("free booking → 201", free.status === 201, free.error);
  const freeBody = free.body as { free?: boolean; booking?: Record<string, unknown> };
  check("free flag + confirmed status", freeBody.free === true && freeBody.booking?.status === "confirmed", freeBody.booking);
  check("QR generated (data URL)", typeof freeBody.booking?.qrCode === "string" && String(freeBody.booking?.qrCode).startsWith("data:image"));
  const freeBookingRef = String(freeBody.booking?.bookingReference ?? "");
  check("bookingReference EVT-*", /^EVT-[0-9A-F]+$/.test(freeBookingRef), freeBookingRef);

  const afterFree = await EventListingModel.findById(event._id);
  const freeAfter = afterFree!.tickets.find((t) => t.name === "Free Pass")!;
  check("inventory: availableQuantity 5→3", freeAfter.availableQuantity === 3, freeAfter.availableQuantity);
  check("inventory: soldQuantity 0→2", freeAfter.soldQuantity === 2, freeAfter.soldQuantity);
  check("inventory: currentBookings = 2", afterFree!.currentBookings === 2, afterFree!.currentBookings);

  console.log("\n── Booking: oversell guard ──");
  const oversell = await run(
    initiateBooking,
    mockReq({ user: customer, params: { slug }, body: { tickets: [{ ticketTypeId: freeTicketId, quantity: 5 }] } }),
  );
  check("oversell (5 > 3 left) → 409", oversell.status === 409, oversell.error);
  const afterOversell = await EventListingModel.findById(event._id);
  check(
    "oversell did NOT change inventory (rollback)",
    afterOversell!.tickets.find((t) => t.name === "Free Pass")!.availableQuantity === 3,
  );

  console.log("\n── Booking: paid path without Razorpay ──");
  const paid = await run(
    initiateBooking,
    mockReq({ user: customer, params: { slug }, body: { tickets: [{ ticketTypeId: vipTicketId, quantity: 1 }] } }),
  );
  // With Razorpay unconfigured, createOrder throws → 502 and the hold is rolled back.
  const paidOk = paid.status === 201 || paid.status === 502;
  check("paid booking → 201 (order created) or 502 (Razorpay unconfigured)", paidOk, paid.error ?? paid.status);
  const afterPaid = await EventListingModel.findById(event._id);
  const vipAfter = afterPaid!.tickets.find((t) => t.name === "VIP")!;
  check(
    "paid path inventory consistent",
    paid.status === 502 ? vipAfter.availableQuantity === 10 : vipAfter.availableQuantity === 9,
    vipAfter.availableQuantity,
  );

  console.log("\n── Booking: cancel + inventory restore ──");
  const cancel = await run(cancelBooking, mockReq({ user: customer, params: { bookingRef: freeBookingRef }, body: { reason: "smoke" } }));
  check("cancel free booking → 200", cancel.status === 200, cancel.error);
  check("cancel status = cancelled", (cancel.body as { item?: Record<string, unknown> })?.item?.status === "cancelled");
  const afterCancel = await EventListingModel.findById(event._id);
  const freeAfterCancel = afterCancel!.tickets.find((t) => t.name === "Free Pass")!;
  check("cancel restored availableQuantity → 5", freeAfterCancel.availableQuantity === 5, freeAfterCancel.availableQuantity);
  check("cancel restored soldQuantity → 0", freeAfterCancel.soldQuantity === 0, freeAfterCancel.soldQuantity);

  // Let fire-and-forget notification emails flush (console transport) before we
  // disconnect, to avoid post-disconnect query noise.
  await sleep(500);

  console.log(`\n──────── SMOKE SUMMARY ────────`);
  console.log(`  passed: ${passed}   failed: ${failed}`);
  console.log(`───────────────────────────────\n`);

  await mongoose.disconnect();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("[smoke] fatal:", err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
