import test from "node:test";
import assert from "node:assert/strict";
import { CompanyExistsError, NotFoundError, ValidationError } from "../domain/errors.ts";
import { createApplicationRepository } from "../repositories/applications.ts";
import { makeTracker } from "../testing/harness.ts";

// A company is stored once with its sector; applications point at it.

const sectorsOf = (t: ReturnType<typeof makeTracker>) => Object.fromEntries(t.service.list(1, {}).map((a) => [a.id, a.sector]));
const companyRows = (t: ReturnType<typeof makeTracker>) => t.companies.list(1).map((c) => [c.name, c.sector, c.applications] as const);

test("adding applications creates the company once and reuses it, whatever the capitalisation or spacing", () => {
  const t = makeTracker();
  const a = t.service.add(1, { company: "Stripe", roleTitle: "SWE Intern" });
  const b = t.service.add(1, { company: "  stripe ", roleTitle: "PM Intern" });
  const c = t.service.add(1, { company: "STRIPE", roleTitle: "Data Intern" });
  assert.equal(new Set([a.companyId, b.companyId, c.companyId]).size, 1);
  assert.deepEqual(companyRows(t), [["Stripe", null, 3]]); // the first spelling is kept
  assert.equal(b.company, "Stripe");                        // and an application reads its company's name, not its own copy
});

test("the first sector offered sets the company; a later application can't overwrite it", () => {
  const t = makeTracker();
  t.service.add(1, { company: "Stripe", roleTitle: "A", sector: "Fintech" });
  const second = t.service.add(1, { company: "Stripe", roleTitle: "B", sector: "Consulting" }); // ignored: the company already has one
  assert.equal(second.sector, "Fintech");
  assert.deepEqual(companyRows(t), [["Stripe", "Fintech", 2]]);
  // a company with no sector yet takes the first one offered
  t.service.add(1, { company: "Figma", roleTitle: "A" });
  t.service.add(1, { company: "Figma", roleTitle: "B", sector: "Consumer Tech" });
  assert.deepEqual(companyRows(t).find((c) => c[0] === "Figma"), ["Figma", "Consumer Tech", 2]);
});

test("setting the sector on ONE application sets it for every application at that company", () => {
  const t = makeTracker();
  const a = t.service.add(1, { company: "Stripe", roleTitle: "A" });
  const b = t.service.add(1, { company: "Stripe", roleTitle: "B" });
  const other = t.service.add(1, { company: "Figma", roleTitle: "A" });
  t.service.edit(1, a.id, { sector: "Fintech" });
  assert.deepEqual(sectorsOf(t), { [a.id]: "Fintech", [b.id]: "Fintech", [other.id]: null });
  t.service.edit(1, b.id, { sector: null }); // and clearing it clears it for all
  assert.deepEqual(sectorsOf(t), { [a.id]: null, [b.id]: null, [other.id]: null });
});

test("bulk 'set sector' sets each company once, however many of its applications are selected, and reports applications", () => {
  const t = makeTracker();
  const ids = [t.service.add(1, { company: "A", roleTitle: "1" }), t.service.add(1, { company: "A", roleTitle: "2" }), t.service.add(1, { company: "B", roleTitle: "1" })].map((x) => x.id);
  const untouched = t.service.add(1, { company: "C", roleTitle: "1" });
  const r = t.service.editMany(1, { ids: [ids[0]!, ids[2]!], set: { sector: "Finance" } }); // one of A's two applications, and B's
  assert.equal(r.updated, 2);
  assert.deepEqual(companyRows(t), [["A", "Finance", 2], ["B", "Finance", 1], ["C", null, 1]]); // A's OTHER application follows, because the sector is A's
  assert.equal(t.service.get(1, untouched.id).application.sector, null);
});

test("sector filters, saved lists and stats all see the company's sector", () => {
  const t = makeTracker();
  t.service.add(1, { company: "Jane Street", roleTitle: "Quant", roleFunction: "Quant" });
  const x = t.service.add(1, { company: "Acme", roleTitle: "SWE", roleFunction: "SWE" });
  assert.equal(t.service.list(1, { sector: "Finance" }).length, 0);
  assert.deepEqual(t.service.list(1, { missing: "sector" }).length, 2);
  t.companies.edit(1, t.companies.list(1).find((c) => c.name === "Jane Street")!.id, { sector: "Finance" });
  assert.deepEqual(t.service.list(1, { sector: "Finance" }).map((a) => a.company), ["Jane Street"]);
  assert.deepEqual(t.service.list(1, { missing: "sector" }).map((a) => a.id), [x.id]);
  assert.equal(t.insights.stats(1, {}).stats.bySector.Finance, 1);
  const fintechAdjacent = t.lists.all(1).find((l) => l.name === "Fintech-adjacent")!;
  assert.equal(t.lists.get(1, fintechAdjacent.id).count, 1);
  assert.equal(t.service.list(1, { q: "jane" }).length, 1); // searching still finds by company name
});

test("a company is not created when the application fails: no empty companies are left behind", () => {
  const t = makeTracker();
  assert.throws(() => t.service.add(1, { company: "Ghost Co", roleTitle: "" }), ValidationError);
  assert.deepEqual(companyRows(t), []);
  t.service.add(1, { company: "Real Co", roleTitle: "SWE" });
  assert.throws(() => t.service.add(1, { company: "real co", roleTitle: "swe" })); // a duplicate
  assert.deepEqual(companyRows(t), [["Real Co", null, 1]]);
});

test("naming a different company on an application MOVES it, creating that company if new, and tidies the old one away", () => {
  const t = makeTracker();
  const a = t.service.add(1, { company: "Stirpe", roleTitle: "SWE", sector: "Fintech" }); // a typo, alone at its company
  const moved = t.service.edit(1, a.id, { company: "Stripe" });
  assert.equal(moved.company, "Stripe");
  assert.deepEqual(companyRows(t), [["Stripe", null, 1]]); // "Stirpe" is gone; the new company has no sector of its own
  const keep = t.service.add(1, { company: "Stripe", roleTitle: "PM" });
  t.service.edit(1, keep.id, { company: "Figma" });
  assert.deepEqual(companyRows(t), [["Figma", null, 1], ["Stripe", null, 1]]); // Stripe still has the first one, so it stays
});

test("renaming a company renames it on every application, keeps duplicate detection working, and refuses a name you already have", () => {
  const t = makeTracker();
  const a = t.service.add(1, { company: "Stirpe", roleTitle: "SWE", term: "Summer 2027" });
  t.service.add(1, { company: "Stirpe", roleTitle: "PM" });
  t.service.add(1, { company: "Figma", roleTitle: "SWE" });
  const id = a.companyId;
  const renamed = t.companies.edit(1, id, { name: "Stripe" });
  assert.deepEqual([renamed.name, renamed.applications], ["Stripe", 2]);
  assert.deepEqual(t.service.list(1, { q: "stripe" }).map((x) => x.company), ["Stripe", "Stripe"]);
  // the duplicate key follows the new name, so re-adding under the CORRECT spelling is caught, and the old typo no longer is
  assert.throws(() => t.service.add(1, { company: "stripe", roleTitle: "swe", term: "summer 2027" }), /already|duplicate/i);
  assert.doesNotThrow(() => t.service.add(1, { company: "Stirpe", roleTitle: "SWE", term: "Summer 2027" }));
  // a name another company has: refused, and says who
  const figma = t.companies.list(1).find((c) => c.name === "Figma")!;
  assert.throws(() => t.companies.edit(1, figma.id, { name: "  STRIPE " }), (e: unknown) => e instanceof CompanyExistsError && e.existingId === id && e.existingName === "Stripe");
  // changing only the capitalisation or spacing is fine
  assert.equal(t.companies.edit(1, id, { name: "STRIPE" }).name, "STRIPE");
});

test("editing validates: a name or a sector is required, the sector must be real, and unknown fields are refused", () => {
  const t = makeTracker();
  const { companyId } = t.service.add(1, { company: "A", roleTitle: "x" });
  for (const bad of [{}, { name: "" }, { name: "   " }, { name: 5 }, { sector: "Mining" }, { colour: "red" }, null, [], "x"]) assert.throws(() => t.companies.edit(1, companyId, bad), ValidationError, JSON.stringify(bad));
  assert.equal(t.companies.edit(1, companyId, { sector: "Fintech" }).sector, "Fintech");
  assert.equal(t.companies.edit(1, companyId, { sector: "" }).sector, null); // empty clears it
  assert.throws(() => t.companies.edit(1, 9999, { sector: "Fintech" }), NotFoundError);
});

test("merging moves every application, keeps the target's name, takes a sector the target lacked, and removes the source", () => {
  const t = makeTracker();
  const typo = t.service.add(1, { company: "Stripe Inc", roleTitle: "SWE", sector: "Fintech" });
  t.service.add(1, { company: "Stripe Inc", roleTitle: "PM" });
  const keep = t.service.add(1, { company: "Stripe", roleTitle: "Data" });
  const r = t.companies.merge(1, typo.companyId, { into: keep.companyId });
  assert.deepEqual([r.company.name, r.company.sector, r.company.applications, r.moved], ["Stripe", "Fintech", 3, 2]);
  assert.deepEqual(companyRows(t), [["Stripe", "Fintech", 3]]);
  assert.deepEqual(t.service.list(1, {}).map((a) => a.company), ["Stripe", "Stripe", "Stripe"]);
  // history came along untouched
  assert.equal(t.service.get(1, typo.id).events.length, 1);
});

test("merging keeps the target's sector when it has one, and refuses when it would create a duplicate", () => {
  const t = makeTracker();
  const a = t.service.add(1, { company: "Stripe Inc", roleTitle: "SWE", term: "Summer 2027", sector: "Consulting" });
  const b = t.service.add(1, { company: "Stripe", roleTitle: "SWE", term: "Summer 2027", sector: "Fintech" });
  assert.throws(() => t.companies.merge(1, a.companyId, { into: b.companyId }), /already has: SWE \(Summer 2027\)/);
  assert.deepEqual(companyRows(t).length, 2); // nothing changed
  t.service.archive(1, a.id); // archived ones don't count as duplicates
  const r = t.companies.merge(1, a.companyId, { into: b.companyId });
  assert.equal(r.company.sector, "Fintech");
  assert.throws(() => t.companies.merge(1, b.companyId, { into: b.companyId }), /itself/);
  assert.throws(() => t.companies.merge(1, b.companyId, { into: 999 }), NotFoundError);
  assert.throws(() => t.companies.merge(1, b.companyId, {}), ValidationError);
});

test("companies are per user: one user can't see, edit or merge another's, and the same name is two companies", () => {
  const t = makeTracker();
  t.db.prepare("INSERT INTO users (id, name, created_at) VALUES (2, 'Other', 'now')").run();
  const mine = t.service.add(1, { company: "Stripe", roleTitle: "SWE", sector: "Fintech" });
  const theirs = t.service.add(2, { company: "Stripe", roleTitle: "SWE" });
  assert.notEqual(mine.companyId, theirs.companyId);
  assert.deepEqual(t.companies.list(2).map((c) => [c.name, c.sector]), [["Stripe", null]]);
  assert.throws(() => t.companies.edit(2, mine.companyId, { sector: "Finance" }), NotFoundError);
  assert.throws(() => t.companies.merge(2, theirs.companyId, { into: mine.companyId }), NotFoundError);
  assert.equal(t.service.get(1, mine.id).application.sector, "Fintech");
});

test("search offers your company's own sector as the hint (ahead of the built-in guess), with its id", async () => {
  const t = makeTracker();
  const a = t.service.add(1, { company: "Stripe", roleTitle: "SWE", sector: "Consulting" }); // deliberately not the built-in guess (Fintech)
  const hit = (await t.companies.search(1, { q: "stripe" })).suggestions[0]!;
  assert.deepEqual([hit.name, hit.source, hit.id, hit.sector, hit.sectorHint], ["Stripe", "yours", a.companyId, "Consulting", "Consulting"]);
  const t2 = makeTracker();
  t2.service.add(1, { company: "Stripe", roleTitle: "SWE" }); // no sector set: fall back to the guess
  assert.equal((await t2.companies.search(1, { q: "stripe" })).suggestions[0]!.sectorHint, "Fintech");
});

test("the export carries each company once with its sector, and each application's companyId", () => {
  const t = makeTracker();
  const a = t.service.add(1, { company: "Stripe", roleTitle: "A", sector: "Fintech" });
  t.service.add(1, { company: "Stripe", roleTitle: "B" });
  const j = t.exports.json(1).body;
  assert.deepEqual(j.companies, [{ id: a.companyId, name: "Stripe", sector: "Fintech" }]);
  assert.deepEqual(j.applications.map((x) => [x.companyId, x.company, x.sector]), [[a.companyId, "Stripe", "Fintech"], [a.companyId, "Stripe", "Fintech"]]);
});

test("after a merge, duplicate detection uses the surviving name: the moved applications are recognised, and a re-add is refused", () => {
  const t = makeTracker();
  const typo = t.service.add(1, { company: "Stripe Inc", roleTitle: "SWE" });
  const keep = t.service.add(1, { company: "Stripe", roleTitle: "PM" });
  t.companies.merge(1, typo.companyId, { into: keep.companyId });
  assert.throws(() => t.service.add(1, { company: "stripe", roleTitle: "swe" }), /already|duplicate/i);   // the moved one counts
  assert.doesNotThrow(() => t.service.add(1, { company: "Stripe Inc", roleTitle: "SWE" }));                  // the old name is a different company again
});

test("merge ignores ARCHIVED applications at the target when looking for duplicates", () => {
  const t = makeTracker();
  const from = t.service.add(1, { company: "Stripe Inc", roleTitle: "SWE" });
  const old = t.service.add(1, { company: "Stripe", roleTitle: "SWE" });
  t.service.archive(1, old.id); // an archived duplicate must not block the merge
  const r = t.companies.merge(1, from.companyId, { into: old.companyId });
  assert.equal(r.moved, 1);
});

test("the repositories check ownership themselves, even if a service forgot to", () => {
  const t = makeTracker();
  t.db.prepare("INSERT INTO users (id, name, created_at) VALUES (2, 'Other', 'now')").run();
  const mine = t.service.add(1, { company: "Stripe", roleTitle: "SWE", sector: "Fintech" });
  const apps = createApplicationRepository(t.db);
  // user 2 reaching for user 1's company or application changes nothing
  assert.equal(t.companyRepo.setSector(2, mine.companyId, "Consulting", "now"), null);
  assert.equal(t.companyRepo.rename(2, mine.companyId, "Hacked", "now"), null);
  assert.equal(t.companyRepo.merge(2, mine.companyId, mine.companyId, "now"), null);
  apps.updateMany(2, [mine.id], { sector: "Consulting" }, "now");
  apps.update(2, mine.id, { sector: "Consulting" }, null, "now");
  const after = t.service.get(1, mine.id).application;
  assert.deepEqual([after.company, after.sector], ["Stripe", "Fintech"]);
});
