import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePackage } from "./package.validators";

function sightseeingBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "sightseeing",
    title: "Sunset Dolphin Cruise",
    specs: {
      category: "water_activity",
      location: { island: "Havelock", address: "Jetty Road" },
      meetingPoint: { instructions: "Meet at the jetty 15 min early" },
      duration: { value: 2, unit: "hours" },
      difficulty: "easy",
      ageRestriction: { min: 5 },
      groupSize: { min: 1, max: 20 },
      whatToBring: ["Sunscreen", "Camera"],
      pricingModel: "per_person",
      pricing: { adult: 1500, child: 900 },
      availableDays: ["mon", "wed", "fri"],
      timeSlots: ["09:00", "16:00"],
      blackoutDates: ["2026-12-25"],
      cancellationPolicy: "free_24h",
      bookingCutoffHours: 6,
      languages: ["English", "Hindi"],
      accessibility: ["Wheelchair accessible"],
      termsAndConditions: "No refunds after boarding.",
      videoUrl: "https://youtu.be/example",
    },
    ...overrides,
  };
}

test("validatePackage accepts a full sightseeing specs payload", () => {
  const result = validatePackage({ body: sightseeingBody(), imageUrls: [] });
  assert.equal(result.kind, "sightseeing");
  assert.deepEqual(result.specs, {
    category: "water_activity",
    location: { island: "Havelock", address: "Jetty Road" },
    meetingPoint: { instructions: "Meet at the jetty 15 min early" },
    duration: { value: 2, unit: "hours" },
    difficulty: "easy",
    ageRestriction: { min: 5, max: undefined },
    groupSize: { min: 1, max: 20 },
    whatToBring: ["Sunscreen", "Camera"],
    pricingModel: "per_person",
    pricing: { adult: 1500, child: 900, infant: undefined, groupPrice: undefined },
    availableDays: ["mon", "wed", "fri"],
    timeSlots: ["09:00", "16:00"],
    blackoutDates: ["2026-12-25"],
    cancellationPolicy: "free_24h",
    bookingCutoffHours: 6,
    languages: ["English", "Hindi"],
    accessibility: ["Wheelchair accessible"],
    termsAndConditions: "No refunds after boarding.",
    videoUrl: "https://youtu.be/example",
  });
});

test("validatePackage populates specs with a minimal sightseeing payload", () => {
  const result = validatePackage({
    body: { kind: "sightseeing", title: "Minimal Activity" },
    imageUrls: [],
  });
  assert.equal(result.kind, "sightseeing");
  assert.ok(result.specs && typeof result.specs === "object");
  assert.deepEqual((result.specs as Record<string, unknown>).availableDays, []);
  assert.deepEqual((result.specs as Record<string, unknown>).whatToBring, []);
});

test("validatePackage rejects an invalid sightseeing category", () => {
  assert.throws(
    () => validatePackage({ body: sightseeingBody({ specs: { ...sightseeingBody().specs as object, category: "not_a_category" } }), imageUrls: [] }),
    /category must be one of/,
  );
});

test("validatePackage rejects an invalid sightseeing cancellation policy", () => {
  const body = sightseeingBody();
  (body.specs as Record<string, unknown>).cancellationPolicy = "whenever";
  assert.throws(() => validatePackage({ body, imageUrls: [] }), /cancellationPolicy must be one of/);
});

test("validatePackage rejects an invalid sightseeing duration unit", () => {
  const body = sightseeingBody();
  (body.specs as Record<string, unknown>).duration = { value: 2, unit: "fortnights" };
  assert.throws(() => validatePackage({ body, imageUrls: [] }), /duration\.unit must be one of/);
});

test("validatePackage rejects an invalid sightseeing difficulty", () => {
  const body = sightseeingBody();
  body.specs = { ...(body.specs as object), difficulty: "extreme" };
  assert.throws(() => validatePackage({ body, imageUrls: [] }), /difficulty must be one of/);
});

test("validatePackage rejects an invalid sightseeing pricingModel", () => {
  const body = sightseeingBody();
  body.specs = { ...(body.specs as object), pricingModel: "auction" };
  assert.throws(() => validatePackage({ body, imageUrls: [] }), /pricingModel must be one of/);
});

test("validatePackage filters out non-enum availableDays entries silently", () => {
  const body = sightseeingBody();
  body.specs = { ...(body.specs as object), availableDays: ["mon", "not_a_day", "fri"] };
  const result = validatePackage({ body, imageUrls: [] });
  assert.deepEqual((result.specs as Record<string, unknown>).availableDays, ["mon", "fri"]);
});

test("validatePackage leaves specs as a loose passthrough for non-sightseeing kinds", () => {
  const result = validatePackage({
    body: {
      kind: "taxi",
      title: "Delhi Airport Taxi",
      specs: { anything: "goes", nested: { ok: true } },
    },
    imageUrls: [],
  });
  assert.equal(result.kind, "taxi");
  assert.deepEqual(result.specs, { anything: "goes", nested: { ok: true } });
});

test("validatePackage still requires a title regardless of kind", () => {
  assert.throws(() => validatePackage({ body: { kind: "sightseeing" }, imageUrls: [] }), /title is required/);
});
