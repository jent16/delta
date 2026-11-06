import test from "node:test";
import assert from "node:assert/strict";
import { dedupeKey, parseApplicationPatch, parseApplicationQuery, parseNewApplication, parseStatusChange, parseBulkEdit } from "./application.ts";
import { isIsoDate } from "./dates.ts";
import { ValidationError } from "./errors.ts";

const TODAY = "2026-09-15";
const fieldsOf = (e: unknown) => (e as ValidationError).issues.map((i) => i.field).sort();
const rejects = (fn: () => unknown) => assert.throws(fn, ValidationError);

test("dates: real calendar dates only", () => {
  assert.equal(isIsoDate("2026-09-15"), true);
  assert.equal(isIsoDate("2026-02-31"), false); // would silently roll into March with new Date()
  assert.equal(isIsoDate("2026-9-5"), false);
  assert.equal(isIsoDate("tomorrow"), false);
});

test("new application: minimal input, defaults", () => {
  const a = parseNewApplication({ company: "  Stripe ", roleTitle: "SWE Intern" }, TODAY);
  assert.equal(a.fields.company, "Stripe"); // trimmed
  assert.equal(a.fields.roleFunction, "Other");
  assert.equal(a.fields.sector, null);
  assert.equal(a.fields.notes, "");
  assert.equal(a.status, "saved");
  assert.equal(a.statusOn, TODAY);
});

test("new application: status defaults from whether you applied", () => {
  const applied = parseNewApplication({ company: "A", roleTitle: "B", appliedOn: "2026-09-01" }, TODAY);
  assert.equal(applied.status, "applied");
  assert.equal(applied.statusOn, "2026-09-01"); // the history is dated by when it actually happened
  const explicit = parseNewApplication({ company: "A", roleTitle: "B", status: "interview" }, TODAY);
  assert.equal(explicit.status, "interview");
});

test("new application: collects ALL problems at once, not just the first", () => {
  try {
    parseNewApplication({ roleTitle: "", url: "javascript:alert(1)", sector: "Mining", appliedOn: "2026-02-31", status: "great" }, TODAY);
    assert.fail("should have thrown");
  } catch (e) {
    assert.deepEqual(fieldsOf(e), ["appliedOn", "company", "roleTitle", "sector", "status", "url"]);
  }
});

test("new application: unknown fields are errors (a typo must not silently drop data)", () => {
  try {
    parseNewApplication({ company: "A", roleTitle: "B", compny: "typo" }, TODAY);
    assert.fail("should have thrown");
  } catch (e) {
    assert.deepEqual(fieldsOf(e), ["compny"]);
  }
});

test("new application: only http(s) links, bodies must be objects, lengths are capped", () => {
  rejects(() => parseNewApplication({ company: "A", roleTitle: "B", url: "ftp://x.com" }, TODAY));
  rejects(() => parseNewApplication(null, TODAY));
  rejects(() => parseNewApplication([], TODAY));
  rejects(() => parseNewApplication({ company: "x".repeat(201), roleTitle: "B" }, TODAY));
  rejects(() => parseNewApplication({ company: 42, roleTitle: "B" }, TODAY));
  assert.equal(parseNewApplication({ company: "A", roleTitle: "B", url: "https://x.com/jobs/1" }, TODAY).fields.url, "https://x.com/jobs/1");
});

test("new application: blank optional fields become null, not empty strings", () => {
  const a = parseNewApplication({ company: "A", roleTitle: "B", location: "  ", sector: "" }, TODAY);
  assert.equal(a.fields.location, null);
  assert.equal(a.fields.sector, null);
});

test("patch: only provided fields, can clear optional ones, can't clear required ones", () => {
  assert.deepEqual(parseApplicationPatch({ notes: "followed up" }), { notes: "followed up" });
  assert.deepEqual(parseApplicationPatch({ location: null }), { location: null });
  rejects(() => parseApplicationPatch({ company: "" }));
  rejects(() => parseApplicationPatch({}));
  rejects(() => parseApplicationPatch({ status: "offer" })); // status has its own operation
});

test("status change: validated, dated, defaults to today", () => {
  assert.deepEqual(parseStatusChange({ status: "interview" }, TODAY), { status: "interview", on: TODAY, note: null });
  assert.deepEqual(parseStatusChange({ status: "applied", on: "2026-09-01", note: " via referral " }, TODAY), { status: "applied", on: "2026-09-01", note: "via referral" });
  rejects(() => parseStatusChange({ status: "nope" }, TODAY));
  rejects(() => parseStatusChange({ status: "applied", on: "soon" }, TODAY));
});

test("query: comma lists, unknown values rejected, archived opt-in", () => {
  assert.deepEqual(parseApplicationQuery({ status: "applied,interview", function: "SWE", q: " stripe " }), {
    statuses: ["applied", "interview"],
    roleFunctions: ["SWE"],
    q: "stripe",
  });
  assert.equal(parseApplicationQuery({ includeArchived: "1" }).includeArchived, true);
  assert.deepEqual(parseApplicationQuery({}), {});
  rejects(() => parseApplicationQuery({ status: "applied,bogus" }));
});

test("dedupeKey: same company+role+term collide regardless of case/spacing; a different role does not", () => {
  const k = (company: string, roleTitle: string, term: string | null) => dedupeKey({ company, roleTitle, term });
  assert.equal(k("Stripe", "SWE Intern", "Summer 2027"), k("  STRIPE ", "swe   intern", "summer 2027"));
  assert.notEqual(k("Stripe", "SWE Intern", "Summer 2027"), k("Stripe", "PM Intern", "Summer 2027"));
  assert.notEqual(k("Stripe", "SWE Intern", "Summer 2027"), k("Stripe", "SWE Intern", "Fall 2027"));
});

// ---- bulk edit and "missing" filter ----

const bulkIssues = (raw: unknown): string[] => {
  try { parseBulkEdit(raw); return []; } catch (e) { return (e as ValidationError).issues.map((i) => i.field).sort(); }
};

test("parseBulkEdit: ids are deduplicated and the change is validated like any edit", () => {
  const b = parseBulkEdit({ ids: [3, 1, 3], set: { sector: "Finance", roleFunction: "SWE" } });
  assert.deepEqual(b.ids, [3, 1]);
  assert.deepEqual(b.set, { sector: "Finance", roleFunction: "SWE" });
  assert.deepEqual(parseBulkEdit({ ids: [1], set: { sector: "" } }).set, { sector: null }); // blank clears the field
});

test("parseBulkEdit refuses identity fields (bulk-editing them could silently create duplicates) and notes (too easy to overwrite)", () => {
  for (const field of ["company", "roleTitle", "term", "notes", "url", "status"]) {
    assert.deepEqual(bulkIssues({ ids: [1], set: { [field]: "x" } }), ["set"], field);
  }
});

test("parseBulkEdit rejects bad input, all problems at once", () => {
  assert.deepEqual(bulkIssues({ ids: [], set: { sector: "Finance" } }), ["ids"]);
  assert.deepEqual(bulkIssues({ ids: [1.5], set: { sector: "Finance" } }), ["ids"]);
  assert.deepEqual(bulkIssues({ ids: Array.from({ length: 501 }, (_, i) => i + 1), set: { sector: "Finance" } }), ["ids"]);
  assert.deepEqual(bulkIssues({ ids: [1], set: {} }), ["set"]);
  assert.deepEqual(bulkIssues({ ids: [1], set: { sector: "Plumbing" } }), ["set.sector"]);
  assert.deepEqual(bulkIssues({ ids: "1", set: { sector: "Finance" }, extra: 1 }), ["extra", "ids"]);
  assert.deepEqual(bulkIssues("nope"), ["(body)"]);
});

test("parseApplicationQuery: missing= takes a closed list of fields", () => {
  assert.deepEqual(parseApplicationQuery({ missing: "sector,term" }).missing, ["sector", "term"]);
  assert.throws(() => parseApplicationQuery({ missing: "company" }), ValidationError);
});

// ---- bulk status change ----
import { parseBulkStatusChange } from "./application.ts";

test("parseBulkStatusChange: ids deduplicated, date defaults to today, problems reported together", () => {
  const ok = parseBulkStatusChange({ ids: [2, 1, 2], status: "ghosted", note: "no reply" }, TODAY);
  assert.deepEqual(ok, { ids: [2, 1], change: { status: "ghosted", on: TODAY, note: "no reply" } });
  assert.equal(parseBulkStatusChange({ ids: [1], status: "ghosted", on: "2026-09-01" }, TODAY).change.on, "2026-09-01");
  assert.deepEqual(fieldsOf(catchValidation(() => parseBulkStatusChange({ ids: [], status: "nope" }, TODAY))), ["ids", "status"]);
  assert.deepEqual(fieldsOf(catchValidation(() => parseBulkStatusChange({ ids: [1], status: "ghosted", on: "2026-02-31", typo: 1 }, TODAY))), ["on", "typo"]);
  assert.deepEqual(fieldsOf(catchValidation(() => parseBulkStatusChange("nope", TODAY))), ["(body)"]);
});
function catchValidation(fn: () => unknown): ValidationError {
  try { fn(); } catch (e) { return e as ValidationError; }
  throw new Error("expected a ValidationError");
}
