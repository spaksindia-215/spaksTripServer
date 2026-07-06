import Razorpay from "razorpay";
import { env } from "../config/env";

// Lazy Razorpay client. Built only when keys are present so the server boots
// fine in environments without payment credentials (graceful degradation).
let client: Razorpay | null = null;

export function getRazorpay(): Razorpay | null {
  if (client) return client;
  if (!env.razorpayKeyId || !env.razorpayKeySecret) return null;
  client = new Razorpay({
    key_id: env.razorpayKeyId,
    key_secret: env.razorpayKeySecret,
  });
  return client;
}

/**
 * Razorpay Fetch Payment — ground truth for a payment's status. Used by the
 * reconciliation worker. Throws if the client is unconfigured or the call fails;
 * the circuit breaker wraps this so repeated failures trip the breaker open.
 */
export async function fetchPayment(paymentId: string): Promise<{ id: string; status: string; order_id: string }> {
  const rp = getRazorpay();
  if (!rp) throw new Error("Razorpay is not configured");
  const payment = await rp.payments.fetch(paymentId);
  return {
    id: String(payment.id),
    status: String(payment.status),
    order_id: String(payment.order_id),
  };
}

/**
 * Fetch all payments for an order — used when we only have the order id (no
 * payment id) and need to discover whether a payment was captured.
 */
export async function fetchPaymentsForOrder(orderId: string): Promise<Array<{ id: string; status: string }>> {
  const rp = getRazorpay();
  if (!rp) throw new Error("Razorpay is not configured");
  const result = await rp.orders.fetchPayments(orderId);
  const items = (result.items ?? []) as Array<{ id: string | number; status: string }>;
  return items.map((p) => ({ id: String(p.id), status: String(p.status) }));
}
