import { Schema } from "mongoose";
import { randomBytes } from "crypto";

// DRY helpers shared by every typed partner model (CLAUDE.md Step 8): a uniform
// slug generator + a single id/_id-normalizing toJSON transform, so individual
// schemas don't each re-declare them.

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// `toJSON` transform: expose `id` (string), drop `_id`/`__v`.
export const idTransform = {
  transform: (_doc: unknown, ret: Record<string, unknown>) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
};

// Adds a pre-validate hook that auto-fills `slug` from `build(doc)` plus a short
// random suffix (kept unique by the schema's unique index). No-op if slug set.
export function attachSlug<T>(
  schema: Schema<T>,
  build: (doc: Record<string, unknown>) => string,
  fallback: string,
): void {
  schema.pre("validate", function (next) {
    const self = this as unknown as Record<string, unknown>;
    if (!self.slug) {
      const base = slugify(build(self)) || fallback;
      self.slug = `${base}-${randomBytes(3).toString("hex")}`;
    }
    next();
  });
}
