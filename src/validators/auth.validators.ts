import { HttpError } from "../middleware/error";
import { ROLES, type Role } from "../models/User";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Permissive international phone: optional leading +, 7-15 digits (E.164-ish).
const PHONE_RE = /^\+?[0-9]{7,15}$/;
// Aadhaar is a 12-digit number.
const AADHAR_RE = /^\d{12}$/;
// Standard PAN: 5 letters, 4 digits, 1 letter.
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
// 15-char GSTIN: 2 state digits + 10-char PAN + 1 entity char + 'Z' + 1 checksum.
const GST_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;
const MIN_PASSWORD = 8;
// bcrypt only hashes the first 72 BYTES; cap below that so nothing is silently
// truncated and so an over-long password can't be used to burn CPU.
const MAX_PASSWORD = 72;
const MIN_NAME = 2;

// Strength rules: at least one lowercase, one uppercase, one digit, one symbol.
const PW_LOWER = /[a-z]/;
const PW_UPPER = /[A-Z]/;
const PW_DIGIT = /[0-9]/;
const PW_SYMBOL = /[^A-Za-z0-9]/;

export function assertPasswordStrength(password: string): void {
  if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    throw new HttpError(400, `Password must be ${MIN_PASSWORD}-${MAX_PASSWORD} characters`);
  }
  if (!PW_LOWER.test(password) || !PW_UPPER.test(password) || !PW_DIGIT.test(password) || !PW_SYMBOL.test(password)) {
    throw new HttpError(
      400,
      "Password must include uppercase, lowercase, a number, and a symbol",
    );
  }
}

// Roles that require admin approval and extra KYC (GST + PAN).
const KYC_ROLES: readonly Role[] = ["b2b_agent", "partner"];

export interface RegisterInput {
  name: string;
  phone: string;
  email: string;
  password: string;
  role: Role;
  aadhar: string;
  gst?: string;
  pan?: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function validateRegister(body: unknown): RegisterInput {
  if (!isObject(body)) throw new HttpError(400, "Invalid body");
  const { name, phone, email, password, role, aadhar, gst, pan } = body;

  if (typeof name !== "string" || name.trim().length < MIN_NAME) {
    throw new HttpError(400, `Name must be at least ${MIN_NAME} characters`);
  }
  if (typeof phone !== "string" || !PHONE_RE.test(phone.trim())) {
    throw new HttpError(400, "Invalid phone number");
  }
  if (typeof email !== "string" || !EMAIL_RE.test(email)) {
    throw new HttpError(400, "Invalid email");
  }
  if (typeof password !== "string") {
    throw new HttpError(400, "Password is required");
  }
  assertPasswordStrength(password);
  if (typeof aadhar !== "string" || !AADHAR_RE.test(aadhar.trim())) {
    throw new HttpError(400, "Invalid Aadhaar number (12 digits)");
  }

  let resolvedRole: Role = "customer";
  if (role !== undefined) {
    if (typeof role !== "string" || !(ROLES as readonly string[]).includes(role)) {
      throw new HttpError(400, `Invalid role. Allowed: ${ROLES.join(", ")}`);
    }
    resolvedRole = role as Role;
  }

  const result: RegisterInput = {
    name: name.trim(),
    phone: phone.trim(),
    email: email.toLowerCase().trim(),
    password,
    role: resolvedRole,
    aadhar: aadhar.trim(),
  };

  if (KYC_ROLES.includes(resolvedRole)) {
    const normalizedGst = typeof gst === "string" ? gst.trim().toUpperCase() : "";
    const normalizedPan = typeof pan === "string" ? pan.trim().toUpperCase() : "";
    if (!GST_RE.test(normalizedGst)) {
      throw new HttpError(400, "Invalid GST number");
    }
    if (!PAN_RE.test(normalizedPan)) {
      throw new HttpError(400, "Invalid PAN number");
    }
    result.gst = normalizedGst;
    result.pan = normalizedPan;
  }

  return result;
}

export function validateLogin(body: unknown): LoginInput {
  if (!isObject(body)) throw new HttpError(400, "Invalid body");
  const { email, password } = body;
  if (typeof email !== "string" || !EMAIL_RE.test(email.trim())) {
    throw new HttpError(400, "Invalid email");
  }
  if (typeof password !== "string" || password.length === 0) {
    throw new HttpError(400, "Password required");
  }
  return { email: email.toLowerCase().trim(), password };
}
