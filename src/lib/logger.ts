import pino from "pino";
import { isProd } from "../config/env";

// Structured logger for payment/transaction operations. In development we pipe
// through pino-pretty for readable output; in production we emit raw JSON so
// log aggregators can index fields like correlation_id, user_id, amount.
//
// Goal: any user's missing transaction should be traceable in under 60 seconds
// by grepping for its correlation_id (provider_order_id or idempotency_key).
export const logger = pino(
  isProd
    ? { level: process.env.LOG_LEVEL ?? "info" }
    : {
        level: process.env.LOG_LEVEL ?? "debug",
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:standard" },
        },
      },
);
