import test from "node:test";
import assert from "node:assert/strict";
import { NotFoundError, ValidationError } from "../domain/errors.ts";
import { makeTracker } from "../testing/harness.ts";

function seeded() {
  const t = makeTracker(); // clock: 2026-09-15
  const swe = t.service.add(1, { company: "Stripe", roleTitle: "SWE", roleFunction: "SWE", appliedOn: "2026-09-01" });
  t.service.changeStatus(1, swe.id, { status: "interview", on: "2026-09-10" });
  t.service.add(1, { company: "Figma", roleTitle: "SWE", roleFunction: "SWE", appliedOn: "2026-09-02" });
  t.service.add(1, { company: "Shopify", roleTitle: "PM", roleFunction: "PM", appliedOn: "2026-09-03" });
  return t;
}
const list = (t: ReturnType<typeof makeTracker>, name: string) => t.lists.all(1).find((l) => l.name === name)!;

test("stats cover everything, or just one saved list", () => {
  const t = seeded();
  const all = t.insights.stats(1, {});
  assert.deepEqual([all.scope.list, all.stats.total, all.stats.funnel.applied, all.stats.funnel.interview], [null, 3, 3, 1]);
  const pm = t.insights.stats(1, { list: String(list(t, "PM").id) });
  assert.deepEqual([pm.scope.list?.name, pm.stats.total, pm.stats.funnel.interview], ["PM", 1, 0]);
});

test("filters narrow within a list; a contradiction yields empty stats, not everything", () => {
  const t = seeded();
  const id = String(list(t, "SWE").id);
  assert.equal(t.insights.stats(1, { list: id, status: "interview" }).stats.total, 1);
  assert.equal(t.insights.stats(1, { list: id, function: "PM" }).stats.total, 0);
});

test("archived applications are left out of stats", () => {
  const t = seeded();
  t.service.archive(1, t.service.list(1, { q: "figma" })[0]!.id);
  assert.equal(t.insights.stats(1, {}).stats.total, 2);
});

test("an unknown or malformed list is an error, and one user's list is invisible to another", () => {
  const t = seeded();
  t.db.prepare("INSERT INTO users (id, name, created_at) VALUES (2, 'Other', 'now')").run();
  assert.throws(() => t.insights.stats(1, { list: "999" }), NotFoundError);
  assert.throws(() => t.insights.stats(1, { list: "abc" }), ValidationError);
  assert.throws(() => t.insights.stats(2, { list: String(list(t, "SWE").id) }), NotFoundError);
  assert.equal(t.insights.stats(2, {}).stats.total, 0); // user 2 sees none of user 1's data
});

test("reminders use today's date from the clock, and can be scoped to a list", () => {
  const t = seeded();
  const stripe = t.service.list(1, { q: "stripe" })[0]!;
  const shopify = t.service.list(1, { q: "shopify" })[0]!;
  t.service.edit(1, stripe.id, { followUpOn: "2026-09-14" });   // yesterday
  t.service.edit(1, shopify.id, { followUpOn: "2026-09-16" });  // tomorrow
  const all = t.insights.reminders(1, {}).reminders;
  assert.equal(all.today, "2026-09-15");
  assert.deepEqual(all.followUps.map((f) => [f.application.company, f.daysOverdue]), [["Stripe", 1], ["Shopify", -1]]);
  const pm = t.insights.reminders(1, { list: String(list(t, "PM").id) }).reminders;
  assert.deepEqual(pm.followUps.map((f) => f.application.company), ["Shopify"]);
  t.advance(30);
  assert.ok(t.insights.reminders(1, {}).reminders.stale.length >= 1); // silence has accumulated
});

test("reminder windows are validated", () => {
  const t = seeded();
  for (const bad of [{ days: "-1" }, { days: "1.5" }, { days: "abc" }, { staleDays: "999" }]) {
    assert.throws(() => t.insights.reminders(1, bad), ValidationError, JSON.stringify(bad));
  }
  assert.doesNotThrow(() => t.insights.reminders(1, { days: "0", staleDays: "0" }));
});

test("pipeline: every row carries its progress, newest activity first", () => {
  const t = seeded();
  t.advance(1);
  const shopify = t.service.list(1, { q: "shopify" })[0]!;
  t.service.changeStatus(1, shopify.id, { status: "assessment", on: "2026-09-16" }); // touched most recently
  const { scope, rows } = t.insights.pipeline(1, {});
  assert.equal(scope.list, null);
  assert.equal(rows[0]!.application.company, "Shopify");
  const byCompany = Object.fromEntries(rows.map((r) => [r.application.company, r.progress]));
  assert.deepEqual(byCompany.Stripe, { level: 3, outcome: null });  // reached interview
  assert.deepEqual(byCompany.Figma, { level: 1, outcome: null });   // applied
  assert.deepEqual(byCompany.Shopify, { level: 2, outcome: null }); // assessment
});

test("pipeline: a rejected application still shows how far it got", () => {
  const t = seeded();
  const stripe = t.service.list(1, { q: "stripe" })[0]!;
  t.service.changeStatus(1, stripe.id, { status: "rejected", on: "2026-09-12" });
  const row = t.insights.pipeline(1, {}).rows.find((r) => r.application.company === "Stripe")!;
  assert.deepEqual(row.progress, { level: 3, outcome: "rejected" });
});

test("pipeline: scoped by list and filters like stats, and archived applications are left out", () => {
  const t = seeded();
  const pm = t.insights.pipeline(1, { list: String(list(t, "PM").id) });
  assert.equal(pm.scope.list?.name, "PM");
  assert.deepEqual(pm.rows.map((r) => r.application.company), ["Shopify"]);
  assert.equal(t.insights.pipeline(1, { list: String(list(t, "SWE").id), function: "PM" }).rows.length, 0); // a contradiction is empty, not everything
  t.service.archive(1, t.service.list(1, { q: "figma" })[0]!.id);
  assert.equal(t.insights.pipeline(1, {}).rows.length, 2);
});

test("pipeline: same-moment ties are ordered by id so the table never shuffles", () => {
  const t = makeTracker();
  const ids = ["A", "B", "C"].map((c) => t.service.add(1, { company: c, roleTitle: "SWE", roleFunction: "SWE" }).id); // all created at the same fake instant
  assert.deepEqual(t.insights.pipeline(1, {}).rows.map((r) => r.application.id), [...ids].reverse());
});

test("pipeline: another user's applications never appear, and a bad list is an error", () => {
  const t = seeded();
  t.db.prepare("INSERT INTO users (id, name, created_at) VALUES (2, 'Other', 'now')").run();
  assert.equal(t.insights.pipeline(2, {}).rows.length, 0);
  assert.throws(() => t.insights.pipeline(1, { list: "999" }), NotFoundError);
  assert.throws(() => t.insights.pipeline(1, { list: "abc" }), ValidationError);
});

test("pipeline: rows carry the applied date and last-change date, falling back to history when the applied date is blank", () => {
  const t = makeTracker();
  const a = t.service.add(1, { company: "A", roleTitle: "SWE", roleFunction: "SWE" }); // saved today, no applied date
  t.service.changeStatus(1, a.id, { status: "applied", on: "2026-09-03" });
  t.service.changeStatus(1, a.id, { status: "assessment", on: "2026-09-12" });
  t.service.add(1, { company: "B", roleTitle: "SWE", roleFunction: "SWE", appliedOn: "2026-09-01" });
  const rows = Object.fromEntries(t.insights.pipeline(1, {}).rows.map((r) => [r.application.company, r]));
  assert.deepEqual([rows.A!.appliedOn, rows.A!.lastChangeOn], ["2026-09-03", "2026-09-12"]); // from the history
  assert.equal(rows.A!.application.appliedOn, null);                                        // so the fallback really was needed
  assert.deepEqual([rows.B!.appliedOn, rows.B!.lastChangeOn], ["2026-09-01", "2026-09-01"]); // the application's own date wins
});

test("pipeline: ordered by the date of the last status change, not by when the row was edited", () => {
  const t = makeTracker();
  const old = t.service.add(1, { company: "Old", roleTitle: "SWE", roleFunction: "SWE", appliedOn: "2026-06-01" });
  t.service.add(1, { company: "New", roleTitle: "SWE", roleFunction: "SWE", appliedOn: "2026-09-10" });
  t.advance(5);
  t.service.edit(1, old.id, { notes: "edited just now" }); // touches updatedAt, but nothing "happened" to the application
  assert.deepEqual(t.insights.pipeline(1, {}).rows.map((r) => r.application.company), ["New", "Old"]);
});

test("pipeline: scoped, filtered and ordered identically for a saved list", () => {
  const t = seeded();
  const swe = t.insights.pipeline(1, { list: String(list(t, "SWE").id) });
  assert.deepEqual(swe.rows.map((r) => r.application.company), ["Stripe", "Figma"]); // Stripe moved most recently
});

test("pipeline: when the application's own applied date and its history disagree, the application's own date is shown", () => {
  const t = makeTracker();
  const a = t.service.add(1, { company: "A", roleTitle: "SWE", roleFunction: "SWE", appliedOn: "2026-09-01" });
  t.service.edit(1, a.id, { appliedOn: "2026-09-02" }); // corrected by hand; the history event still says the 1st
  assert.equal(t.insights.pipeline(1, {}).rows[0]!.appliedOn, "2026-09-02");
});
