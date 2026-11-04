import test from "node:test";
import assert from "node:assert/strict";
import { ValidationError } from "../domain/errors.ts";
import type { SourceRow } from "../domain/import.ts";
import { createApplicationRepository } from "../repositories/applications.ts";
import { createImportLedger } from "../repositories/import-ledger.ts";
import { createImportService } from "./import.ts";
import { makeTracker } from "../testing/harness.ts";

// A fake source whose rows the test can change between runs, like a Notion
// table the user keeps editing. Everything else is the real stack.
function setup(initial: SourceRow[]) {
  let rows = initial;
  const sourceId = "notion:abc";
  const t = makeTracker(undefined, { notion: () => ({ id: sourceId, fetchRows: async () => rows }) });
  return { ...t, setRows: (r: SourceRow[]) => (rows = r), rowsNow: () => rows, sourceId };
}
const REQ = { database: "anything", roleFunction: "SWE" };

let n = 0;
const r = (fields: Record<string, string>, extra: Partial<SourceRow> = {}): SourceRow => ({
  externalId: `row-${++n}`,
  fields: { ...fields, "(title)": fields.Company ?? "" },
  createdOn: "2026-09-01",
  editedOn: "2026-09-20",
  ...extra,
});
const swe = (company: string, role: string, status: string, applied = "", extra: Record<string, string> = {}) =>
  r({ Company: company, "Role/Program": role, Status: status, ...(applied ? { Applied: applied } : {}), ...extra });

const count = (t: ReturnType<typeof setup>, table = "applications") => (t.db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;

test("preview changes nothing", async () => {
  const t = setup([swe("Stripe", "SWE Intern", "Applied", "2026-09-05")]);
  const res = await t.imports.preview(1, REQ);
  assert.equal(res.summary.create, 1);
  assert.equal(count(t), 0);
  assert.equal(count(t, "import_records"), 0);
  assert.equal(count(t, "status_events"), 0);
});

test("commit creates what the preview promised, with real status history", async () => {
  const t = setup([
    swe("Stripe", "SWE Intern", "Applied", "2026-09-05"),
    swe("Figma", "SWE", "x", "2026-09-06", {}),
    swe("Notion", "SWE", "In process"),
    swe("Netflix", "SWE Intern (Summer 2027)", "Bookmarked"),
  ]);
  const preview = await t.imports.preview(1, REQ);
  const res = await t.imports.commit(1, REQ);
  assert.deepEqual(res.summary, preview.summary); // same plan
  assert.equal(res.summary.create, 4);

  const apps = t.service.list(1, {});
  const byCo = Object.fromEntries(apps.map((a) => [a.company, a]));
  assert.deepEqual([byCo.Stripe!.status, byCo.Figma!.status, byCo.Notion!.status, byCo.Netflix!.status], ["applied", "rejected", "drafting", "saved"]);
  assert.equal(byCo.Netflix!.term, "Summer 2027");
  assert.equal(byCo.Stripe!.sector, "Fintech"); // guessed
  // the rejected row has two dated events, in order
  const { events } = t.service.get(1, byCo.Figma!.id);
  assert.deepEqual(events.map((e) => [e.status, e.occurredOn]), [["applied", "2026-09-06"], ["rejected", "2026-09-20"]]);
  assert.equal(count(t, "import_records"), 4);
});

test("running the import again creates nothing", async () => {
  const t = setup([swe("Stripe", "SWE Intern", "Applied", "2026-09-05"), swe("Figma", "SWE", "Bookmarked")]);
  await t.imports.commit(1, REQ);
  const again = await t.imports.commit(1, REQ);
  assert.deepEqual([again.summary.create, again.summary.alreadyImported], [0, 2]);
  assert.equal(count(t), 2);
  assert.equal(count(t, "status_events"), 2);
});

test("Delta is the source of truth: edits and archiving survive a re-import, and the source's changes are not pulled in", async () => {
  const rowA = swe("Stripe", "SWE Intern", "Applied", "2026-09-05");
  const rowB = swe("Figma", "SWE", "Bookmarked");
  const t = setup([rowA, rowB]);
  await t.imports.commit(1, REQ);
  const [stripe, figma] = [t.service.list(1, { q: "stripe" })[0]!, t.service.list(1, { q: "figma" })[0]!];
  t.service.edit(1, stripe.id, { notes: "recruiter replied" });
  t.service.archive(1, figma.id); // you decided you don't want it
  // ...while the Notion rows change (someone flips a status, you add a note there)
  t.setRows([{ ...rowA, fields: { ...rowA.fields, Status: "x", Notes: "overwrite?" } }, rowB]);

  const again = await t.imports.commit(1, REQ);
  assert.equal(again.summary.create, 0);
  assert.equal(t.service.get(1, stripe.id).application.notes, "recruiter replied");
  assert.equal(t.service.get(1, stripe.id).application.status, "applied");
  assert.deepEqual(t.service.list(1, {}).map((a) => a.company), ["Stripe"]); // Figma stays archived, not resurrected
});

test("an invalid row is reported and not recorded; fixing it in the source imports just that row", async () => {
  const broken = swe("", "Forward Deployed Engineer", "Applied", "2026-09-05");
  const fine = swe("Stripe", "SWE", "Applied", "2026-09-05");
  const t = setup([broken, fine]);
  const first = await t.imports.commit(1, REQ);
  assert.deepEqual([first.summary.create, first.summary.invalid], [1, 1]);
  assert.match(first.items.find((i) => i.action === "invalid")!.reason!, /company is required/);

  t.setRows([{ ...broken, fields: { ...broken.fields, Company: "Anduril", "(title)": "Anduril" } }, fine]);
  const second = await t.imports.commit(1, REQ);
  assert.deepEqual([second.summary.create, second.summary.alreadyImported, second.summary.invalid], [1, 1, 0]);
  assert.deepEqual(t.service.list(1, {}).map((a) => a.company).sort(), ["Anduril", "Stripe"]);
});

test("an unknown status word makes the row invalid instead of guessing", async () => {
  const t = setup([swe("Stripe", "SWE", "Maybe later")]);
  const res = await t.imports.preview(1, REQ);
  assert.equal(res.items[0]!.action, "invalid");
  assert.match(res.items[0]!.reason!, /unknown status "Maybe later"/);
});

test("duplicates: the older row wins within the source, and an existing application blocks the import", async () => {
  const older = swe("Figma", "SWE", "Applied", "2026-09-15", {});
  const newer = { ...swe("figma ", "swe", "Applied", "2026-10-05"), createdOn: "2026-10-05" };
  const t = setup([newer, older]); // deliberately listed newest first
  const res = await t.imports.commit(1, REQ);
  assert.deepEqual([res.summary.create, res.summary.duplicate], [1, 1]);
  assert.equal(t.service.list(1, {})[0]!.appliedOn, "2026-09-15");
  assert.match(res.items.find((i) => i.action === "duplicate")!.reason!, /only the older one/);

  // already in Delta by hand -> the import leaves it alone
  const t2 = setup([swe("Stripe", "SWE Intern", "Applied", "2026-09-05")]);
  t2.service.add(1, { company: "Stripe", roleTitle: "SWE Intern" });
  const res2 = await t2.imports.commit(1, REQ);
  assert.deepEqual([res2.summary.create, res2.summary.duplicate], [0, 1]);
  assert.match(res2.items[0]!.reason!, /already have this in Delta/);
});

test("one bad row never aborts the others", async () => {
  const t = setup([swe("A Co", "SWE", "Applied", "2026-09-01"), swe("", "x", "Applied"), swe("B Co", "SWE", "Applied", "2026-09-02")]);
  const res = await t.imports.commit(1, REQ);
  assert.deepEqual([res.summary.create, res.summary.invalid], [2, 1]);
});

test("the caller's defaults apply: an explicit sector overrides guesses; the kind of role is required", async () => {
  const t = setup([swe("Stripe", "PM Intern", "Applied", "2026-09-05")]);
  await t.imports.commit(1, { database: "x", roleFunction: "PM", sector: "Consulting" });
  const a = t.service.list(1, {})[0]!;
  assert.deepEqual([a.roleFunction, a.sector], ["PM", "Consulting"]);
  await assert.rejects(t.imports.preview(1, { database: "x" }), ValidationError);
});

test("imported applications land in the right saved lists", async () => {
  const t = setup([
    swe("Jane Street", "SWE Intern", "Applied", "2026-09-05"),
    swe("Figma", "SWE", "Applied", "2026-09-06"),
  ]);
  await t.imports.commit(1, REQ);
  const named = (name: string) => t.lists.all(1).find((l) => l.name === name)!;
  assert.equal(named("SWE").count, 2);
  assert.equal(named("Fintech-adjacent").count, 1); // only the one with a (guessed) Finance sector
  assert.equal((await t.imports.preview(1, REQ)).summary.withoutSector, 0); // both rows have a sector
});

test("withoutSector counts the rows that won't reach sector-based lists", async () => {
  const t = setup([swe("Stripe", "SWE", "Applied", "2026-09-05"), swe("Obscure Co", "SWE", "Applied", "2026-09-05")]);
  assert.equal((await t.imports.preview(1, REQ)).summary.withoutSector, 1);
});

test("each user has their own ledger", async () => {
  const t = setup([swe("Stripe", "SWE Intern", "Applied", "2026-09-05")]);
  t.db.prepare("INSERT INTO users (id, name, created_at) VALUES (2, 'Other', 'now')").run();
  await t.imports.commit(1, REQ);
  const other = await t.imports.commit(2, REQ);
  assert.equal(other.summary.create, 1); // user 1's import doesn't make it "already imported" for user 2
  assert.equal(t.service.list(2, {}).length, 1);
});

test("a row that fails at write time (after planning said it was fine) is reported, the rest still import, and a re-run retries only it", async () => {
  const t = setup([swe("A Co", "SWE", "Applied", "2026-09-01"), swe("Boom", "SWE", "Applied", "2026-09-02"), swe("B Co", "SWE", "Applied", "2026-09-03")]);
  let explode = true;
  const flaky = {
    ...t.service,
    add: (userId: number, raw: unknown) => {
      if (explode && (raw as { company: string }).company === "Boom") throw new Error("disk hiccup");
      return t.service.add(userId, raw);
    },
  };
  const imports = createImportService({
    sources: { notion: () => ({ id: t.sourceId, fetchRows: async () => t.rowsNow() }) },
    applications: flaky, repo: createApplicationRepository(t.db), ledger: createImportLedger(t.db), clock: t.clock,
  });
  const first = await imports.commit(1, REQ);
  assert.deepEqual([first.summary.create, first.summary.invalid], [2, 1]);
  assert.match(first.items.find((i) => i.company === "Boom")!.reason!, /disk hiccup/);
  explode = false;
  const second = await imports.commit(1, REQ);
  assert.deepEqual([second.summary.create, second.summary.alreadyImported], [1, 2]); // only Boom is retried
});
