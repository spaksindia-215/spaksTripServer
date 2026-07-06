import { Request, Response, NextFunction } from "express";
import { isProd } from "../config/env";

// Baseline security headers for the API. This is a JSON API (no HTML rendering)
// so a full CSP is unnecessary here — the browser-facing CSP lives in the
// Next.js app (next.config.ts). We still send the cheap, high-value headers:
//   - HSTS              : force HTTPS for a long period (prod only — never send
//                         over plain HTTP in dev or it poisons localhost).
//   - X-Content-Type-Options: stop MIME sniffing.
//   - X-Frame-Options   : the API is never framed.
//   - Referrer-Policy   : don't leak full URLs cross-origin.
//   - X-DNS-Prefetch-Control / Permissions-Policy: minor hardening.
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  if (isProd) {
    res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-DNS-Prefetch-Control", "off");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
}
