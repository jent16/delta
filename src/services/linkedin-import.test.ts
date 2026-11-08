import test from "node:test";
import assert from "node:assert/strict";
import { ValidationError } from "../domain/errors.ts";
import { createContactImportLedger } from "../repositories/import-ledger.ts";
import { makeTracker } from "../testing/harness.ts";

const HEADER = "First Name,Last Name,URL,Email Address,Company,Position,Connected On";
const FILE = (...lines: string[]) => [HEADER, ...lines].join("\n");
const setup = () => {
  const t = makeTracker();
  t.service.add(1, { company: "Stripe", roleTitle: "SWE" });
  t.service.add(1, { company: "Jane Street", roleTitle: "Quant" });
  t.service.add(1, { company: "Amazon", roleTitle: "SDE" });
  return t;
};
const count = (t: ReturnType<typeof makeTracker>, table: string) => (t.db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;
const CSV = FILE(
  "Priya,Shah (she/her),https://www.linkedin.com/in/priya-shah,,Stripe,University Recruiter,05 Nov 2026",
  "Sam,Lee,https://www.linkedin.com/in/sam-lee,sam@js.com,Jane Street Capital,Engineer,01 Oct 2026",
  "Dana,Fox,https://www.linkedin.com/in/dana-fox,,Amazon Web Services,Manager,01 Sep 2026",
  "Rex,Unknown,https://www.linkedin.com/in/rex,,Some Startup,Founder,01 Aug 2026",
  "Rey,Unknown,https://www.linkedin.com/in/rey,,Some Startup,Founder,01 Aug 2026",
  "Solo,Freelance,https://www.linkedin.com/in/solo,,,Consultant,01 Jul 2026",
);

test("preview: counts and lists what would happen, and writes nothing at all", () => {
  const t = setup();
  const r = t.linkedin.preview(1, { csv: CSV });
  assert.deepEqual(r.summary, { total: 6, create: 1, needsConfirmation: 2, alreadyImported: 0, alreadyInPeople: 0, duplicateInFile: 0, untracked: 2, noCompany: 1, invalid: 0, unreadable: 0 });
  // Stripe matches exactly; "Jane Street Capital" starts with your "Jane Street" and "Amazon Web Services" is an alias: both ask
  assert.deepEqual(r.items.map((i) => [i.name, i.action]), [["Priya Shah", "create"], ["Sam Lee", "needs_confirmation"], ["Dana Fox", "needs_confirmation"]]);
  assert.deepEqual([count(t, "contacts"), count(t, "contact_import_records"), t.linkedinBackups.length], [0, 0, 0]);
  // the biggest employers you don't have, so a company of yours under another spelling stands out
  assert.deepEqual(r.untrackedTop, [{ company: "Some Startup", count: 2 }]);
});

test("the untracked people are counted but not listed, so a 2,000-person network is not 2,000 rows", () => {
  const t = setup();
  const lines = Array.from({ length: 300 }, (_, i) => `P${i},Q${i},https://www.linkedin.com/in/p${i},,Elsewhere ${i % 7},Eng,01 Jan 2026`);
  const r = t.linkedin.preview(1, { csv: FILE(...lines, "A,B,https://www.linkedin.com/in/ab,,Stripe,Eng,01 Jan 2026") });
  assert.equal(r.summary.untracked, 300);
  assert.deepEqual(r.items.map((i) => i.name), ["A B"]);
  assert.equal(r.untrackedTop.length, 7);
  assert.equal(r.untrackedTop[0]!.count, 43);
});

test("commit adds the matched people to YOUR company (its spelling, its record), with a clean profile link and where they came from", () => {
  const t = setup();
  const r = t.linkedin.commit(1, { csv: CSV });
  assert.equal(r.created, 1);
  const p = t.contacts.list(1, {})[0]!;
  assert.deepEqual([p.name, p.company, p.title, p.relationship, p.linkedinUrl, p.notes], ["Priya Shah", "Stripe", "University Recruiter", "recruiter", "https://www.linkedin.com/in/priya-shah", "Imported from LinkedIn. Connected 2026-11-05."]);
  assert.equal(p.companyId, t.companies.list(1).find((c) => c.name === "Stripe")!.id);
  assert.equal(t.companies.list(1).length, 3);                      // no company was invented for the skipped people
  assert.equal(r.items.find((i) => i.name === "Priya Shah")!.contactId, p.id);
});

test("the backup hook runs once, right before writing, and only when something will be written", () => {
  const t = setup();
  t.linkedin.commit(1, { csv: FILE("Rex,Unknown,https://www.linkedin.com/in/rex,,Some Startup,Founder,01 Aug 2026") }); // nothing to add
  assert.equal(t.linkedinBackups.length, 0);
  t.linkedin.commit(1, { csv: CSV });
  assert.equal(t.linkedinBackups.length, 1);
});

test("importing twice never duplicates: the second run reports everyone as imported before", () => {
  const t = setup();
  t.linkedin.commit(1, { csv: CSV });
  const again = t.linkedin.commit(1, { csv: CSV });
  assert.equal(again.created, 0);
  assert.equal(again.summary.alreadyImported, 1);
  assert.equal(count(t, "contacts"), 1);
  assert.equal(count(t, "contact_import_records"), 1);
  assert.equal(t.linkedinBackups.length, 1); // the second run had nothing to write, so no second backup
});

test("a person you DELETED is not brought back by a re-import: deleting is a choice, and the ledger remembers", () => {
  const t = setup();
  t.linkedin.commit(1, { csv: CSV });
  const p = t.contacts.list(1, {})[0]!;
  t.contacts.remove(1, p.id);
  assert.equal(count(t, "contact_import_records"), 1);              // the ledger row stays (contact_id becomes NULL)
  const r = t.linkedin.commit(1, { csv: CSV });
  assert.deepEqual([r.created, r.items[0]!.reason], [0, "imported before, then deleted by you"]);
  assert.equal(count(t, "contacts"), 0);
});

test("someone you already added by hand is not added again (by profile link, or by name and company)", () => {
  const t = setup();
  t.contacts.add(1, { name: "Priya S.", company: "Stripe", linkedinUrl: "https://ca.linkedin.com/in/Priya-Shah/" });
  const r = t.linkedin.preview(1, { csv: CSV });
  assert.equal(r.summary.alreadyInPeople, 1);
  assert.equal(r.summary.create, 0);
});

test("a 'similar' company is added only when you confirm one of the offered companies for THAT person", () => {
  const t = setup();
  const sam = t.linkedin.preview(1, { csv: CSV }).items.find((i) => i.name === "Sam Lee")!;
  const jane = t.companies.list(1).find((c) => c.name === "Jane Street")!;
  const stripe = t.companies.list(1).find((c) => c.name === "Stripe")!;
  t.linkedin.commit(1, { csv: CSV, accept: { [sam.key]: stripe.id } });        // Stripe was not offered for Sam
  assert.equal(t.contacts.list(1, {}).some((c) => c.name === "Sam Lee"), false);
  const r = t.linkedin.commit(1, { csv: CSV, accept: { [sam.key]: jane.id } });
  assert.equal(r.items.find((i) => i.name === "Sam Lee")!.action, "create");
  const added = t.contacts.list(1, {}).find((c) => c.name === "Sam Lee")!;
  assert.deepEqual([added.company, added.email], ["Jane Street", "sam@js.com"]);            // YOUR spelling, not "Jane Street Capital"
});

test("a re-import after you have accepted nothing leaves the pending people pending (a later run can confirm them)", () => {
  const t = setup();
  t.linkedin.commit(1, { csv: CSV });
  const r = t.linkedin.preview(1, { csv: CSV });
  assert.equal(r.summary.needsConfirmation, 2);
});

test("a company added AFTER the first import is picked up by running the import again", () => {
  const t = setup();
  const file = FILE("Rex,Unknown,https://www.linkedin.com/in/rex,,Some Startup,Founder,01 Aug 2026");
  assert.equal(t.linkedin.commit(1, { csv: file }).created, 0);
  t.service.add(1, { company: "Some Startup", roleTitle: "SWE" });             // you applied there since
  const r = t.linkedin.commit(1, { csv: file });
  assert.deepEqual([r.created, t.contacts.list(1, {})[0]!.company], [1, "Some Startup"]);
});

test("not a Connections file, an empty request, an unknown field and a bad choice are all refused with a reason", () => {
  const t = setup();
  assert.throws(() => t.linkedin.preview(1, { csv: "a,b\n1,2" }), (e: unknown) => e instanceof ValidationError && /First Name/.test(e.message));
  for (const bad of [{}, { csv: "" }, { csv: 5 }, { csv: CSV, extra: 1 }, { csv: CSV, accept: { x: "no" } }, { csv: CSV, accept: [] }, null, "x"]) assert.throws(() => t.linkedin.preview(1, bad), ValidationError, JSON.stringify(bad));
  assert.throws(() => t.linkedin.preview(1, { csv: "x".repeat(8_000_001) }), ValidationError);
});

test("per user: another user's companies, contacts and import history never leak into the plan", () => {
  const t = setup();
  t.db.prepare("INSERT INTO users (id, name, created_at) VALUES (2, 'Other', 'now')").run();
  t.linkedin.commit(1, { csv: CSV });
  const theirs = t.linkedin.preview(2, { csv: CSV });                          // user 2 has no companies: nobody matches, and user 1's import history is invisible
  assert.deepEqual([theirs.summary.create, theirs.summary.alreadyImported, theirs.summary.alreadyInPeople], [0, 0, 0]);
  assert.equal(theirs.summary.untracked, 5);                                   // (the sixth has no company at all)
});

test("one bad row never aborts the others: it is reported on its row and retried by the next run", () => {
  const t = setup();
  const file = FILE("Ok,One,https://www.linkedin.com/in/ok,,Stripe,Eng,01 Jan 2026", "N".repeat(201) + ",x,https://www.linkedin.com/in/long,,Stripe,Eng,01 Jan 2026", "Ok,Two,https://www.linkedin.com/in/ok2,,Stripe,Eng,01 Jan 2026");
  const r = t.linkedin.commit(1, { csv: file });
  assert.deepEqual([r.created, r.items.map((i) => i.action)], [2, ["create", "invalid", "create"]]);
  assert.match(r.items[1]!.reason!, /name/);
  assert.equal(count(t, "contact_import_records"), 2);                          // the failed one is not recorded
});

test("the untracked employers are listed biggest first, then by name", () => {
  const t = setup();
  const lines = [...Array(2).fill("Small Co"), ...Array(5).fill("Big Co"), ...Array(2).fill("Another Co")].map((c, i) => `P${i},Q,https://www.linkedin.com/in/p${i},,${c},Eng,01 Jan 2026`);
  assert.deepEqual(t.linkedin.preview(1, { csv: FILE(...lines) }).untrackedTop, [{ company: "Big Co", count: 5 }, { company: "Another Co", count: 2 }, { company: "Small Co", count: 2 }]);
});

test("a file over the size limit is refused for being too large, not for some other reason", () => {
  const t = setup();
  assert.throws(() => t.linkedin.preview(1, { csv: `${HEADER}\n${"x".repeat(8_000_001)}` }), (e: unknown) => e instanceof ValidationError && /too large/.test(e.message));
});

test("the ledger never overwrites: the first contact recorded for a person stays the record", () => {
  const t = setup();
  const a = t.contacts.add(1, { name: "A" });
  const b = t.contacts.add(1, { name: "B" });
  const ledger = createContactImportLedger(t.db);
  ledger.record(1, "linkedin", "url:x", a.id, "t1");
  ledger.record(1, "linkedin", "url:x", b.id, "t2");
  assert.equal(ledger.known(1, "linkedin").get("url:x"), a.id);
  assert.equal(ledger.known(2, "linkedin").size, 0);
  assert.equal(ledger.known(1, "other").size, 0);
});
