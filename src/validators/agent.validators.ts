import { HttpError } from "../middleware/error";
import { PRODUCT_TYPES, type ProductType } from "../models/Booking";
import type { AnyBookingDetails } from "../models/bookingDetails";

const MAX_HOLD_MINUTES = 1440; // 24h cap
const DEFAULT_HOLD_MINUTES = 30;

export interface BookingCreateInput {
  productType: ProductType;
  amount: number;
  currency?: string;
  pnr?: string;
  status: "active" | "held";
  holdMinutes: number;
  details: AnyBookingDetails;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function validateBookingCreate(body: unknown): BookingCreateInput {
  if (!isObject(body)) throw new HttpError(400, "Invalid body");
  const { productType, amount, currency, pnr, status, holdMinutes, details } = body;

  if (typeof productType !== "string" || !(PRODUCT_TYPES as readonly string[]).includes(productType)) {
    throw new HttpError(400, `productType must be one of: ${PRODUCT_TYPES.join(", ")}`);
  }

  const amountNum = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(amountNum) || amountNum < 0) {
    throw new HttpError(400, "amount must be a non-negative number");
  }

  // Agents create either a confirmed booking ("active") or a "held" booking.
  const resolvedStatus = status === "held" ? "held" : status === "active" ? "active" : undefined;
  if (!resolvedStatus) {
    throw new HttpError(400, "status must be 'active' or 'held'");
  }

  let resolvedHold = DEFAULT_HOLD_MINUTES;
  if (holdMinutes !== undefined) {
    const n = typeof holdMinutes === "number" ? holdMinutes : Number(holdMinutes);
    if (!Number.isFinite(n) || n <= 0 || n > MAX_HOLD_MINUTES) {
      throw new HttpError(400, `holdMinutes must be between 1 and ${MAX_HOLD_MINUTES}`);
    }
    resolvedHold = n;
  }

  return {
    productType: productType as ProductType,
    amount: amountNum,
    currency: typeof currency === "string" && currency.trim() ? currency.trim() : undefined,
    pnr: typeof pnr === "string" && pnr.trim() ? pnr.trim() : undefined,
    status: resolvedStatus,
    holdMinutes: resolvedHold,
    details: isObject(details) ? (details as AnyBookingDetails) : {},
  };
}
