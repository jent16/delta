import test from "node:test";
import assert from "node:assert/strict";
import { NotFoundError, ValidationError } from "../domain/errors.ts";
import { makeTracker } from "../testing/harness.ts";

const other = (t: ReturnType<typeof makeTracker>) => t.db.prepare("INSERT INTO users (id, name, created_at) VALUES (2, 'Other', 'now')").run();
const count = (t: ReturnType<typeof makeTracker>, table: string) => (t.db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;

test("add: a contact with a company creates (or reuses) that company, case- and spacing-insensitively", () => {
  const t = makeTracker();
  const app = t.service.add(1, { company: "Stripe", roleTitle: "SWE" });
  const p = t.contacts.add(1, { name: "Priya Shah", company: "  stripe ", relationship: "alumni", title: "SWE" });
  assert.deepEqual([p.company, p.companyId, p.relationship], ["Stripe", app.companyId, "alumni"]); // the existing spelling and company
  const q = t.contacts.add(1, { name: "New Co Person", company: "Brand New Co" });
  assert.equal(t.companies.list(1).some((c) => c.name === "Brand New Co"), true);
  assert.equal(q.company, "Brand New Co");
  assert.equal(t.contacts.add(1, { name: "Freelancer" }).companyId, null);
});

test("a contact is validated; a bad one creates nothing, and no company is left behind", () => {
  const t = makeTracker();
  assert.throws(() => t.contacts.add(1, { name: "", company: "Ghost Co" }), ValidationError);
  assert.throws(() => t.contacts.add(1, { name: "A", company: "Ghost Co", linkedinUrl: "javascript:alert(1)" }), ValidationError);
  assert.deepEqual([count(t, "contacts"), t.companies.list(1).length], [0, 0]);
});

test("list: filter by search text, company and relationship, and by who is due for a follow-up", () => {
  const t = makeTracker(); // clock: 2026-09-15
  const stripe = t.service.add(1, { company: "Stripe", roleTitle: "SWE" }).companyId;
  t.contacts.add(1, { name: "Priya Shah", company: "Stripe", relationship: "alumni", followUpOn: "2026-09-10" });
  t.contacts.add(1, { name: "Sam Lee", company: "Stripe", relationship: "recruiter", followUpOn: "2026-09-20" });
  t.contacts.add(1, { name: "Dana Fox", company: "Figma", relationship: "alumni", notes: "met at the career fair" });
  const names = (q: Record<string, unknown>) => t.contacts.list(1, q).map((c) => c.name);
  assert.deepEqual(names({}), ["Dana Fox", "Priya Shah", "Sam Lee"]);
  assert.deepEqual(names({ q: "stripe" }), ["Priya Shah", "Sam Lee"]);                 // the company's name is searchable
  assert.deepEqual(names({ q: "career fair" }), ["Dana Fox"]);                          // and so are notes
  assert.deepEqual(names({ company: String(stripe) }), ["Priya Shah", "Sam Lee"]);
  assert.deepEqual(names({ relationship: "alumni" }), ["Dana Fox", "Priya Shah"]);
  assert.deepEqual(names({ due: "1" }), ["Priya Shah"]);                                // overdue only; Sam's is in the future
  assert.deepEqual(names({ q: "100%" }), []);                                           // a % is text, not a wildcard
  assert.throws(() => t.contacts.list(1, { relationship: "boss" }), ValidationError);
});

test("edit: change fields, move to another company (created if new), clear it, and tidy away a company nothing refers to", () => {
  const t = makeTracker();
  const p = t.contacts.add(1, { name: "Priya", company: "Old Co" });
  assert.equal(t.contacts.edit(1, p.id, { company: "New Co", title: "Engineer" }).company, "New Co");
  assert.deepEqual(t.companies.list(1).map((c) => c.name), ["New Co"]);                // Old Co had nothing else, so it is gone
  assert.equal(t.contacts.edit(1, p.id, { company: null }).companyId, null);
  assert.deepEqual(t.companies.list(1), []);
  assert.equal(t.contacts.edit(1, p.id, { notes: "hi", followUpOn: "2026-10-01" }).followUpOn, "2026-10-01");
  assert.throws(() => t.contacts.edit(1, p.id, {}), ValidationError);
  assert.throws(() => t.contacts.edit(1, 999, { title: "x" }), NotFoundError);
});

test("a company that still has an application or another contact is kept when a contact leaves it", () => {
  const t = makeTracker();
  t.service.add(1, { company: "Stripe", roleTitle: "SWE" });
  const a = t.contacts.add(1, { name: "A", company: "Stripe" });
  t.contacts.edit(1, a.id, { company: "Elsewhere" });
  assert.deepEqual(t.companies.list(1).map((c) => c.name), ["Elsewhere", "Stripe"]);   // still has its application
  const b = t.contacts.add(1, { name: "B", company: "Solo Co" });
  const c2 = t.contacts.add(1, { name: "C", company: "solo co" });
  t.contacts.remove(1, b.id);
  assert.equal(t.companies.list(1).some((c) => c.name === "Solo Co"), true);           // C still works there
  t.contacts.remove(1, c2.id);
  assert.equal(t.companies.list(1).some((c) => c.name === "Solo Co"), false);
});

test("the log: dated entries, backdating allowed, newest-entered is the latest, validated", () => {
  const t = makeTracker();
  const p = t.contacts.add(1, { name: "Priya" });
  t.contacts.addEvent(1, p.id, { kind: "messaged", on: "2026-09-01", note: "intro" });
  t.contacts.addEvent(1, p.id, { kind: "replied" });                                    // today by default
  assert.deepEqual(t.contacts.get(1, p.id).events.map((e) => [e.kind, e.occurredOn, e.note]), [["messaged", "2026-09-01", "intro"], ["replied", "2026-09-15", null]]);
  assert.equal(t.contacts.list(1, {})[0]!.lastEventOn, "2026-09-15");
  assert.throws(() => t.contacts.addEvent(1, p.id, { kind: "yelled" }), ValidationError);
  assert.throws(() => t.contacts.addEvent(1, 999, { kind: "call" }), NotFoundError);
});

test("linking: a person can be linked to many applications and an application can have many people; relinking changes the role", () => {
  const t = makeTracker();
  const a1 = t.service.add(1, { company: "Stripe", roleTitle: "SWE" });
  const a2 = t.service.add(1, { company: "Stripe", roleTitle: "PM" });
  const priya = t.contacts.add(1, { name: "Priya", company: "Stripe" });
  const sam = t.contacts.add(1, { name: "Sam", company: "Stripe" });
  t.contacts.link(1, priya.id, { applicationId: a1.id, role: "referrer" });
  t.contacts.link(1, priya.id, { applicationId: a2.id, role: "referrer" });
  const people = t.contacts.link(1, sam.id, { applicationId: a1.id, role: "recruiter" });
  assert.deepEqual(people.map((p) => [p.contact.name, p.role]), [["Priya", "referrer"], ["Sam", "recruiter"]]);
  assert.deepEqual(t.contacts.get(1, priya.id).applications.map((l) => [l.applicationId, l.roleTitle, l.role]), [[a1.id, "SWE", "referrer"], [a2.id, "PM", "referrer"]]);
  t.contacts.link(1, priya.id, { applicationId: a1.id, role: "interviewer" });          // same pair again: the role changes, no duplicate
  assert.deepEqual(t.contacts.forApplication(1, a1.id).people.map((p) => [p.contact.name, p.role]), [["Priya", "interviewer"], ["Sam", "recruiter"]]);
  assert.equal(count(t, "application_contacts"), 3);
  t.contacts.unlink(1, priya.id, a2.id);
  assert.equal(t.contacts.get(1, priya.id).applications.length, 1);
  assert.equal(t.contacts.list(1, {}).find((c) => c.name === "Priya")!.applications, 1);
  assert.throws(() => t.contacts.link(1, priya.id, { applicationId: 999 }), NotFoundError);
  assert.throws(() => t.contacts.link(1, 999, { applicationId: a1.id }), NotFoundError);
  assert.throws(() => t.contacts.link(1, priya.id, { applicationId: a1.id, role: "boss" }), ValidationError);
});

test("an application's panel: who is linked, other people you know at that company, and the alumni links for its company", () => {
  const t = makeTracker();
  const app = t.service.add(1, { company: "Stripe", roleTitle: "SWE" });
  const linked = t.contacts.add(1, { name: "Linked", company: "Stripe" });
  t.contacts.add(1, { name: "Unlinked", company: "Stripe" });
  t.contacts.add(1, { name: "Elsewhere", company: "Figma" });
  t.contacts.link(1, linked.id, { applicationId: app.id, role: "referrer" });
  const v = t.contacts.forApplication(1, app.id);
  assert.deepEqual(v.people.map((p) => p.contact.name), ["Linked"]);
  assert.deepEqual(v.atCompany.map((c) => c.name), ["Unlinked"]);                       // not the linked one, not other companies'
  assert.equal(v.alumni[0]!.url, "https://www.linkedin.com/search/results/people/?keywords=Stripe"); // no school set: anyone at the company
  assert.equal(v.alumni[0]!.label, "People at Stripe on LinkedIn");
  t.settings.edit(1, { school: "University of Waterloo" });
  assert.match(t.contacts.forApplication(1, app.id).alumni[0]!.label, /^University of Waterloo alumni at Stripe/);
  assert.throws(() => t.contacts.forApplication(1, 999), NotFoundError);
});

test("deleting a person is permanent and takes their log and links with them, but not the applications", () => {
  const t = makeTracker();
  const app = t.service.add(1, { company: "Stripe", roleTitle: "SWE" });
  const p = t.contacts.add(1, { name: "Priya", company: "Stripe" });
  t.contacts.addEvent(1, p.id, { kind: "messaged" });
  t.contacts.link(1, p.id, { applicationId: app.id });
  t.contacts.remove(1, p.id);
  assert.deepEqual([count(t, "contacts"), count(t, "contact_events"), count(t, "application_contacts"), count(t, "applications")], [0, 0, 0, 1]);
  assert.throws(() => t.contacts.get(1, p.id), NotFoundError);
  assert.throws(() => t.contacts.remove(1, p.id), NotFoundError);
});

test("archiving or deleting an application leaves the person; deleting the application row removes only the link", () => {
  const t = makeTracker();
  const app = t.service.add(1, { company: "Stripe", roleTitle: "SWE" });
  const p = t.contacts.add(1, { name: "Priya", company: "Stripe" });
  t.contacts.link(1, p.id, { applicationId: app.id });
  t.service.archive(1, app.id);                                                          // archived, so the link and person remain
  assert.equal(t.contacts.get(1, p.id).applications.length, 1);
  t.db.prepare("DELETE FROM applications WHERE id = ?").run(app.id);                     // a hard delete cascades to the link only
  assert.deepEqual([count(t, "application_contacts"), count(t, "contacts")], [0, 1]);
});

test("merging two companies moves their people too", () => {
  const t = makeTracker();
  const a = t.service.add(1, { company: "Stripe Inc", roleTitle: "SWE" });
  const keep = t.service.add(1, { company: "Stripe", roleTitle: "PM" });
  const p = t.contacts.add(1, { name: "Priya", company: "Stripe Inc" });
  t.companies.merge(1, a.companyId, { into: keep.companyId });
  assert.deepEqual([t.contacts.get(1, p.id).contact.company, t.contacts.get(1, p.id).contact.companyId], ["Stripe", keep.companyId]);
});

test("a contact-only company is created for them and shows on the Companies list with no applications", () => {
  const t = makeTracker();
  t.contacts.add(1, { name: "Priya", company: "Dream Co" });
  assert.deepEqual(t.companies.list(1).map((c) => [c.name, c.applications]), [["Dream Co", 0]]);
});

test("everything is per user: lists, reads, edits, deletes, links and events never cross users", () => {
  const t = makeTracker();
  other(t);
  const app1 = t.service.add(1, { company: "Stripe", roleTitle: "SWE" });
  const app2 = t.service.add(2, { company: "Stripe", roleTitle: "SWE" });
  const mine = t.contacts.add(1, { name: "Mine", company: "Stripe" });
  const theirs = t.contacts.add(2, { name: "Theirs", company: "Stripe" });
  assert.deepEqual(t.contacts.list(2, {}).map((c) => c.name), ["Theirs"]);
  for (const act of [() => t.contacts.get(2, mine.id), () => t.contacts.edit(2, mine.id, { title: "x" }), () => t.contacts.remove(2, mine.id), () => t.contacts.addEvent(2, mine.id, { kind: "call" }),
    () => t.contacts.link(2, mine.id, { applicationId: app2.id }), () => t.contacts.unlink(2, mine.id, app2.id)]) assert.throws(act, NotFoundError);
  // and the other direction: my contact cannot be attached to THEIR application, nor theirs to mine
  assert.throws(() => t.contacts.link(1, mine.id, { applicationId: app2.id }), NotFoundError);
  assert.throws(() => t.contacts.link(2, theirs.id, { applicationId: app1.id }), NotFoundError);
  assert.throws(() => t.contacts.forApplication(2, app1.id), NotFoundError);
  assert.equal(count(t, "application_contacts"), 0);
  assert.equal(t.contacts.get(1, mine.id).contact.title, null);
});

test("the repository checks ownership itself, even if a service forgot to (linking needs both sides to be yours)", () => {
  const t = makeTracker();
  other(t);
  const app2 = t.service.add(2, { company: "Stripe", roleTitle: "SWE" });
  const mine = t.contacts.add(1, { name: "Mine" });
  assert.equal(t.contactRepo.link(1, mine.id, app2.id, "other", "now"), false);
  assert.equal(t.contactRepo.link(2, mine.id, app2.id, "other", "now"), false);
  assert.equal(t.contactRepo.unlink(1, mine.id, app2.id), false);
  assert.equal(t.contactRepo.update(2, mine.id, { title: "x" }, "now"), null);
  assert.equal(t.contactRepo.remove(2, mine.id), false);
  assert.equal(t.contactRepo.addEvent(2, mine.id, { kind: "call", on: "2026-09-01", note: null }, "now"), null);
  assert.deepEqual(t.contactRepo.forApplication(1, app2.id), []);
  assert.deepEqual(t.contactRepo.applicationsOf(2, mine.id), []);
  assert.deepEqual(t.contactRepo.events(2, mine.id), []);
  assert.equal(count(t, "contacts"), 1);
});

test("settings: there is no default school; it can be set and cleared; per user", () => {
  const t = makeTracker();
  other(t);
  assert.equal(t.settings.get(1).school, "");
  assert.equal(t.settings.edit(1, { school: "University of Waterloo" }).school, "University of Waterloo");
  assert.equal(t.settings.get(2).school, "");
  assert.equal(t.settings.edit(1, { school: "" }).school, "");
  assert.equal(count(t, "user_settings"), 0);
  assert.throws(() => t.settings.edit(1, { theme: "dark" }), ValidationError);
});

test("reminders include the people you meant to follow up with: overdue and coming up, most overdue first, only when not scoped to a list", () => {
  const t = makeTracker(); // 2026-09-15
  t.contacts.add(1, { name: "Overdue", followUpOn: "2026-09-10" });
  t.contacts.add(1, { name: "Today", followUpOn: "2026-09-15" });
  t.contacts.add(1, { name: "Soon", followUpOn: "2026-09-20" });
  t.contacts.add(1, { name: "Later", followUpOn: "2026-10-30" });
  t.contacts.add(1, { name: "Unset" });
  const r = t.insights.reminders(1, {}).reminders.contactFollowUps;
  assert.deepEqual(r.map((x) => [x.contact.name, x.daysOverdue]), [["Overdue", 5], ["Today", 0], ["Soon", -5]]);
  const swe = t.lists.all(1).find((l) => l.name === "SWE")!;
  assert.deepEqual(t.insights.reminders(1, { list: String(swe.id) }).reminders.contactFollowUps, []);
  other(t);
  assert.deepEqual(t.insights.reminders(2, {}).reminders.contactFollowUps, []);
});

test("the export carries each person with their log and the applications they are linked to", () => {
  const t = makeTracker();
  const app = t.service.add(1, { company: "Stripe", roleTitle: "SWE" });
  const p = t.contacts.add(1, { name: "Priya", company: "Stripe", email: "p@stripe.com", relationship: "alumni" });
  t.contacts.addEvent(1, p.id, { kind: "messaged", on: "2026-09-01", note: "intro" });
  t.contacts.link(1, p.id, { applicationId: app.id, role: "referrer" });
  const j = t.exports.json(1).body;
  assert.equal(j.version, 3);
  assert.deepEqual(j.contacts, [{ id: p.id, name: "Priya", companyId: app.companyId, company: "Stripe", title: null, email: "p@stripe.com", linkedinUrl: null, relationship: "alumni", notes: "", followUpOn: null, createdAt: p.createdAt,
    log: [{ kind: "messaged", on: "2026-09-01", note: "intro" }], applications: [{ applicationId: app.id, role: "referrer" }] }]);
});

test("the repository never returns another user's log, links or contacts, even when a link row crosses users", () => {
  const t = makeTracker();
  other(t);
  const app1 = t.service.add(1, { company: "Stripe", roleTitle: "SWE" });
  const app2 = t.service.add(2, { company: "Stripe", roleTitle: "SWE" });
  const mine = t.contacts.add(1, { name: "Mine" });
  const theirs = t.contacts.add(2, { name: "Theirs" });
  t.contacts.addEvent(1, mine.id, { kind: "messaged", note: "private" });
  // a row that should be impossible (the link API refuses it), planted directly: reads must STILL not leak across users
  t.db.prepare("INSERT INTO application_contacts (application_id, contact_id, role, created_at) VALUES (?, ?, 'other', 't')").run(app2.id, mine.id);
  assert.deepEqual(t.contactRepo.events(2, mine.id), []);
  assert.deepEqual(t.contactRepo.applicationsOf(2, mine.id), []);
  assert.deepEqual(t.contactRepo.forApplication(1, app2.id), []);          // app 2 is not user 1's
  assert.deepEqual(t.contactRepo.forApplication(2, app2.id), []);          // and the planted contact is not user 2's
  assert.deepEqual(t.contactRepo.exportAll(2).map((x) => x.contact.name), ["Theirs"]);
  assert.deepEqual(t.contactRepo.exportAll(1).map((x) => x.contact.name), ["Mine"]);
  assert.equal(t.contactRepo.exportAll(1)[0]!.events.length, 1);
  void app1; void theirs;
});

test("the export is per user: each user's file holds only their own people", () => {
  const t = makeTracker();
  other(t);
  t.contacts.add(1, { name: "Mine" });
  t.contacts.add(2, { name: "Theirs" });
  assert.deepEqual(t.exports.json(1).body.contacts.map((c) => c.name), ["Mine"]);
  assert.deepEqual(t.exports.json(2).body.contacts.map((c) => c.name), ["Theirs"]);
});

// ---------- pasting a profile link ----------
const LINK = "https://www.linkedin.com/in/priya-shah-4a8b21";

test("pasting a link adds the person at the application's company, linked to it, with the name worked out from the link; 'other' unless you have a school (then an alum)", () => {
  const t = makeTracker();
  const app = t.service.add(1, { company: "Stripe", roleTitle: "SWE" });
  const r = t.contacts.addFromProfile(1, { url: `${LINK}?trk=x`, applicationId: app.id });
  assert.deepEqual([r.created, r.linked, r.contact.name, r.contact.company, r.contact.relationship, r.contact.linkedinUrl], [true, true, "Priya Shah", "Stripe", "other", "https://www.linkedin.com/in/priya-shah-4a8b21"]);
  t.settings.edit(1, { school: "Simon Fraser University" });
  const second = t.contacts.addFromProfile(1, { url: "https://www.linkedin.com/in/dana-fox", applicationId: app.id });
  assert.equal(second.contact.relationship, "alumni");
  assert.equal(t.contacts.addFromProfile(1, { url: "https://www.linkedin.com/in/lee-ho", applicationId: app.id, relationship: "friend" }).contact.relationship, "friend");
  t.contacts.remove(1, second.contact.id);
  t.contacts.remove(1, t.contacts.list(1, { q: "lee" })[0]!.id);
  assert.equal(r.contact.companyId, app.companyId);                                          // the company's own record, not a new one
  assert.deepEqual(t.contacts.forApplication(1, app.id).people.map((p) => [p.contact.name, p.role]), [["Priya Shah", "other"]]);
  assert.equal(t.companies.list(1).length, 1);
});

test("a name or relationship or role you give wins over the guess and the defaults", () => {
  const t = makeTracker();
  const app = t.service.add(1, { company: "Stripe", roleTitle: "SWE" });
  const r = t.contacts.addFromProfile(1, { url: "https://www.linkedin.com/in/jdoe", applicationId: app.id, name: "Jane Doe", relationship: "recruiter", role: "recruiter" });
  assert.deepEqual([r.contact.name, r.contact.relationship, t.contacts.forApplication(1, app.id).people[0]!.role], ["Jane Doe", "recruiter", "recruiter"]);
});

test("pasting the same person again, in ANY spelling of the link, creates no one new and never changes the role they already have", () => {
  const t = makeTracker();
  const app = t.service.add(1, { company: "Stripe", roleTitle: "SWE" });
  const first = t.contacts.addFromProfile(1, { url: LINK, applicationId: app.id, role: "referrer" });
  const again = t.contacts.addFromProfile(1, { url: "https://ca.linkedin.com/in/PRIYA-SHAH-4A8B21/?x=1", applicationId: app.id, role: "interviewer" });
  assert.deepEqual([again.created, again.linked, again.contact.id], [false, false, first.contact.id]);
  assert.equal(t.contacts.forApplication(1, app.id).people[0]!.role, "referrer");
  assert.equal(t.contacts.list(1, {}).length, 1);
});

test("someone you already have is linked to a NEW application rather than duplicated", () => {
  const t = makeTracker();
  const a1 = t.service.add(1, { company: "Stripe", roleTitle: "SWE" });
  const a2 = t.service.add(1, { company: "Stripe", roleTitle: "PM" });
  const p = t.contacts.add(1, { name: "Priya Shah", company: "Stripe", linkedinUrl: "https://www.linkedin.com/in/priya-shah-4a8b21" });
  t.contacts.link(1, p.id, { applicationId: a1.id, role: "referrer" });
  const r = t.contacts.addFromProfile(1, { url: LINK, applicationId: a2.id, role: "interviewer" });
  assert.deepEqual([r.created, r.linked, r.contact.id], [false, true, p.id]);
  assert.deepEqual(t.contacts.get(1, p.id).applications.map((l) => [l.applicationId, l.role]), [[a1.id, "referrer"], [a2.id, "interviewer"]]);
  assert.equal(t.contacts.list(1, {}).length, 1);
});

test("without an application the person is simply added (no company, no link)", () => {
  const t = makeTracker();
  const r = t.contacts.addFromProfile(1, { url: LINK });
  assert.deepEqual([r.created, r.linked, r.contact.company], [true, false, null]);
});

test("a link that isn't a LinkedIn profile, or has no guessable name, is refused with a reason, and nothing is created", () => {
  const t = makeTracker();
  const app = t.service.add(1, { company: "Stripe", roleTitle: "SWE" });
  for (const url of ["https://www.linkedin.com/company/stripe", "javascript:alert(1)", "https://evil.com/in/priya", "not a link", "http://www.linkedin.com/in/priya"]) {
    assert.throws(() => t.contacts.addFromProfile(1, { url, applicationId: app.id }), (e: unknown) => e instanceof ValidationError && e.issues[0]!.field === "url", url);
  }
  assert.throws(() => t.contacts.addFromProfile(1, { url: "https://www.linkedin.com/in/123456789", applicationId: app.id }), (e: unknown) => e instanceof ValidationError && /name/.test(e.message));
  assert.equal(t.contacts.addFromProfile(1, { url: "https://www.linkedin.com/in/123456789", applicationId: app.id, name: "Typed Name" }).contact.name, "Typed Name"); // typing the name fixes it
  assert.equal(t.contacts.list(1, {}).length, 1);
});

test("pasting for an unknown application, or another user's, is refused and creates nothing", () => {
  const t = makeTracker();
  other(t);
  const theirs = t.service.add(2, { company: "Stripe", roleTitle: "SWE" });
  assert.throws(() => t.contacts.addFromProfile(1, { url: LINK, applicationId: 999 }), NotFoundError);
  assert.throws(() => t.contacts.addFromProfile(1, { url: LINK, applicationId: theirs.id }), NotFoundError);
  assert.equal(count(t, "contacts"), 0);
});

test("per user: the same profile pasted by two users makes two separate contacts", () => {
  const t = makeTracker();
  other(t);
  const a = t.contacts.addFromProfile(1, { url: LINK });
  const b = t.contacts.addFromProfile(2, { url: LINK });
  assert.deepEqual([a.created, b.created, a.contact.id === b.contact.id], [true, true, false]);
});
