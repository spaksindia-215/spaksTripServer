import { test } from "node:test";
import assert from "node:assert/strict";
import { applyMarkup, applyTwoTierMarkup, applyPlatformMarkup, markupAmount } from "./markupEngine";
import type { MarkupRule } from "./markupEngine";

const percent = (value: number, cap?: number): MarkupRule => ({ type: "percent", value, ...(cap != null ? { cap } : {}) });
const flat = (value: number, cap?: number): MarkupRule => ({ type: "flat", value, ...(cap != null ? { cap } : {}) });

// Golden table — >= 20 cases spanning percent, flat, caps, zero markup, and
// INR rounding edges (33.335-style halves, negative-leaning fractions).
// [description, netFare, rule, expected]
const GOLDEN: Array<[string, number, MarkupRule, number]> = [
  ["percent 2% on 4500", 4500, percent(2), 4590],
  ["flat +50 on 4500", 4500, flat(50), 4550],
  ["percent 2% capped at 50 on 4500", 4500, percent(2, 50), 4550],
  ["zero percent markup", 4500, percent(0), 4500],
  ["zero flat markup", 4500, flat(0), 4500],
  ["percent 5% on 1000", 1000, percent(5), 1050],
  ["percent 10% on 999", 999, percent(10), 1099],
  ["flat +0 no-op", 2000, flat(0), 2000],
  ["percent 1% on 33350 (half-cent rounding)", 33350, percent(1), 33684],
  ["percent 2.5% on 1000 rounds to nearest rupee", 1000, percent(2.5), 1025],
  ["percent 33.33% approx-third rounding", 300, percent(33.33), 400],
  ["percent 20% cap smaller than raw markup", 5000, percent(20, 500), 5500],
  ["percent 20% cap larger than raw markup (cap inert)", 5000, percent(20, 2000), 6000],
  ["flat +5000 large flat markup", 4500, flat(5000), 9500],
  ["percent on very small fare", 10, percent(50), 15],
  ["percent on fare of 0", 0, percent(10), 0],
  ["flat on fare of 0", 0, flat(25), 25],
  ["cap of exactly 0 is treated as no cap", 4500, percent(10, 0), 4950],
  ["percent 100% doubles the fare", 2500, percent(100), 5000],
  ["percent with cap equal to the raw markup amount", 1000, percent(10, 100), 1100],
  ["flat markup with an (irrelevant) cap field", 1000, flat(200, 9999), 1200],
  ["percent 15% on odd fare 12345", 12345, percent(15), 14197], // 14196.75 -> round to 14197
];

test("applyMarkup golden table (>= 20 cases)", () => {
  for (const [desc, netFare, rule, expected] of GOLDEN) {
    assert.equal(applyMarkup(netFare, rule), expected, desc);
  }
  assert.ok(GOLDEN.length >= 20, `expected >= 20 golden cases, got ${GOLDEN.length}`);
});

test("applyPlatformMarkup delegates to applyMarkup (L1 only)", () => {
  assert.equal(applyPlatformMarkup(4500, percent(2)), applyMarkup(4500, percent(2)));
  assert.equal(applyPlatformMarkup(4500, flat(50)), applyMarkup(4500, flat(50)));
});

test("markupAmount returns the delta between net and marked-up fare", () => {
  assert.equal(markupAmount(4500, 4590), 90);
  assert.equal(markupAmount(4500, 4500), 0);
  assert.equal(markupAmount(4500, 4450), -50);
});

test("applyTwoTierMarkup layers platform then agent, both adapters must match this exactly", () => {
  const tboFare = 4500;
  const platformRule = percent(2); // L1 — currently unused in production (single-tier), but the pure function stays correct.
  const agentRule = percent(3);
  const result = applyTwoTierMarkup(tboFare, platformRule, agentRule);

  const expectedAgentNetRate = applyMarkup(tboFare, platformRule); // 4590
  const expectedCustomerPaid = applyMarkup(expectedAgentNetRate, agentRule); // 4728 (4590*1.03=4727.7 -> 4728)

  assert.equal(result.tboFare, tboFare);
  assert.equal(result.agentNetRate, expectedAgentNetRate);
  assert.equal(result.platformMarkup, expectedAgentNetRate - tboFare);
  assert.equal(result.customerPaid, expectedCustomerPaid);
  assert.equal(result.agentMarkup, expectedCustomerPaid - expectedAgentNetRate);
  // Invariant: the four numbers must reconcile exactly (no drift from rounding
  // applied twice vs. once) — customerPaid is always net + platform + agent.
  assert.equal(result.tboFare + result.platformMarkup + result.agentMarkup, result.customerPaid);
});

test("applyTwoTierMarkup with a zero platform rule == single-tier (matches production config)", () => {
  const tboFare = 4500;
  const zeroPlatform = percent(0);
  const agentRule = flat(75);
  const result = applyTwoTierMarkup(tboFare, zeroPlatform, agentRule);

  assert.equal(result.platformMarkup, 0);
  assert.equal(result.agentNetRate, tboFare);
  assert.equal(result.customerPaid, tboFare + 75);
});

test("golden table values are pinned (regression guard) — spot check a few by hand", () => {
  // These are the exact numbers documented in the original applyMarkup JSDoc
  // examples, preserved verbatim across the dedup refactor.
  assert.equal(applyMarkup(4500, percent(2)), 4590);
  assert.equal(applyMarkup(4500, flat(50)), 4550);
  assert.equal(applyMarkup(4500, percent(2, 50)), 4550);
});
