import { test } from "node:test";
import assert from "node:assert/strict";
import { toAgentBooking } from "./agent.controller";

// Hard invariant: agents never see tboFare or platformMarkup in any API
// response. toAgentBooking() is the one enforcement point for every
// agent-facing booking endpoint (list/create/confirm/cancel/pnr-lookup) —
// this test proves the shape directly, without needing a live DB/booking doc.

function fakeDoc(fields: Record<string, unknown>) {
  return { toJSON: () => ({ ...fields }) };
}

test("toAgentBooking strips tboFare and platformMarkup", () => {
  const doc = fakeDoc({
    id: "b1",
    pnr: "ABC123",
    status: "confirmed",
    tboFare: 4500,
    platformMarkup: 90,
    agentMarkup: 150,
    customerPaid: 4740,
  });
  const out = toAgentBooking(doc);
  assert.equal("tboFare" in out, false);
  assert.equal("platformMarkup" in out, false);
  // Fields the agent SHOULD see (their own cut, what the customer paid) survive.
  assert.equal(out.agentMarkup, 150);
  assert.equal(out.customerPaid, 4740);
  assert.equal(out.pnr, "ABC123");
});

test("toAgentBooking is a no-op when the sensitive fields are absent", () => {
  const doc = fakeDoc({ id: "b2", pnr: "XYZ999", status: "pending" });
  const out = toAgentBooking(doc);
  assert.deepEqual(out, { id: "b2", pnr: "XYZ999", status: "pending" });
});

test("toAgentBooking never leaks the sensitive keys even if present with falsy values", () => {
  // 0 is a legitimate platformMarkup value (single-tier pricing) — must still
  // be stripped, not just filtered by truthiness.
  const doc = fakeDoc({ id: "b3", tboFare: 0, platformMarkup: 0, agentMarkup: 0 });
  const out = toAgentBooking(doc);
  assert.equal("tboFare" in out, false);
  assert.equal("platformMarkup" in out, false);
  assert.equal(out.agentMarkup, 0);
});
