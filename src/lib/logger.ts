import { Writable } from "node:stream";
import pino from "pino";
import { isProd } from "../config/env";

// Structured logger for payment/transaction operations. In development we pipe
// through pino-pretty for readable output; in production we emit raw JSON so
// log aggregators can index fields like correlation_id, user_id, amount.
//
// Goal: any user's missing transaction should be traceable in under 60 seconds
// by grepping for its correlation_id (provider_order_id or idempotency_key).

// pino writes JSON straight to fd 1 via sonic-boom (fs.writeSync), which some
// managed hosts (Hostinger's Passenger) do NOT capture — only `console.*` output
// reaches their log stream, so worker/Postgres logs silently vanished while raw
// console.log lines showed. This destination forwards every finished log line
// through console.log so it rides the exact channel the host captures.
const consoleDestination = new Writable({
  write(chunk: Buffer, _enc, cb) {
    // pino appends a trailing newline per line; console.log adds its own.
    console.log(chunk.toString("utf8").replace(/\n$/, ""));
    cb();
  },
});

export const logger = isProd
  ? pino({ level: process.env.LOG_LEVEL ?? "info" }, consoleDestination)
  : pino({
      level: process.env.LOG_LEVEL ?? "debug",
      transport: {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:standard" },
      },
    });
