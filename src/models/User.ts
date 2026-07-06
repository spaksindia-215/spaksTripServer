import crypto from "crypto";
import { Schema, model, HydratedDocument } from "mongoose";

export const ROLES = ["customer", "agent", "b2b_agent", "partner"] as const;
export type Role = (typeof ROLES)[number];

export const USER_STATUSES = ["active", "pending", "rejected"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const MARKUP_TYPES = ["percent", "flat"] as const;
export type MarkupType = (typeof MARKUP_TYPES)[number];

export interface MarkupRule {
  type: MarkupType;
  value: number;
  cap?: number;
}

export interface IBranding {
  companyName?: string;
  tagline?: string;
  logo?: string;
  primaryColor: string;
  contactEmail?: string;
  contactPhone?: string;
}

export interface IUser {
  name: string;
  phone: string;
  email: string;
  passwordHash: string;
  role: Role;
  status: UserStatus;
  aadhar: string;
  gst?: string;
  pan?: string;
  creditLimit: number | null;
  walletBalance: number;
  rejectionReason?: string;
  // Brute-force lockout: consecutive failed logins and, once the threshold is
  // crossed, the time until which login is blocked (exponential backoff).
  failedLoginAttempts: number;
  lockUntil?: Date | null;
  // Email verification (double opt-in). New users start false; legacy users have
  // the field absent and are grandfathered in (login only blocks on === false).
  emailVerified?: boolean;
  // Timestamped record that the user accepted the Terms & Privacy Policy at
  // registration (DPDP / GDPR audit trail).
  consentAt?: Date;
  consentVersion?: string;
  markup?: {
    flights: MarkupRule;
    hotels: MarkupRule;
    taxi: MarkupRule;
  };
  // Agent white-label fields — only populated for agent / b2b_agent roles.
  slug?: string;
  branding?: IBranding;
  createdAt: Date;
}

export const markupRuleSchema = new Schema<MarkupRule>(
  {
    type:  { type: String, enum: MARKUP_TYPES, required: true, default: "percent" },
    value: { type: Number, required: true, min: 0, default: 0 },
    cap:   { type: Number, min: 0 },
  },
  { _id: false },
);

const brandingSchema = new Schema<IBranding>(
  {
    companyName:  { type: String, trim: true, maxlength: 100 },
    tagline:      { type: String, trim: true, maxlength: 120 },
    logo:         { type: String, trim: true },
    primaryColor: {
      type:     String,
      default:  "#185FA5",
      validate: {
        validator: (v: string) => /^#[0-9A-Fa-f]{6}$/.test(v),
        message:   "primaryColor must be a 6-digit hex color e.g. #185FA5",
      },
    },
    contactEmail: { type: String, trim: true, lowercase: true },
    contactPhone: { type: String, trim: true },
  },
  { _id: false },
);

const userSchema = new Schema<IUser>(
  {
    name: { type: String, required: true, trim: true },
    phone: {
      type:     String,
      required: true,
      unique:   true,
      trim:     true,
    },
    email: {
      type:      String,
      required:  true,
      unique:    true,
      lowercase: true,
      trim:      true,
    },
    passwordHash:    { type: String, required: true },
    role:            { type: String, enum: ROLES, required: true, default: "customer" },
    status:          { type: String, enum: USER_STATUSES, required: true, default: "active" },
    aadhar:          { type: String, required: true, trim: true },
    gst:             { type: String, trim: true },
    pan:             { type: String, trim: true },
    creditLimit:     { type: Number, default: null },
    walletBalance:   { type: Number, default: 0 },
    rejectionReason: { type: String, trim: true },
    failedLoginAttempts: { type: Number, default: 0 },
    lockUntil:           { type: Date, default: null },
    emailVerified:       { type: Boolean, default: false },
    consentAt:           { type: Date },
    consentVersion:      { type: String, trim: true },
    markup: {
      flights: { type: markupRuleSchema },
      hotels:  { type: markupRuleSchema },
      taxi:    { type: markupRuleSchema },
    },
    slug: {
      type:      String,
      unique:    true,
      sparse:    true,
      lowercase: true,
      trim:      true,
      match:     [/^[a-z0-9-]+$/, "slug must contain only lowercase letters, numbers, and hyphens"],
    },
    branding: { type: brandingSchema },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// Sparse unique index for `slug` is declared field-level (unique + sparse) above.
// Non-agent users have no slug and don't conflict.

// Auto-generate a permanent slug for agents on first save.
userSchema.pre("save", function (next) {
  const agentRoles: Role[] = ["agent", "b2b_agent"];
  if (!agentRoles.includes(this.role)) return next();
  if (this.slug) return next(); // set once, never overwrite

  const base = slugify(this.branding?.companyName ?? this.name);
  const suffix = crypto.randomBytes(3).toString("hex");
  this.slug = `${base}-${suffix}`;
  next();
});

userSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const out = ret as unknown as Record<string, unknown>;
    out.id = String(out._id);
    delete out._id;
    delete out.__v;
    delete out.passwordHash;
    // Internal security bookkeeping — never expose to clients.
    delete out.failedLoginAttempts;
    delete out.lockUntil;
    return out;
  },
});

export type UserDoc = HydratedDocument<IUser>;
export const UserModel = model<IUser>("User", userSchema);

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
