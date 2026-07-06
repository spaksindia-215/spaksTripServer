import nodemailer, { type Transporter } from "nodemailer";

// Configured via env vars — set these in .env.local:
//   EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASS, EMAIL_FROM
// Falls back to console logging when EMAIL_HOST is unset (dev/CI).

let cachedTransport: Transporter | null | undefined;
function buildTransport() {
  if (cachedTransport !== undefined) return cachedTransport;
  const host = process.env.EMAIL_HOST?.trim();
  if (!host) {
    cachedTransport = null;
    return cachedTransport;
  }
  cachedTransport = nodemailer.createTransport({
    host,
    port: Number(process.env.EMAIL_PORT ?? 587),
    secure: Number(process.env.EMAIL_PORT ?? 587) === 465,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
    // IPv4 forced process-wide in index.ts (see note there) to avoid Gmail's
    // unreachable IPv6 address on hosts without IPv6 egress.
    // Reuse connections and fail fast rather than hanging on a slow SMTP server.
    pool: true,
    maxConnections: 3,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return cachedTransport;
}

export interface FlightConfirmationData {
  to: string;
  pnr: string;
  bookingReference: string;
  origin: string;
  destination: string;
  passengerNames: string[];
  totalAmount: number;
}

function flightConfirmationHtml(d: FlightConfirmationData): string {
  const paxList = d.passengerNames
    .map((n) => `<li style="margin:4px 0;color:#374151;">${n}</li>`)
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">

        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#1a56db,#1e40af);padding:32px 40px;text-align:center;">
            <div style="font-size:26px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">SpaksTrip</div>
            <div style="font-size:14px;color:#bfdbfe;margin-top:4px;">Flight Booking Confirmed</div>
          </td>
        </tr>

        <!-- Success banner -->
        <tr>
          <td style="background:#ecfdf5;padding:20px 40px;text-align:center;border-bottom:1px solid #d1fae5;">
            <div style="font-size:20px;font-weight:700;color:#065f46;">&#10003; Your trip is booked!</div>
            <div style="font-size:13px;color:#047857;margin-top:4px;">A confirmation copy has been sent to ${d.to}</div>
          </td>
        </tr>

        <!-- PNR box -->
        <tr>
          <td style="padding:28px 40px 0;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:18px 24px;text-align:center;">
                  <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:#1d4ed8;">PNR / Booking Reference</div>
                  <div style="font-size:30px;font-weight:800;letter-spacing:4px;color:#1e3a8a;margin-top:6px;">${d.pnr}</div>
                  <div style="font-size:12px;color:#3b82f6;margin-top:4px;">Ref: ${d.bookingReference}</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Route -->
        <tr>
          <td style="padding:20px 40px 0;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="background:#f9fafb;border-radius:8px;padding:16px 20px;">
                  <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:#6b7280;margin-bottom:8px;">Route</div>
                  <div style="font-size:20px;font-weight:700;color:#111827;text-align:center;">
                    ${d.origin} &nbsp;&rarr;&nbsp; ${d.destination}
                  </div>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Passengers -->
        <tr>
          <td style="padding:20px 40px 0;">
            <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:#6b7280;margin-bottom:8px;">Passengers</div>
            <ul style="margin:0;padding-left:20px;">
              ${paxList}
            </ul>
          </td>
        </tr>

        <!-- Amount -->
        <tr>
          <td style="padding:20px 40px 28px;">
            <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e5e7eb;padding-top:16px;margin-top:4px;">
              <tr>
                <td style="font-size:13px;color:#6b7280;">Total amount paid</td>
                <td align="right" style="font-size:16px;font-weight:700;color:#111827;">
                  &#8377;${d.totalAmount.toLocaleString("en-IN")}
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- What's next -->
        <tr>
          <td style="background:#f9fafb;padding:20px 40px;border-top:1px solid #e5e7eb;">
            <div style="font-size:13px;font-weight:600;color:#374151;margin-bottom:10px;">What&apos;s next</div>
            <ul style="margin:0;padding-left:20px;font-size:13px;color:#6b7280;line-height:1.8;">
              <li>Web check-in opens 48 hours before departure.</li>
              <li>Arrive at the airport at least 2 hours before your flight.</li>
              <li>Carry a government-issued photo ID matching the traveller names.</li>
            </ul>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:18px 40px;text-align:center;border-top:1px solid #e5e7eb;">
            <div style="font-size:11px;color:#9ca3af;">This is an automated confirmation from SpaksTrip. Please do not reply to this email.</div>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function flightConfirmationText(d: FlightConfirmationData): string {
  return [
    "BOOKING CONFIRMED — SpaksTrip",
    "",
    `PNR: ${d.pnr}`,
    `Reference: ${d.bookingReference}`,
    `Route: ${d.origin} → ${d.destination}`,
    "",
    "Passengers:",
    ...d.passengerNames.map((n) => `  - ${n}`),
    "",
    `Amount paid: ₹${d.totalAmount.toLocaleString("en-IN")}`,
    "",
    "What's next:",
    "  - Web check-in opens 48 hours before departure.",
    "  - Arrive at the airport at least 2 hours before your flight.",
    "  - Carry a government-issued photo ID matching the traveller names.",
  ].join("\n");
}

export async function sendFlightConfirmation(data: FlightConfirmationData): Promise<void> {
  const from = process.env.EMAIL_FROM ?? "SpaksTrip <noreply@spakstrip.com>";
  const subject = `Booking Confirmed — ${data.origin} → ${data.destination} (PNR: ${data.pnr})`;

  const transport = buildTransport();
  if (!transport) {
    // Dev fallback: log to console when SMTP is not configured.
    console.log(
      [
        "",
        "──────── FLIGHT CONFIRMATION MAIL (console transport) ────────",
        `To:      ${data.to}`,
        `Subject: ${subject}`,
        "",
        flightConfirmationText(data),
        "──────────────────────────────────────────────────────────────",
        "",
      ].join("\n"),
    );
    return;
  }

  await transport.sendMail({
    from,
    to: data.to,
    subject,
    text: flightConfirmationText(data),
    html: flightConfirmationHtml(data),
  });
}
