import crypto from "crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import { env } from "../config/env";
import { logger } from "../lib/logger";

// Captures the raw request body so we can verify Razorpay's HMAC signature.
// express.raw() is applied HERE and ONLY HERE — it must never touch any other
// route, all of which keep the global express.json() parser.
const rawBodyParser = express.raw({ type: "application/json" });

/**
 * Verify the X-Razorpay-Signature header against an HMAC-SHA256 of the raw body
 * computed with RAZORPAY_WEBHOOK_SECRET. Runs BEFORE any DB operation. On
 * mismatch (or missing secret/signature) responds 400 and logs the attempt. On
 * success, parses the raw body and attaches it to req.body for the handler.
 */
export function verifyRazorpayWebhook(req: Request, res: Response, next: NextFunction): void {
  rawBodyParser(req, res, (err?: unknown) => {
    if (err) {
      logger.warn({ event: "webhook_raw_parse_error" }, "Failed to read raw webhook body");
      res.status(400).json({ error: "Invalid body" });
      return;
    }

    const secret = env.razorpayWebhookSecret;
    if (!secret) {
      logger.error({ event: "webhook_secret_missing" }, "RAZORPAY_WEBHOOK_SECRET not configured");
      res.status(400).json({ error: "Webhook not configured" });
      return;
    }

    const signature = req.header("X-Razorpay-Signature") ?? "";
    // req.body is a Buffer here (express.raw). Keep it raw for HMAC.
    const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");

    const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    const valid =
      sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);

    if (!valid) {
      logger.warn(
        { event: "webhook_signature_invalid", ip: req.ip },
        "Rejected webhook with invalid signature",
      );
      res.status(400).json({ error: "Invalid signature" });
      return;
    }

    // Signature good — replace the raw Buffer with the parsed JSON for the handler.
    try {
      req.body = JSON.parse(rawBody.toString("utf8"));
    } catch {
      logger.warn({ event: "webhook_json_parse_error" }, "Webhook body was not valid JSON");
      res.status(400).json({ error: "Invalid JSON" });
      return;
    }

    next();
  });
}
