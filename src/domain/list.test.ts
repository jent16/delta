import test from "node:test";
import assert from "node:assert/strict";
import { ValidationError } from "./errors.ts";
import { narrowQuery, parseListPatch, parseNewList } from "./list.ts";

const issues = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ValidationError) return e.issues.map((i) => i.field);
    throw e;
  }
  return [];
};

test("parseNewList: trims the name, defaults to an 'everything' filter, dedupes values", () => {
  assert.deepEqual(parseNewList({ name: "  All  " }), { name: "All", filter: {} });
  assert.deepEqual(parseNewList({ name: "x", filter: { roleFunctions: ["SWE", "SWE", "Quant"] } }).filter, { roleFunctions: ["SWE", "Quant"] });
});

test("parseNewList: reports every problem at once, and rejects typos instead of ignoring them", () => {
  assert.deepEqual(
    issues(() => parseNewList({ name: "", filter: { roleFunctions: ["Plumber"], statuses: [], secters: ["Fintech"], includeArchived: "yes" }, extra: 1 })).sort(),
    ["extra", "filter.includeArchived", "filter.roleFunctions", "filter.secters", "filter.statuses", "name"],
  );
  assert.deepEqual(issues(() => parseNewList("nope")), ["(body)"]);
  assert.deepEqual(issues(() => parseNewList({ name: "x", filter: [] })), ["filter"]);
  assert.deepEqual(issues(() => parseNewList({ name: "x".repeat(61) })), ["name"]);
});

test("parseListPatch: needs something to change, and validates what it is given", () => {
  assert.deepEqual(issues(() => parseListPatch({})), ["(body)"]);
  assert.deepEqual(issues(() => parseListPatch({ filter: { sectors: ["Plumbing"] } })), ["filter.sectors"]);
  assert.deepEqual(parseListPatch({ name: "Renamed" }), { name: "Renamed" });
});

test("narrowQuery: intersects lists, adds the search, and never widens", () => {
  const swe = { roleFunctions: ["SWE" as const, "Quant" as const] };
  assert.deepEqual(narrowQuery(swe, { statuses: ["applied"], q: "stripe" }), { roleFunctions: ["SWE", "Quant"], statuses: ["applied"], q: "stripe" });
  assert.deepEqual(narrowQuery(swe, { roleFunctions: ["Quant", "PM"] }), { roleFunctions: ["Quant"] }); // PM is outside the list
  assert.deepEqual(narrowQuery({}, {}), {});
});

test("narrowQuery: a contradiction is null, not an empty list the repository would read as 'no filter'", () => {
  assert.equal(narrowQuery({ roleFunctions: ["SWE"] }, { roleFunctions: ["PM"] }), null);
  assert.equal(narrowQuery({ statuses: ["applied"] }, { statuses: ["offer"] }), null);
});

test("narrowQuery: an ad-hoc query cannot reveal archived rows the list hides", () => {
  assert.equal(narrowQuery({}, { includeArchived: true })!.includeArchived, undefined);
  assert.equal(narrowQuery({ includeArchived: true }, {})!.includeArchived, true);
});

test("narrowQuery keeps a 'missing' filter, so 'SWE roles with no sector yet' works", () => {
  assert.deepEqual(narrowQuery({ roleFunctions: ["SWE"] }, { missing: ["sector"] }), { roleFunctions: ["SWE"], missing: ["sector"] });
});
