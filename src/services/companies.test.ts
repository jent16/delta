import test from "node:test";
import assert from "node:assert/strict";
import { NotFoundError, ValidationError } from "../domain/errors.ts";
import type { CompanyDirectory } from "../domain/ports.ts";
import { makeTracker } from "../testing/harness.ts";

const directory = (names: string[], extra: { available?: boolean; note?: string } = {}): CompanyDirectory => ({
  names: async () => ({ names, available: extra.available ?? true, ...(extra.note ? { note: extra.note } : {}) }),
});
const tracker = (names: string[], extra?: { available?: boolean; note?: string }) => makeTracker(undefined, undefined, directory(names, extra));

test("suggestions combine your own companies (with counts) and the directory, yours first, with a sector hint", async () => {
  const t = tracker(["Jane Street Capital", "Janet Co", "Unrelated Inc"]);
  t.service.add(1, { company: "Jane Street", roleTitle: "SWE" });
  t.service.add(1, { company: "jane street", roleTitle: "Quant" });
  const r = await t.companies.search(1, { q: "jane" });
  assert.equal(r.directoryAvailable, true);
  assert.deepEqual(r.suggestions.map((s) => [s.name, s.source, s.applications ?? null, s.sectorHint]), [
    ["Jane Street", "yours", 2, "Finance"],
    ["Janet Co", "directory", null, null], // directory prefix matches: shorter name first
    ["Jane Street Capital", "directory", null, null],
  ]);
});

test("a company whose applications are all archived is still suggested (you have history with it), with a count of 0", async () => {
  const t = tracker([]);
  const a = t.service.add(1, { company: "Gone Co", roleTitle: "SWE" });
  t.service.archive(1, a.id);
  const s = (await t.companies.search(1, { q: "gone" })).suggestions;
  assert.deepEqual(s.map((x) => [x.name, x.source, x.applications]), [["Gone Co", "yours", 0]]);
});

test("only your own companies are suggested for you", async () => {
  const t = tracker([]);
  t.db.prepare("INSERT INTO users (id, name, created_at) VALUES (2, 'Other', 'now')").run();
  t.service.add(2, { company: "Secret Startup", roleTitle: "SWE" });
  assert.deepEqual((await t.companies.search(1, { q: "secret" })).suggestions, []);
  assert.equal((await t.companies.search(2, { q: "secret" })).suggestions.length, 1);
});

test("when the directory is unavailable, search still works from your tracker and says so", async () => {
  const t = tracker([], { available: false, note: "offline" });
  t.service.add(1, { company: "Stripe", roleTitle: "SWE" });
  const r = await t.companies.search(1, { q: "strip" });
  assert.deepEqual([r.directoryAvailable, r.note, r.suggestions.map((s) => s.name)], [false, "offline", ["Stripe"]]);
});

test("a query is required and the limit is bounded", async () => {
  const t = tracker(["A1", "A2", "A3"]);
  await assert.rejects(t.companies.search(1, {}), ValidationError);
  await assert.rejects(t.companies.search(1, { q: "  " }), ValidationError);
  await assert.rejects(t.companies.search(1, { q: "a", limit: "0" }), ValidationError);
  await assert.rejects(t.companies.search(1, { q: "a", limit: "21" }), ValidationError);
  assert.equal((await t.companies.search(1, { q: "a", limit: "2" })).suggestions.length, 2);
});

test("deleting companies removes them and every application there (archived too); the people stay, with no company", () => {
  const t = makeTracker();
  t.db.prepare("INSERT INTO users (id, name, created_at) VALUES (2, 'B', 't')").run();
  const s1 = t.service.add(1, { company: "Stripe", roleTitle: "SWE" });
  t.service.add(1, { company: "Stripe", roleTitle: "PM" });
  const old = t.service.add(1, { company: "Stripe", roleTitle: "Data" });
  t.service.archive(1, old.id);
  t.service.add(1, { company: "Ramp", roleTitle: "SWE" });
  t.service.add(1, { company: "Figma", roleTitle: "SWE" });
  const theirs = t.service.add(2, { company: "Stripe", roleTitle: "SWE" });
  const person = t.contacts.add(1, { name: "Priya", company: "Stripe" });
  const stripeId = t.companies.list(1).find((c) => c.name === "Stripe")!.id;
  const rampId = t.companies.list(1).find((c) => c.name === "Ramp")!.id;
  t.service.changeStatus(1, s1.id, { status: "applied" });

  assert.deepEqual(t.companies.removeMany(1, { ids: [stripeId, rampId] }), { removed: 2, applications: 4 });
  assert.deepEqual(t.companies.list(1).map((c) => c.name), ["Figma"]);
  assert.deepEqual(t.service.list(1, { includeArchived: "true" }).map((a) => a.company), ["Figma"]);
  assert.equal((t.db.prepare("SELECT COUNT(*) n FROM status_events WHERE application_id = ?").get(s1.id) as { n: number }).n, 0);
  const left = t.contacts.get(1, person.id).contact;
  assert.deepEqual([left.name, left.companyId], ["Priya", null]); // kept, just unattached
  assert.equal(t.service.get(2, theirs.id).application.company, "Stripe"); // another person's Stripe is untouched
  assert.equal(t.companies.list(2).length, 1);
});

test("deleting companies is all or nothing, and never reaches another person's company", () => {
  const t = makeTracker();
  t.db.prepare("INSERT INTO users (id, name, created_at) VALUES (2, 'B', 't')").run();
  t.service.add(1, { company: "Stripe", roleTitle: "SWE" });
  t.service.add(2, { company: "Ramp", roleTitle: "SWE" });
  const mine = t.companies.list(1)[0]!.id;
  const theirs = t.companies.list(2)[0]!.id;
  assert.throws(() => t.companies.removeMany(1, { ids: [mine, theirs] }), NotFoundError);
  assert.equal(t.companies.list(1).length, 1);
  assert.equal(t.service.list(1, {}).length, 1);
  assert.equal(t.companies.list(2).length, 1);
  assert.throws(() => t.companies.removeMany(1, { ids: [] }), ValidationError);
});
