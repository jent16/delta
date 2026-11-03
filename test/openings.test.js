const test = require("node:test");
const assert = require("node:assert/strict");
const { parseLocation, degreeMatches, parseTerm, termWindow, isTermRelevant, findOpenings } = require("../lib/openings");

test("parseLocation: US and Canada structure", () => {
  assert.deepEqual(parseLocation("San Jose, CA"), { region: "us", subdivision: "CA", city: "San Jose" });
  assert.deepEqual(parseLocation("Toronto, ON, Canada"), { region: "canada", subdivision: "ON", city: "Toronto" });
  // extra comma segments stay in the city rather than breaking the parse
  assert.deepEqual(parseLocation("Kanata, Ottawa, ON, Canada"), { region: "canada", subdivision: "ON", city: "Kanata, Ottawa" });
  assert.deepEqual(parseLocation("Basking Ridge, Bernards, NJ"), { region: "us", subdivision: "NJ", city: "Basking Ridge, Bernards" });
});

test("parseLocation: 'UK' must not be mistaken for a US state abbreviation", () => {
  assert.equal(parseLocation("London, UK").region, "intl");
  assert.equal(parseLocation("Remote in UK").region, "intl");
});

test("parseLocation: bare tokens seen in real Simplify data", () => {
  assert.deepEqual(parseLocation("NYC"), { region: "us", subdivision: "NY", city: "NYC" });
  assert.equal(parseLocation("SF").subdivision, "CA");
  assert.equal(parseLocation("LA").region, "us"); // bare state abbreviation
  assert.equal(parseLocation("Texas").subdivision, "TX");
  assert.equal(parseLocation("United States").region, "us");
  assert.equal(parseLocation("Remote in US").region, "us");
  assert.equal(parseLocation("Remote in Canada").region, "canada");
  assert.equal(parseLocation("Singapore").region, "intl");
  assert.equal(parseLocation("Dubai - United Arab Emirates").region, "intl");
  assert.equal(parseLocation("").region, "intl");
});

test("degreeMatches: unspecified matches everyone, explicit higher-only excludes", () => {
  assert.equal(degreeMatches([], "Bachelor's"), true);
  assert.equal(degreeMatches(undefined, "PhD"), true);
  assert.equal(degreeMatches(["PhD"], "Bachelor's"), false);
  assert.equal(degreeMatches(["Master's", "PhD"], "Bachelor's"), false);
  assert.equal(degreeMatches(["Bachelor's", "Master's"], "Bachelor's"), true);
  assert.equal(degreeMatches(["PhD"], "all"), true);
});

test("parseTerm: orders terms chronologically, rejects junk", () => {
  assert.ok(parseTerm("Fall 2026") < parseTerm("Winter 2027"));
  assert.ok(parseTerm("Winter 2027") < parseTerm("Spring 2027"));
  assert.ok(parseTerm("Spring 2027") < parseTerm("Summer 2027"));
  assert.ok(parseTerm("Summer 2027") < parseTerm("Fall 2027"));
  assert.equal(parseTerm("N/A"), null);
  assert.equal(parseTerm("Summer"), null);
});

test("termWindow: current term through exactly one year out", () => {
  const w = termWindow(new Date(2026, 8, 15)); // Sept 15 2026 -> Fall 2026
  const rel = (t) => isTermRelevant(t, w);
  assert.equal(rel("Summer 2026"), false); // this summer already ended
  assert.equal(rel("Fall 2026"), true);
  assert.equal(rel("Winter 2027"), true);
  assert.equal(rel("Summer 2027"), true);
  assert.equal(rel("Fall 2027"), true); // inclusive upper bound
  assert.equal(rel("Winter 2028"), false);
  assert.equal(rel("Summer 2016"), false);
  assert.equal(rel("N/A"), false);
});

test("termWindow: December counts as next year's Winter", () => {
  const w = termWindow(new Date(2026, 11, 15));
  assert.equal(isTermRelevant("Winter 2027", w), true);
  assert.equal(isTermRelevant("Fall 2026", w), false);
  assert.equal(isTermRelevant("Winter 2028", w), true);
  assert.equal(isTermRelevant("Spring 2028", w), false);
});

// ---- findOpenings against stubbed Simplify data (no network) ----
const NOW = new Date(2026, 8, 15);
const L = (o) => ({ active: true, is_visible: true, source: "Simplify", company_name: "Co", title: "T", url: "u", date_posted: 100, sponsorship: "Other", degrees: [], ...o });
const INTERN = [
  L({ id: "A", terms: ["Summer 2027"], locations: ["San Jose, CA"], category: "Software Engineering", degrees: ["Bachelor's"], date_posted: 300 }),
  L({ id: "B", terms: ["Summer 2016"], locations: ["San Jose, CA"], category: "Software" }),
  L({ id: "C", terms: ["Fall 2029"], locations: ["San Jose, CA"], category: "Software" }),
  L({ id: "D", terms: ["Winter 2025", "Summer 2027"], locations: ["Toronto, ON, Canada"], category: "Product Management", degrees: ["PhD"], date_posted: 200 }),
  L({ id: "E", terms: ["Summer 2027"], locations: ["San Jose, CA"], active: false }),
  L({ id: "F", terms: ["Summer 2027"], locations: ["San Jose, CA"], is_visible: false }),
  L({ id: "G", terms: ["Spring 2027"], locations: ["London, UK"], category: "Quant", date_posted: 100 }),
];
const NEWGRAD = [L({ id: "N1", locations: ["Austin, TX"], category: "Software" })]; // new-grad data has no terms field at all

test.before(() => {
  global.fetch = async (url) => ({ ok: true, json: async () => (String(url).includes("New-Grad") ? NEWGRAD : INTERN) });
});

const ids = (r) => r.listings.map((l) => l.id);

test("findOpenings: drops inactive/invisible and out-of-window terms, newest first", async () => {
  const r = await findOpenings({ type: "intern", now: NOW });
  assert.deepEqual(ids(r), ["A", "D", "G"]);
  assert.equal(r.total, 3);
});

test("findOpenings: term dropdown only offers in-window terms", async () => {
  const r = await findOpenings({ type: "intern", now: NOW });
  // D also lists Winter 2025, but only terms that are themselves in-window are offered
  assert.deepEqual(r.availableTerms, ["Spring 2027", "Summer 2027"]);
});

test("findOpenings: region -> state -> city cascade", async () => {
  const us = await findOpenings({ type: "intern", now: NOW, region: "us" });
  assert.deepEqual(ids(us), ["A"]);
  assert.deepEqual(us.availableStates, ["CA"]);
  const ca = await findOpenings({ type: "intern", now: NOW, region: "us", state: "CA" });
  assert.deepEqual(ca.availableCities, ["San Jose"]);
  assert.deepEqual(ids(await findOpenings({ type: "intern", now: NOW, region: "us", state: "CA", city: "San Jose" })), ["A"]);
  assert.deepEqual(ids(await findOpenings({ type: "intern", now: NOW, region: "canada" })), ["D"]);
  assert.deepEqual(ids(await findOpenings({ type: "intern", now: NOW, region: "intl" })), ["G"]);
});

test("findOpenings: degree filter keeps unspecified, drops higher-only", async () => {
  assert.deepEqual(ids(await findOpenings({ type: "intern", now: NOW, degree: "Bachelor's" })), ["A", "G"]);
  assert.deepEqual(ids(await findOpenings({ type: "intern", now: NOW, degree: "PhD" })), ["D", "G"]);
});

test("findOpenings: category groups merge inconsistent raw names", async () => {
  assert.deepEqual(ids(await findOpenings({ type: "intern", now: NOW, category: "software" })), ["A"]);
  assert.deepEqual(ids(await findOpenings({ type: "intern", now: NOW, category: "product" })), ["D"]);
});

test("findOpenings: term filter and new-grad path (no terms, no window)", async () => {
  assert.deepEqual(ids(await findOpenings({ type: "intern", now: NOW, term: "Spring 2027" })), ["G"]);
  const ng = await findOpenings({ type: "newgrad", now: NOW });
  assert.deepEqual(ids(ng), ["N1"]);
  assert.deepEqual(ng.availableTerms, []);
});
