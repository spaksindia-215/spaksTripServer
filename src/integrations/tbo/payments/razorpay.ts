import Razorpay from "razorpay";
import crypto from "crypto";

// Ported verbatim from the Next.js app (client/src/lib/razorpay.ts) so the flight
// payment flow keeps identical semantics after moving to Railway. Reads the same
// RAZORPAY_* env vars. Throws when unconfigured (unlike server/lib/razorpay.ts,
// which returns null for the reconciliation worker's graceful-degradation path).

function getInstance(): Razorpay {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    throw new Error("RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set");
  }
  return new Razorpay({ key_id: keyId, key_secret: keySecret });
}

export async function createOrder(params: {
  amountPaise: number;
  receipt: string; // max 40 chars
  notes?: Record<string, string>;
}) {
  const rzp = getInstance();
  return rzp.orders.create({
    amount: params.amountPaise,
    currency: "INR",
    receipt: params.receipt.slice(0, 40),
    notes: params.notes,
  });
}

// Fetches the authoritative captured amount (in paise) for a payment, straight from
// Razorpay — the source of truth for refunds. NEVER trust a client-sent amount.
export async function fetchPayment(paymentId: string): Promise<{
  amountPaise: number;
  orderId: string | null;
  status: string;
}> {
  const rzp = getInstance();
  const p = await rzp.payments.fetch(paymentId);
  return {
    amountPaise: Number(p.amount),
    orderId: (p.order_id as string | null) ?? null,
    status: String(p.status),
  };
}

// Constant-time HMAC-SHA256 comparison — prevents timing attacks.
export function verifySignature(
  orderId: string,
  paymentId: string,
  signature: string,
): boolean {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) throw new Error("RAZORPAY_KEY_SECRET is not set");

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(signature, "hex"),
    );
  } catch {
    // timingSafeEqual throws when buffers have different lengths (invalid signature)
    return false;
  }
}

export async function initiateRefund(params: {
  paymentId: string;
  amountPaise: number;
  notes?: Record<string, string>;
}) {
  const rzp = getInstance();
  return rzp.payments.refund(params.paymentId, {
    amount: params.amountPaise,
    notes: params.notes,
  });
}
