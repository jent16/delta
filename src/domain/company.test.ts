import test from "node:test";
import assert from "node:assert/strict";
import { editDistance, normalizeCompany, searchCompanies } from "./company.ts";
import type { CompanyCandidate } from "./company.ts";

const dir = (...names: string[]): CompanyCandidate[] => names.map((name) => ({ name, source: "directory" }));
const yours = (...names: string[]): CompanyCandidate[] => names.map((name) => ({ name, source: "yours", applications: 1 }));
const names = (r: { name: string }[]) => r.map((x) => x.name);

test("normalizeCompany: case, punctuation, ampersands and legal suffixes don't matter", () => {
  assert.equal(normalizeCompany("Stripe, Inc."), "stripe");
  assert.equal(normalizeCompany("  J.P. Morgan  "), "j p morgan");
  assert.equal(normalizeCompany("AT&T"), "at and t");
  assert.equal(normalizeCompany("Acme Corp"), "acme");
});

test("editDistance: a swapped pair of letters is one edit, not two", () => {
  assert.equal(editDistance("ripling", "rippling"), 1);
  assert.equal(editDistance("stirpe", "stripe"), 1); // transposition
  assert.equal(editDistance("abc", "abc"), 0);
  assert.equal(editDistance("", "abc"), 3);
});

test("ranking: exact, then prefix, then contains; your own spelling beats the directory's", () => {
  const all = [...dir("Stripe", "Stripes Co", "Pinstripe", "Stripe"), ...yours("stripe")];
  const r = searchCompanies("stripe", all);
  assert.deepEqual(r.map((x) => [x.name, x.source, x.match]), [
    ["stripe", "yours", "exact"], // yours wins over the directory's "Stripe", and they are shown once
    ["Stripes Co", "directory", "prefix"],
    ["Pinstripe", "directory", "contains"],
  ]);
});

test("a word in the middle of a name matches", () => {
  assert.deepEqual(names(searchCompanies("sachs", dir("Goldman Sachs", "Other"))), ["Goldman Sachs"]);
});

test("typos find the right company (transposition, missing and wrong letters)", () => {
  assert.deepEqual(names(searchCompanies("ripling", dir("Rippling", "Zipline"))), ["Rippling"]);
  assert.deepEqual(names(searchCompanies("skudrio", yours("Skydio"))), ["Skydio"]);
  assert.deepEqual(names(searchCompanies("stirpe", dir("Stripe"))), ["Stripe"]);
});

test("near-misses are ordered by closeness", () => {
  assert.deepEqual(names(searchCompanies("ripling", dir("Relling", "Rippling"))), ["Rippling", "Relling"]);
});

test("near-miss matching is conservative: short words, a different first letter, or a word in the middle don't count", () => {
  assert.deepEqual(searchCompanies("jane", dir("Hamilton Lane", "Jade Global")), []); // 4 letters: too short to guess
  assert.deepEqual(searchCompanies("goog", dir("Moog")), []);
  assert.deepEqual(searchCompanies("ripling", dir("Zipline")), []); // different first letter
  assert.deepEqual(searchCompanies("stripe", dir("Bluestripe Lane")), [{ name: "Bluestripe Lane", source: "directory", match: "contains" }]); // contained, not "similar"
});

test("near-misses are dropped once there are enough real matches", () => {
  const all = dir("Rippling One", "Rippling Two", "Rippling Three", "Ripling");
  assert.ok(!names(searchCompanies("rippling", all)).includes("Ripling"));
  assert.ok(names(searchCompanies("rippling", dir("Rippling One", "Ripling"))).includes("Ripling"));
});

test("limit, empty queries, and nothing found", () => {
  assert.equal(searchCompanies("a", dir("A1", "A2", "A3", "A4"), 2).length, 2);
  assert.deepEqual(searchCompanies("   ", dir("Stripe")), []);
  assert.deepEqual(searchCompanies("!!!", dir("Stripe")), []);
  assert.deepEqual(searchCompanies("zzzzqq", dir("Stripe")), []);
});

test("a typo in the part you have typed so far still finds the company (an unfinished, misspelt word)", () => {
  assert.deepEqual(names(searchCompanies("norht", dir("Northwind Labs", "Northgate", "Zephyr"))), ["Northgate", "Northwind Labs"]);
  assert.deepEqual(names(searchCompanies("stirp", dir("Stripe", "Zephyr"))), ["Stripe"]); // one swap from the start of "stripe"
});

test("the unfinished-word rule keeps the same limits: first letter must match, and nonsense stays quiet", () => {
  assert.deepEqual(searchCompanies("morht", dir("Northwind Labs")), []);   // different first letter
  assert.deepEqual(searchCompanies("zzxqw", dir("Northwind Labs")), []);
  assert.deepEqual(searchCompanies("nor", dir("Northwind Labs")).map((s) => s.match), ["prefix"]); // short queries are ordinary prefix matching
});
