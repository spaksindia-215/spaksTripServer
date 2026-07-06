import CircuitBreaker from "opossum";
import { logger } from "./logger";
import { fetchPayment, fetchPaymentsForOrder } from "./razorpay";

// Circuit breaker for ALL outbound Razorpay API calls. During a Razorpay outage
// this stops us from hammering dead endpoints and clogging the DB with retries.
//
// Thresholds (per spec): 10s timeout, opens at 50% error rate, attempts reset
// (HALF-OPEN) after 60s.
const options: CircuitBreaker.Options = {
  timeout: 10000,
  errorThresholdPercentage: 50,
  resetTimeout: 60000,
};

// One breaker per outbound action, sharing the same config. Each wraps the raw
// razorpay.ts call so a failure/timeout counts toward tripping the breaker.
export const fetchPaymentCircuit = new CircuitBreaker(fetchPayment, options);
export const fetchPaymentsForOrderCircuit = new CircuitBreaker(fetchPaymentsForOrder, options);

// User-facing fallback when the circuit is OPEN — money is never at risk here
// because an open circuit means we simply did not reach Razorpay.
const OPEN_MESSAGE =
  "Payment systems are temporarily unavailable. Your money is safe. Please retry in a few minutes.";

function instrument(breaker: CircuitBreaker, name: string): void {
  breaker.on("open", () =>
    logger.warn({ event: "circuit_open", circuit: name }, "Razorpay circuit OPENED"),
  );
  breaker.on("halfOpen", () =>
    logger.info({ event: "circuit_half_open", circuit: name }, "Razorpay circuit HALF-OPEN"),
  );
  breaker.on("close", () =>
    logger.info({ event: "circuit_close", circuit: name }, "Razorpay circuit CLOSED"),
  );
  // When open, fail fast with the user-friendly message instead of calling out.
  breaker.fallback(() => {
    throw new Error(OPEN_MESSAGE);
  });
}

instrument(fetchPaymentCircuit, "razorpay.fetchPayment");
instrument(fetchPaymentsForOrderCircuit, "razorpay.fetchPaymentsForOrder");
