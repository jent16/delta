import test from "node:test";
import assert from "node:assert/strict";
import { DuplicateError, InvalidTransitionError, NotFoundError, ValidationError } from "../domain/errors.ts";
import { createApplicationRepository } from "../repositories/applications.ts";
import { makeTracker } from "../testing/harness.ts";

const base = { company: "Stripe", roleTitle: "SWE Intern", term: "Summer 2027" };

test("add: creates the application and its first status event together", () => {
  const { service } = makeTracker();
  const a = service.add(1, { ...base, appliedOn: "2026-09-01" });
  assert.equal(a.status, "applied");
  const { events } = service.get(1, a.id);
  assert.deepEqual(events.map((e) => [e.status, e.occurredOn]), [["applied", "2026-09-01"]]);
});

test("add: refuses a duplicate, and says which one it duplicates", () => {
  const { service } = makeTracker();
  const first = service.add(1, base);
  assert.throws(() => service.add(1, { company: " STRIPE ", roleTitle: "swe intern", term: "summer 2027" }), (e) => e instanceof DuplicateError && e.existingId === first.id);
  service.add(1, { ...base, roleTitle: "PM Intern" }); // same company, different role: fine
});

test("add: an archived application doesn't block re-adding it", () => {
  const { service } = makeTracker();
  const a = service.add(1, base);
  service.archive(1, a.id);
  assert.doesNotThrow(() => service.add(1, base));
});

test("status: follows the pipeline, writes dated history, and stays consistent", () => {
  const t = makeTracker();
  const a = t.service.add(1, base);
  t.advance(3);
  t.service.changeStatus(1, a.id, { status: "applied" });
  t.advance(10);
  t.service.changeStatus(1, a.id, { status: "interview", note: "recruiter call" });
  const { application, events, nextStatuses } = t.service.get(1, a.id);
  assert.equal(application.status, "interview");
  assert.deepEqual(events.map((e) => e.status), ["saved", "applied", "interview"]);
  assert.deepEqual(events.map((e) => e.occurredOn), ["2026-09-15", "2026-09-18", "2026-09-28"]);
  assert.equal(events[2]?.note, "recruiter call");
  assert.deepEqual([...nextStatuses], ["offer", "rejected", "withdrawn", "ghosted"]);
});

test("INVARIANT: an application's status always equals its newest event — after every operation", () => {
  const t = makeTracker();
  const check = (id: number) => {
    const { application, events } = t.service.get(1, id);
    assert.equal(application.status, events[events.length - 1]?.status);
  };
  const a = t.service.add(1, base);
  check(a.id);
  for (const s of ["applied", "assessment", "interview", "offer"]) {
    t.service.changeStatus(1, a.id, { status: s });
    check(a.id);
  }
  t.service.undoStatusChange(1, a.id);
  check(a.id);
  t.service.undoStatusChange(1, a.id);
  check(a.id);
  assert.equal(t.service.get(1, a.id).application.status, "assessment");
});

test("status: illegal moves are refused with the legal options", () => {
  const { service } = makeTracker();
  const a = service.add(1, base); // saved
  assert.throws(() => service.changeStatus(1, a.id, { status: "offer" }), (e) => e instanceof InvalidTransitionError && e.allowed.includes("applied"));
  service.changeStatus(1, a.id, { status: "applied" });
  service.changeStatus(1, a.id, { status: "rejected" });
  assert.throws(() => service.changeStatus(1, a.id, { status: "interview" }), InvalidTransitionError); // rejected is final
  assert.throws(() => service.changeStatus(1, a.id, { status: "nonsense" }), ValidationError);
});

test("undo: restores the previous status, and refuses when there's nothing to undo", () => {
  const { service } = makeTracker();
  const a = service.add(1, base);
  assert.throws(() => service.undoStatusChange(1, a.id), ValidationError); // only the initial event
  service.changeStatus(1, a.id, { status: "applied" });
  assert.equal(service.undoStatusChange(1, a.id).status, "saved");
  assert.equal(service.get(1, a.id).events.length, 1);
});

test("edit: changes fields, and re-checks duplicates only when identity changed", () => {
  const { service } = makeTracker();
  const a = service.add(1, base);
  const b = service.add(1, { ...base, roleTitle: "PM Intern" });
  assert.equal(service.edit(1, a.id, { notes: "referral from Sam", location: "SF" }).notes, "referral from Sam");
  assert.throws(() => service.edit(1, b.id, { roleTitle: "SWE Intern" }), DuplicateError); // would collide with a
  assert.equal(service.edit(1, b.id, { roleTitle: "Product Intern" }).roleTitle, "Product Intern");
  assert.doesNotThrow(() => service.add(1, { ...base, roleTitle: "PM Intern" })); // b's old identity is free again
});

test("edit: can clear an optional field", () => {
  const { service } = makeTracker();
  const a = service.add(1, { ...base, location: "NYC" });
  assert.equal(service.edit(1, a.id, { location: null }).location, null);
});

test("list: filters, search (including SQL wildcard characters as plain text), and archive", () => {
  const { service } = makeTracker();
  const stripe = service.add(1, { ...base, roleFunction: "SWE", sector: "Fintech" });
  service.add(1, { company: "Figma", roleTitle: "PM Intern", roleFunction: "PM", sector: "Consumer Tech", appliedOn: "2026-09-02" });
  service.add(1, { company: "100%_Co", roleTitle: "SWE", notes: "weird name" });
  const names = (q: Record<string, unknown>) => service.list(1, q).map((a) => a.company).sort();
  assert.deepEqual(names({}), ["100%_Co", "Figma", "Stripe"]);
  assert.deepEqual(names({ function: "PM" }), ["Figma"]);
  assert.deepEqual(names({ sector: "Fintech" }), ["Stripe"]);
  assert.deepEqual(names({ status: "applied" }), ["Figma"]);
  assert.deepEqual(names({ q: "strip" }), ["Stripe"]);
  assert.deepEqual(names({ q: "%" }), ["100%_Co"]); // a literal %, not "match everything"
  assert.deepEqual(names({ q: "_" }), ["100%_Co"]);
  service.archive(1, stripe.id);
  assert.deepEqual(names({}), ["100%_Co", "Figma"]);
  assert.deepEqual(names({ includeArchived: "1" }), ["100%_Co", "Figma", "Stripe"]);
});

test("a user can only ever see and change their own applications", () => {
  const t = makeTracker();
  t.db.prepare("INSERT INTO users (id, name, created_at) VALUES (2, 'Other', 'now')").run();
  const mine = t.service.add(1, base);
  assert.throws(() => t.service.get(2, mine.id), NotFoundError);
  assert.throws(() => t.service.edit(2, mine.id, { notes: "hacked" }), NotFoundError);
  assert.throws(() => t.service.changeStatus(2, mine.id, { status: "applied" }), NotFoundError);
  assert.throws(() => t.service.archive(2, mine.id), NotFoundError);
  assert.deepEqual(t.service.list(2, {}), []);
  assert.doesNotThrow(() => t.service.add(2, base)); // user 2's "duplicate" of user 1's is not a duplicate
});

test("not found", () => {
  const { service } = makeTracker();
  assert.throws(() => service.get(1, 999), NotFoundError);
  assert.throws(() => service.archive(1, 999), NotFoundError);
});

// ---- bulk edit ----

test("editMany sets the same fields on many applications at once", () => {
  const { service } = makeTracker();
  const a = service.add(1, { company: "Jane Street", roleTitle: "SWE" });
  const b = service.add(1, { company: "Citadel", roleTitle: "SWE" });
  const c = service.add(1, { company: "Figma", roleTitle: "SWE" });
  const r = service.editMany(1, { ids: [a.id, b.id], set: { sector: "Finance" } });
  assert.equal(r.updated, 2);
  assert.deepEqual(r.applications.map((x) => x.sector), ["Finance", "Finance"]);
  assert.equal(service.get(1, c.id).application.sector, null); // not in the list: untouched
});

test("editMany is all-or-nothing: one unknown id changes nothing", () => {
  const { service } = makeTracker();
  const a = service.add(1, { company: "Jane Street", roleTitle: "SWE" });
  assert.throws(() => service.editMany(1, { ids: [a.id, 999], set: { sector: "Finance" } }), (e) => e instanceof NotFoundError && /999/.test(e.message));
  assert.equal(service.get(1, a.id).application.sector, null);
});

test("editMany cannot touch another user's applications, even when mixed with your own", () => {
  const t = makeTracker();
  t.db.prepare("INSERT INTO users (id, name, created_at) VALUES (2, 'Other', 'now')").run();
  const mine = t.service.add(1, { company: "Mine", roleTitle: "SWE" });
  const theirs = t.service.add(2, { company: "Theirs", roleTitle: "SWE" });
  assert.throws(() => t.service.editMany(1, { ids: [mine.id, theirs.id], set: { sector: "Finance" } }), NotFoundError);
  assert.equal(t.service.get(1, mine.id).application.sector, null);
  assert.equal(t.service.get(2, theirs.id).application.sector, null);
});

test("editMany updates the 'last changed' time, and validation errors change nothing", () => {
  const t = makeTracker();
  const a = t.service.add(1, { company: "A", roleTitle: "SWE" });
  t.advance(3);
  assert.throws(() => t.service.editMany(1, { ids: [a.id], set: { company: "Hacked" } }), ValidationError);
  t.service.editMany(1, { ids: [a.id], set: { roleFunction: "PM" } });
  const after = t.service.get(1, a.id).application;
  assert.equal(after.roleFunction, "PM");
  assert.equal(after.company, "A");
  assert.notEqual(after.updatedAt, a.updatedAt);
});

test("missing=sector finds what still needs classifying, and bulk edit then removes it from that view", () => {
  const { service } = makeTracker();
  const a = service.add(1, { company: "A", roleTitle: "SWE", sector: "Finance" });
  const b = service.add(1, { company: "B", roleTitle: "SWE" });
  assert.deepEqual(service.list(1, { missing: "sector" }).map((x) => x.id), [b.id]);
  service.editMany(1, { ids: [b.id], set: { sector: "Fintech" } });
  assert.deepEqual(service.list(1, { missing: "sector" }), []);
  assert.equal(service.list(1, {}).length, 2);
  void a;
});

test("the repository's bulk update enforces ownership itself, even if a service forgot to check", () => {
  const t = makeTracker();
  t.db.prepare("INSERT INTO users (id, name, created_at) VALUES (2, 'Other', 'now')").run();
  const mine = t.service.add(1, { company: "Mine", roleTitle: "SWE" });
  const repo = createApplicationRepository(t.db);
  assert.equal(repo.updateMany(2, [mine.id], { sector: "Finance" }, "now"), 0);
  assert.equal(t.service.get(1, mine.id).application.sector, null);
  assert.equal(repo.updateMany(1, [], { sector: "Finance" }, "now"), 0); // nothing to do is not an error
});
