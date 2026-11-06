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
