import mongoose from "mongoose";
import { BookingModel, type ProductType } from "../models/Booking";
import type { Role } from "../models/User";
import type { AnyBookingDetails } from "../models/bookingDetails";

// Persists a Booking for the END CUSTOMER so the trip shows up on their dashboard
// (GET /api/customer/bookings filters by ownerId). Counterpart to recordSubdomainBooking
// (which stamps the AGENT as owner for settlement).
//
// Two modes:
//  - Logged-in customer  → `ownerId` set, booking is immediately theirs.
//  - Guest (brand-new email) → `claimEmail` set, `ownerId` absent. The booking is
//    "unclaimed" until they register/log in with a VERIFIED matching email, at which
//    point claimGuestBookings() attaches it. (Existing-account emails are forced to
//    log in at checkout, so they never reach the guest path.)
//
// Fire-and-forget by contract: the TBO booking is already confirmed by the time this
// runs, so a failure here must never fail the booking response. Errors are logged.

export interface RecordCustomerBookingInput {
  ownerId?: string;
  ownerRole?: Role;
  claimEmail?: string;
  productType: ProductType;
  pnr?: string;
  amount: number;
  currency?: string;
  details?: AnyBookingDetails;
}

export async function recordCustomerBooking(input: RecordCustomerBookingInput): Promise<void> {
  try {
    const { ownerId, ownerRole, claimEmail, productType, pnr, amount, currency, details } = input;

    if (typeof amount !== "number" || amount <= 0) return;

    const base = {
      productType,
      status: "active" as const,
      pnr,
      amount,
      currency: currency ?? "INR",
      customerPaid: amount,
      details: details ?? {},
    };

    if (ownerId && mongoose.isValidObjectId(ownerId)) {
      await BookingModel.create({
        ...base,
        ownerId: new mongoose.Types.ObjectId(ownerId),
        ownerRole: ownerRole ?? "customer",
      });
      return;
    }

    const normalizedEmail = claimEmail?.trim().toLowerCase();
    if (normalizedEmail) {
      // Guest booking — owned by nobody yet; tagged for claim-by-email.
      await BookingModel.create({
        ...base,
        ownerRole: "customer",
        claimEmail: normalizedEmail,
      });
      return;
    }

    // Neither an owner nor a claim email — nothing to attribute, drop it.
  } catch (e) {
    console.error("[customer-booking] recording failed:", e instanceof Error ? e.message : String(e));
  }
}

// Attaches any unclaimed guest bookings made with `email` to the now-authenticated
// user. Called ONLY after the email is proven controlled by this user — i.e. on
// successful login (email already verified) or right after email verification — so a
// booking can never be claimed by someone who doesn't own the inbox.
export async function claimGuestBookings(userId: string, email: string, role: Role): Promise<number> {
  try {
    if (!mongoose.isValidObjectId(userId)) return 0;
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) return 0;

    const result = await BookingModel.updateMany(
      { claimEmail: normalizedEmail, ownerId: { $exists: false } },
      { $set: { ownerId: new mongoose.Types.ObjectId(userId), ownerRole: role }, $unset: { claimEmail: "" } },
    );
    const claimed = result.modifiedCount ?? 0;
    if (claimed > 0) {
      console.log(`[customer-booking] claimed ${claimed} guest booking(s) for user ${userId}`);
    }
    return claimed;
  } catch (e) {
    console.error("[customer-booking] claim failed:", e instanceof Error ? e.message : String(e));
    return 0;
  }
}
