import mongoose from "mongoose";
import { BookingModel, PRODUCT_TYPES, type ProductType } from "../models/Booking";
import type { TwoTierPricing } from "../lib/tboMarkup";

// In-process equivalent of the Next.js fire-and-forget POST /api/internal/record-booking.
// When the TBO integration ran on Vercel it HTTP-called the Express backend to stamp
// a subdomain booking against the agent for settlement. Now that the flow runs inside
// the same Express process, we write the BookingModel directly — same record shape.
//
// Fire-and-forget by contract: callers must not let a failure here block the booking
// response. Errors are swallowed and logged.

export interface RecordSubdomainBookingInput {
  agentId: string;
  productType: ProductType | string;
  pnr?: string;
  pricing: TwoTierPricing;
}

export async function recordSubdomainBooking(input: RecordSubdomainBookingInput): Promise<void> {
  try {
    const { agentId: agentIdStr, productType, pnr, pricing } = input;

    if (!agentIdStr || !mongoose.isValidObjectId(agentIdStr)) return;
    if (!(PRODUCT_TYPES as readonly string[]).includes(productType)) return;
    if (typeof pricing.customerPaid !== "number" || pricing.customerPaid <= 0) return;

    const agentId = new mongoose.Types.ObjectId(agentIdStr);

    await BookingModel.create({
      ownerId: agentId,
      ownerRole: "agent",
      agentId,
      productType: productType as ProductType,
      status: "active",
      pnr,
      amount: pricing.customerPaid,
      currency: "INR",
      tboFare: pricing.tboFare,
      platformMarkup: pricing.platformMarkup,
      netFare: pricing.agentNetRate,
      agentMarkup: pricing.agentMarkup,
      customerPaid: pricing.customerPaid,
      details: {},
    });
  } catch (e) {
    console.error("[record-booking] in-process recording failed:", e instanceof Error ? e.message : String(e));
  }
}
