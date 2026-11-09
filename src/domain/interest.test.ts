import test from "node:test";
import assert from "node:assert/strict";
import { parseInterestPatch, parseNewInterest, parseStart } from "./interest.ts";
import { ValidationError } from "./errors.ts";

const fields = (fn: () => unknown) => {
  try { fn(); } catch (e) { if (e instanceof ValidationError) return e.issues.map((i) => i.field).sort(); throw e; }
  return [];
};

test("a new interest needs only a company; the rest is optional and trimmed", () => {
  assert.deepEqual(parseNewInterest({ company: "  Stripe " }), { company: "Stripe", roleTitle: null, url: null, note: "" });
  assert.deepEqual(parseNewInterest({ company: "Stripe", roleTitle: " SWE Intern ", url: " https://stripe.com/jobs/1 ", note: " ask Sam " }),
    { company: "Stripe", roleTitle: "SWE Intern", url: "https://stripe.com/jobs/1", note: "ask Sam" });
  assert.deepEqual(parseNewInterest({ company: "Stripe", roleTitle: "  ", url: "", note: null }), { company: "Stripe", roleTitle: null, url: null, note: "" });
  assert.deepEqual(fields(() => parseNewInterest({})), ["company"]);
  assert.deepEqual(fields(() => parseNewInterest({ company: "   " })), ["company"]);
  assert.deepEqual(fields(() => parseNewInterest([])), ["(body)"]);
});

test("the link must be an http(s) link; other schemes, nonsense and unknown fields are refused", () => {
  for (const url of ["javascript:alert(1)", "ftp://x.co/a", "not a link", "stripe.com/jobs"]) assert.deepEqual(fields(() => parseNewInterest({ company: "A", url })), ["url"], url);
  assert.deepEqual(fields(() => parseNewInterest({ company: "A", url: "http://x.co/a" })), []);
  assert.deepEqual(fields(() => parseNewInterest({ company: "A", link: "https://x.co" })), ["link"]); // a typo is an error, not silently dropped
});

test("lengths match an application's: company and role 200, note 5000", () => {
  assert.deepEqual(fields(() => parseNewInterest({ company: "x".repeat(200) })), []);
  assert.deepEqual(fields(() => parseNewInterest({ company: "x".repeat(201) })), ["company"]);
  assert.deepEqual(fields(() => parseNewInterest({ company: "A", roleTitle: "x".repeat(201) })), ["roleTitle"]);
  assert.deepEqual(fields(() => parseNewInterest({ company: "A", note: "x".repeat(5000) })), []);
  assert.deepEqual(fields(() => parseNewInterest({ company: "A", note: "x".repeat(5001) })), ["note"]);
  assert.deepEqual(fields(() => parseNewInterest({ company: 5 })), ["company"]);
});

test("a patch changes only what it names; clearing is allowed except for the company", () => {
  assert.deepEqual(parseInterestPatch({ note: "hi" }), { note: "hi" });
  assert.deepEqual(parseInterestPatch({ url: "", roleTitle: null, note: "" }), { url: null, roleTitle: null, note: "" });
  assert.deepEqual(fields(() => parseInterestPatch({ company: "" })), ["company"]);
  assert.deepEqual(fields(() => parseInterestPatch({})), ["(body)"]);
  assert.deepEqual(fields(() => parseInterestPatch({ url: "nope" })), ["url"]);
});

test("starting: the stage is saved or drafting (default saved), and a role can be supplied", () => {
  assert.deepEqual(parseStart(undefined), { status: "saved", roleTitle: null });
  assert.deepEqual(parseStart({}), { status: "saved", roleTitle: null });
  assert.deepEqual(parseStart({ status: "drafting", roleTitle: " SWE " }), { status: "drafting", roleTitle: "SWE" });
  assert.deepEqual(fields(() => parseStart({ status: "applied" })), ["status"]); // you start by saving or drafting, not by claiming you applied
  assert.deepEqual(fields(() => parseStart({ company: "x" })), ["company"]);
});
