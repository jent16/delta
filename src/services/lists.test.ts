import test from "node:test";
import assert from "node:assert/strict";
import { DuplicateError, NotFoundError, ValidationError } from "../domain/errors.ts";
import { parseNewList } from "../domain/list.ts";
import { createListRepository } from "../repositories/lists.ts";
import { makeTracker } from "../testing/harness.ts";

// The starter lists come from migration 0002 (SQL), so these tests run against
// the REAL migrated database.

function seed(t: ReturnType<typeof makeTracker>) {
  const add = (company: string, roleFunction: string, sector: string | null, extra: object = {}) =>
    t.service.add(1, { company, roleTitle: "Intern", roleFunction, sector, ...extra });
  return {
    stripe: add("Stripe", "SWE", "Fintech"),
    janeStreet: add("Jane Street", "SWE", "Finance"),
    citadel: add("Citadel", "Quant", "Finance"),
    figma: add("Figma", "SWE", "Consumer Tech"),
    shopify: add("Shopify", "PM", "E-commerce/Retail"),
    goldman: add("Goldman Sachs", "PM", "Finance"),
  };
}
const byName = (t: ReturnType<typeof makeTracker>, name: string) => t.lists.all(1).find((l) => l.name === name)!;
const companies = (r: { applications: { company: string }[] }) => r.applications.map((a) => a.company).sort();

test("the starter lists exist, and every one passes the domain validator (SQL cannot drift from the code)", () => {
  const t = makeTracker();
  assert.deepEqual(t.lists.all(1).map((l) => l.name), ["SWE", "PM", "Fintech-adjacent"]);
  for (const l of t.lists.all(1)) assert.doesNotThrow(() => parseNewList({ name: l.name, filter: l.filter }), l.name);
});

test("lists are views: one application can match several, and nothing is copied", () => {
  const t = makeTracker();
  seed(t);
  const swe = companies(t.lists.applications(1, byName(t, "SWE").id, {}));
  const fintech = companies(t.lists.applications(1, byName(t, "Fintech-adjacent").id, {}));
  const pm = companies(t.lists.applications(1, byName(t, "PM").id, {}));
  assert.deepEqual(swe, ["Figma", "Jane Street", "Stripe"]);
  // SWE/Quant at a Finance or Fintech employer — Figma (consumer tech) and the PM roles are out
  assert.deepEqual(fintech, ["Citadel", "Jane Street", "Stripe"]);
  assert.deepEqual(pm, ["Goldman Sachs", "Shopify"]);
  assert.equal((t.db.prepare("SELECT COUNT(*) c FROM applications").get() as { c: number }).c, 6); // still six rows, however many lists
});

test("counts are live: add, change or archive an application and every list follows", () => {
  const t = makeTracker();
  const a = seed(t);
  assert.equal(byName(t, "Fintech-adjacent").count, 3);
  t.service.add(1, { company: "Two Sigma", roleTitle: "SWE Intern", roleFunction: "SWE", sector: "Finance" });
  assert.equal(byName(t, "Fintech-adjacent").count, 4);
  t.service.edit(1, a.figma.id, { sector: "Fintech" }); // moves into the list with no list bookkeeping
  assert.equal(byName(t, "Fintech-adjacent").count, 5);
  t.service.archive(1, a.stripe.id);
  assert.equal(byName(t, "Fintech-adjacent").count, 4);
  assert.equal(byName(t, "SWE").count, t.lists.applications(1, byName(t, "SWE").id, {}).applications.length); // count == rows shown
});

test("searching and filtering within a list only narrows it", () => {
  const t = makeTracker();
  const a = seed(t);
  t.service.changeStatus(1, a.stripe.id, { status: "applied" });
  const id = byName(t, "Fintech-adjacent").id;
  assert.deepEqual(companies(t.lists.applications(1, id, { status: "applied" })), ["Stripe"]);
  assert.deepEqual(companies(t.lists.applications(1, id, { q: "street" })), ["Jane Street"]);
  assert.deepEqual(companies(t.lists.applications(1, id, { function: "Quant" })), ["Citadel"]);
  // asking for PMs inside the SWE/Quant list is a contradiction: nothing, NOT everything
  assert.deepEqual(t.lists.applications(1, id, { function: "PM" }).applications, []);
  // 'Shopify' exists, but not in this list
  assert.deepEqual(t.lists.applications(1, id, { q: "shopify" }).applications, []);
});

test("search also matches location", () => {
  const t = makeTracker();
  t.service.add(1, { company: "Stripe", roleTitle: "SWE Intern", location: "Toronto, ON" });
  assert.equal(t.service.list(1, { q: "toronto" }).length, 1);
});

test("create: validates, and refuses a duplicate name ignoring case", () => {
  const t = makeTracker();
  const l = t.lists.create(1, { name: "Quant", filter: { roleFunctions: ["Quant"] } });
  assert.equal(l.count, 0);
  assert.throws(() => t.lists.create(1, { name: "quant" }), (e) => e instanceof DuplicateError && e.existingId === l.id && /list/.test(e.message));
  assert.throws(() => t.lists.create(1, { name: "Bad", filter: { sectors: ["Plumbing"] } }), ValidationError);
});

test("edit: rename and re-filter; renaming to its own name with different case is allowed, to another list's is not", () => {
  const t = makeTracker();
  const swe = byName(t, "SWE");
  assert.equal(t.lists.edit(1, swe.id, { name: "swe" }).name, "swe");
  assert.throws(() => t.lists.edit(1, swe.id, { name: "pm" }), DuplicateError);
  assert.deepEqual(t.lists.edit(1, swe.id, { filter: { roleFunctions: ["SWE", "Data"] } }).filter, { roleFunctions: ["SWE", "Data"] });
});

test("deleting a list deletes only the list", () => {
  const t = makeTracker();
  seed(t);
  t.lists.remove(1, byName(t, "SWE").id);
  assert.deepEqual(t.lists.all(1).map((l) => l.name), ["PM", "Fintech-adjacent"]);
  assert.equal(t.service.list(1, {}).length, 6);
  t.lists.remove(1, byName(t, "PM").id);
  assert.throws(() => t.lists.get(1, 999), NotFoundError);
});

test("a user only sees and changes their own lists", () => {
  const t = makeTracker();
  t.db.prepare("INSERT INTO users (id, name, created_at) VALUES (2, 'Other', 'now')").run();
  const mine = byName(t, "SWE");
  assert.deepEqual(t.lists.all(2), []); // the starter lists belong to user 1 only
  assert.throws(() => t.lists.get(2, mine.id), NotFoundError);
  assert.throws(() => t.lists.edit(2, mine.id, { name: "x" }), NotFoundError);
  assert.throws(() => t.lists.remove(2, mine.id), NotFoundError);
  assert.throws(() => t.lists.applications(2, mine.id, {}), NotFoundError);
  assert.doesNotThrow(() => t.lists.create(2, { name: "SWE" })); // same name, different user
});

test("the repository enforces ownership itself, even if a service forgot to check", () => {
  // The service checks ownership first, so these writes are normally unreachable.
  // They are tested directly because "the service remembers" is one line of
  // defence, not the only one.
  const t = makeTracker();
  t.db.prepare("INSERT INTO users (id, name, created_at) VALUES (2, 'Other', 'now')").run();
  const repo = createListRepository(t.db);
  const mine = byName(t, "SWE");
  assert.equal(repo.remove(2, mine.id), false);
  assert.equal(repo.update(2, mine.id, { name: "hacked" }, "now"), null);
  assert.equal(byName(t, "SWE").id, mine.id); // untouched
});

test("inside a list, missing=sector shows only what still needs classifying", () => {
  const t = makeTracker();
  t.service.add(1, { company: "Classified Co", roleTitle: "SWE", roleFunction: "SWE", sector: "Finance" });
  t.service.add(1, { company: "Unclassified Co", roleTitle: "SWE", roleFunction: "SWE" });
  t.service.add(1, { company: "Some PM Co", roleTitle: "PM", roleFunction: "PM" }); // unclassified, but not in the SWE list
  const swe = byName(t, "SWE").id;
  assert.deepEqual(companies(t.lists.applications(1, swe, { missing: "sector" })), ["Unclassified Co"]);
  assert.equal(t.lists.applications(1, swe, {}).applications.length, 2);
});
