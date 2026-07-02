import { Router, type Request, type Response } from "express";
import { verifyRazorpayWebhook } from "../middleware/verifyRazorpayWebhook";
import { processRazorpayEvent } from "../services/paymentWebhookProcessor";
import { logger } from "../lib/logger";

const router = Router();

// POST /api/webhooks/razorpay
// verifyRazorpayWebhook applies express.raw() + HMAC check BEFORE this handler.
// By the time we run, req.body is the parsed, signature-verified JSON.
router.post("/razorpay", verifyRazorpayWebhook, async (req: Request, res: Response) => {
  const signature = req.header("X-Razorpay-Signature") ?? null;
  try {
    const outcome = await processRazorpayEvent(req.body, signature);
    if (!outcome.postgresOk) {
      // Should not happen (processor throws on PG failure), but be explicit:
      // a non-200 makes Razorpay retry, so we never silently lose a payment.
      res.status(500).json({ ok: false });
      return;
    }
    // Postgres (source of truth) is safe. Even if the Mongo heal was deferred to
    // the DLQ, we ack 200 so Razorpay stops retrying a payment we have recorded.
    res.status(200).json({ ok: true });
  } catch (err) {
    // Postgres write itself failed — return 500 so Razorpay retries the webhook.
    logger.error(
      { event: "webhook_postgres_failed", error: err instanceof Error ? err.message : String(err) },
      "Webhook Postgres write failed — returning 500 for Razorpay retry",
    );
    res.status(500).json({ ok: false });
  }
});

export default router;
