import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../config/env";

// Transactional mailer. Uses SMTP when EMAIL_HOST is configured; otherwise falls
// back to a console transport (dev/CI) so flows still work without a mail server.
// Raw secrets are never logged.

export type MailTemplate =
  | "superadminNewPending"
  | "applicantApproved"
  | "applicantRejected"
  | "verifyEmail"
  | "passwordReset"
  | "eventBookingConfirmed"
  | "eventBookingCancelled"
  | "eventReminder"
  | "eventUpdated"
  | "eventPartnerNewBooking"
  | "eventPartnerBookingCancelled"
  | "hotelEnquiryReceived";

export interface MailMessage {
  to: string;
  subject: string;
  template: MailTemplate;
  data: Record<string, unknown>;
}

function renderBody(template: MailTemplate, data: Record<string, unknown>): string {
  switch (template) {
    case "hotelEnquiryReceived":
      return [
        `Hi ${data.partnerName ?? "there"},`,
        ``,
        `You've received a new enquiry for "${data.hotelName}".`,
        ``,
        `Guest:   ${data.contactName}`,
        `Phone:   ${data.contactPhone}`,
        data.contactEmail ? `Email:   ${data.contactEmail}` : ``,
        data.dates ? `Dates:   ${data.dates}` : ``,
        `Guests:  ${data.pax}`,
        data.message ? `Message: ${data.message}` : ``,
        ``,
        `Please reach out to the guest directly to confirm availability and pricing.`,
      ]
        .filter(Boolean)
        .join("\n");
    case "superadminNewPending":
      return [
        `A new ${data.role} registration is awaiting approval.`,
        `Name:  ${data.name}`,
        `Phone: ${data.phone}`,
        `Email: ${data.email}`,
        ``,
        `Review it in the superadmin panel: ${data.reviewUrl ?? "/superadmin"}`,
      ].join("\n");
    case "applicantApproved":
      return [
        `Hi ${data.name},`,
        ``,
        `Your SpaksTrip ${data.role} account has been approved. You can now log in with your phone number.`,
        data.creditLimit != null ? `Approved credit limit: ₹${data.creditLimit}` : ``,
      ]
        .filter(Boolean)
        .join("\n");
    case "applicantRejected":
      return [
        `Hi ${data.name},`,
        ``,
        `Your SpaksTrip ${data.role} application was not approved.`,
        data.reason ? `Reason: ${data.reason}` : ``,
      ]
        .filter(Boolean)
        .join("\n");
    case "verifyEmail":
      return [
        `Hi ${data.name ?? "there"},`,
        ``,
        `Welcome to SpaksTrip! Please confirm your email address to activate your account:`,
        ``,
        `${data.verifyUrl}`,
        ``,
        `This link expires in ${data.expiresInHours ?? 24} hours. If you didn't sign up, you can ignore this email.`,
      ].join("\n");
    case "passwordReset":
      return [
        `Hi ${data.name ?? "there"},`,
        ``,
        `We received a request to reset your SpaksTrip password. Use the link below to choose a new one:`,
        ``,
        `${data.resetUrl}`,
        ``,
        `This link expires in ${data.expiresInMinutes ?? 30} minutes and can be used once. If you didn't request this, your password is unchanged — you can safely ignore this email.`,
      ].join("\n");
    case "eventBookingConfirmed":
      return [
        `Hi ${data.name ?? "there"},`,
        ``,
        `Your booking is confirmed! 🎉`,
        ``,
        `Event:    ${data.eventTitle}`,
        data.startDate ? `When:     ${data.startDate}` : ``,
        data.venue ? `Where:    ${data.venue}` : ``,
        `Tickets:  ${data.tickets}`,
        `Booking:  ${data.bookingReference}`,
        `Total:    ₹${data.totalAmount}`,
        ``,
        `Show your QR code (in My Bookings) at entry. We've saved it to your booking.`,
      ]
        .filter(Boolean)
        .join("\n");
    case "eventBookingCancelled":
      return [
        `Hi ${data.name ?? "there"},`,
        ``,
        `Your booking ${data.bookingReference} for "${data.eventTitle}" has been cancelled.`,
        Number(data.refundAmount) > 0
          ? `A refund of ₹${data.refundAmount} has been initiated and will reflect in 5-7 business days.`
          : `No refund applies under this event's cancellation policy.`,
      ]
        .filter(Boolean)
        .join("\n");
    case "eventReminder":
      return [
        `Hi ${data.name ?? "there"},`,
        ``,
        `A quick reminder — "${data.eventTitle}" is coming up.`,
        data.startDate ? `When:  ${data.startDate}` : ``,
        data.venue ? `Where: ${data.venue}` : ``,
        `Booking: ${data.bookingReference}`,
        ``,
        `See you there!`,
      ]
        .filter(Boolean)
        .join("\n");
    case "eventUpdated":
      return [
        `Hi ${data.name ?? "there"},`,
        ``,
        `Details for "${data.eventTitle}" (booking ${data.bookingReference}) have changed:`,
        `${data.changes}`,
        ``,
        `If the new details don't work for you, you can cancel from My Bookings.`,
      ]
        .filter(Boolean)
        .join("\n");
    case "eventPartnerNewBooking":
      return [
        `Hi ${data.name ?? "there"},`,
        ``,
        `New booking received for "${data.eventTitle}".`,
        `Booking:  ${data.bookingReference}`,
        `Tickets:  ${data.tickets}`,
        `Amount:   ₹${data.totalAmount}`,
      ].join("\n");
    case "eventPartnerBookingCancelled":
      return [
        `Hi ${data.name ?? "there"},`,
        ``,
        `Booking ${data.bookingReference} for "${data.eventTitle}" was cancelled by the customer.`,
        `Tickets released: ${data.tickets}`,
      ].join("\n");
  }
}

let transporter: Transporter | null = null;
function getTransport(): Transporter | null {
  if (transporter) return transporter;
  if (!env.emailHost) return null;
  transporter = nodemailer.createTransport({
    host: env.emailHost.trim(),
    port: env.emailPort,
    secure: env.emailPort === 465,
    auth: env.emailUser ? { user: env.emailUser, pass: env.emailPass } : undefined,
    // IPv4 is forced process-wide in index.ts (dns.setDefaultResultOrder) so the
    // unreachable Gmail AAAA record is never tried on hosts without IPv6 egress.
    // Reuse one connection across sends instead of a fresh ~4s TLS+AUTH handshake
    // every time, and fail fast instead of hanging the request when SMTP is slow.
    pool: true,
    maxConnections: 3,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return transporter;
}

async function deliver(message: MailMessage, body: string): Promise<void> {
  const transport = getTransport();
  if (!transport) {
    // eslint-disable-next-line no-console
    console.log(
      [
        "",
        "──────── MAIL (console transport) ────────",
        `To:      ${message.to}`,
        `Subject: ${message.subject}`,
        `Template:${message.template}`,
        "",
        body,
        "──────────────────────────────────────────",
        "",
      ].join("\n"),
    );
    return;
  }
  await transport.sendMail({
    from: env.emailFrom,
    to: message.to,
    subject: message.subject,
    text: body,
  });
}

export async function sendMail(message: MailMessage): Promise<void> {
  const body = renderBody(message.template, message.data);
  await deliver(message, body);
}
