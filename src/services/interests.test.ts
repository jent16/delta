import test from "node:test";
import assert from "node:assert/strict";
import { DuplicateError, NotFoundError, ValidationError } from "../domain/errors.ts";
import { makeTracker } from "../testing/harness.ts";

const issues = (fn: () => unknown) => {
  try { fn(); } catch (e) { if (e instanceof ValidationError) return e.issues.map((i) => `${i.field}: ${i.message}`); throw e; }
  return [];
};

test("add, list (newest first), edit and remove an interest", () => {
  const t = makeTracker();
  const a = t.interests.add(1, { company: "Stripe", url: "https://stripe.com/jobs/1" });
  t.advance(1);
  const b = t.interests.add(1, { company: "Ramp", note: "talk to Sam" });
  assert.deepEqual(t.interests.list(1).map((i) => i.company), ["Ramp", "Stripe"]);
  const edited = t.interests.edit(1, a.id, { note: "deadline soon", roleTitle: "SWE Intern" });
  assert.deepEqual([edited.note, edited.roleTitle, edited.url], ["deadline soon", "SWE Intern", "https://stripe.com/jobs/1"]); // the rest is untouched
  t.interests.remove(1, b.id);
  assert.deepEqual(t.interests.list(1).map((i) => i.company), ["Stripe"]);
  assert.throws(() => t.interests.remove(1, b.id), NotFoundError);
});

test("one person's interests are invisible and untouchable to another", () => {
  const t = makeTracker();
  t.db.prepare("INSERT INTO users (id, name, created_at) VALUES (2, 'B', 't')").run();
  const mine = t.interests.add(1, { company: "Stripe" });
  assert.deepEqual(t.interests.list(2), []);
  assert.throws(() => t.interests.edit(2, mine.id, { note: "x" }), NotFoundError);
  assert.throws(() => t.interests.remove(2, mine.id), NotFoundError);
  assert.throws(() => t.interests.start(2, mine.id, { roleTitle: "SWE" }), NotFoundError);
  assert.equal(t.interests.list(1).length, 1);
});

test("starting makes a real application with the link and note carried over, then removes the interest", () => {
  const t = makeTracker();
  const i = t.interests.add(1, { company: "Stripe", roleTitle: "SWE Intern", url: "https://stripe.com/jobs/1", note: "ask Sam" });
  const app = t.interests.start(1, i.id, { status: "drafting" });
  assert.deepEqual([app.company, app.roleTitle, app.status, app.url, app.notes], ["Stripe", "SWE Intern", "drafting", "https://stripe.com/jobs/1", "ask Sam"]);
  assert.equal(t.service.list(1, {}).length, 1);
  assert.deepEqual(t.interests.list(1), []);
  assert.equal(t.service.get(1, app.id).events.length, 1); // its history starts with the stage it began in
});

test("starting without a role asks for one; supplying it works; the default stage is saved", () => {
  const t = makeTracker();
  const i = t.interests.add(1, { company: "Ramp" });
  assert.deepEqual(issues(() => t.interests.start(1, i.id, {})), ["roleTitle: is required to start an application"]);
  assert.equal(t.interests.list(1).length, 1); // nothing was lost
  const app = t.interests.start(1, i.id, { roleTitle: "Software Intern" });
  assert.deepEqual([app.status, app.roleTitle, app.url, app.notes], ["saved", "Software Intern", null, ""]);
});

test("if the application can't be made (a duplicate), the interest stays exactly as it was", () => {
  const t = makeTracker();
  t.service.add(1, { company: "Stripe", roleTitle: "SWE Intern" });
  const i = t.interests.add(1, { company: "stripe", roleTitle: "swe intern", note: "keep me" });
  assert.throws(() => t.interests.start(1, i.id, {}), DuplicateError);
  assert.deepEqual(t.interests.list(1).map((x) => [x.company, x.note]), [["stripe", "keep me"]]);
  assert.equal(t.service.list(1, {}).length, 1);
});

test("the data export includes interests, only the person's own", () => {
  const t = makeTracker();
  t.db.prepare("INSERT INTO users (id, name, created_at) VALUES (2, 'B', 't')").run();
  t.interests.add(1, { company: "Stripe", url: "https://stripe.com/jobs/1", note: "n" });
  t.interests.add(2, { company: "Theirs" });
  assert.deepEqual(t.exports.json(1).body.interests.map((i) => [i.company, i.url, i.note]), [["Stripe", "https://stripe.com/jobs/1", "n"]]);
});
