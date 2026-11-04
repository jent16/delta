import test from "node:test";
import assert from "node:assert/strict";
import { ValidationError } from "./errors.ts";
import { describeRow, mapRow, parseImportRequest, TRACKER_COLUMNS } from "./import.ts";
import type { ImportDefaults, SourceRow } from "./import.ts";
import { parseNewApplication } from "./application.ts";
import { guessSector } from "./company-hints.ts";

const SWE: ImportDefaults = { roleFunction: "SWE", sector: null };
const row = (fields: Record<string, string>, extra: Partial<SourceRow> = {}): SourceRow => ({
  externalId: "p1", fields, createdOn: "2026-09-01", editedOn: "2026-09-20", ...extra,
});
const base = { Company: "Acme", "(title)": "Acme", "Role/Program": "SWE Intern" };

test("status words: Bookmarked -> saved, In process -> drafting, Applied -> applied, x -> rejected", () => {
  assert.equal(mapRow(row({ ...base, Status: "Bookmarked" }), TRACKER_COLUMNS, SWE).raw.status, "saved");
  assert.equal(mapRow(row({ ...base, Status: "In process" }), TRACKER_COLUMNS, SWE).raw.status, "drafting");
  assert.equal(mapRow(row({ ...base, Status: "Applied", Applied: "2026-09-05" }), TRACKER_COLUMNS, SWE).raw.status, "applied");
  const x = mapRow(row({ ...base, Status: "x", Applied: "2026-09-05" }), TRACKER_COLUMNS, SWE);
  assert.equal(x.raw.status, "applied"); // it started as an application...
  assert.deepEqual([x.followUp?.status, x.followUp?.on], ["rejected", "2026-09-20"]); // ...and ended as a rejection
});

test("matching is case- and space-insensitive, and an unknown status word is reported, not guessed", () => {
  assert.equal(mapRow(row({ ...base, Status: "  IN PROCESS " }), TRACKER_COLUMNS, SWE).raw.status, "drafting");
  assert.throws(() => mapRow(row({ ...base, Status: "Maybe?" }), TRACKER_COLUMNS, SWE), (e) => e instanceof ValidationError && /unknown status "Maybe\?"/.test(e.message));
});

test("no status cell: an Applied date means applied, otherwise saved", () => {
  assert.equal(mapRow(row({ ...base, Applied: "2026-09-05" }), TRACKER_COLUMNS, SWE).raw.status, "applied");
  assert.equal(mapRow(row({ ...base }), TRACKER_COLUMNS, SWE).raw.status, "saved");
});

test("history dates: saved starts the day the row was created; applied uses the Applied date", () => {
  assert.equal(mapRow(row({ ...base, Status: "Bookmarked" }, { createdOn: "2026-08-30" }), TRACKER_COLUMNS, SWE).raw.statusOn, "2026-08-30");
  const a = mapRow(row({ ...base, Status: "Applied", Applied: "2026-09-05" }), TRACKER_COLUMNS, SWE);
  assert.equal(a.raw.appliedOn, "2026-09-05");
  assert.deepEqual(a.warnings, []);
});

test("applied with no date falls back to the creation date, and says so", () => {
  const m = mapRow(row({ ...base, Status: "Applied" }, { createdOn: "2026-09-02" }), TRACKER_COLUMNS, SWE);
  assert.equal(m.raw.appliedOn, "2026-09-02");
  assert.match(m.warnings.join(), /no Applied date/);
});

test("a rejection can never be dated before the application", () => {
  const m = mapRow(row({ ...base, Status: "x", Applied: "2026-09-25" }, { editedOn: "2026-09-10" }), TRACKER_COLUMNS, SWE);
  assert.equal(m.followUp?.on, "2026-09-25");
});

test("nothing with no column of its own is lost: Opens and an unusable link go to the notes", () => {
  const m = mapRow(row({ ...base, Notes: "stretch role", Opens: "2026-09-09", Link: "see careers page" }), TRACKER_COLUMNS, SWE);
  assert.equal(m.raw.notes, "stretch role\nOpens: 2026-09-09\nLink: see careers page");
  assert.equal(m.raw.url, null);
  assert.match(m.warnings.join(), /not an http/);
  assert.equal(mapRow(row({ ...base, Link: "https://example.com/job" }), TRACKER_COLUMNS, SWE).raw.url, "https://example.com/job");
});

test("the term is lifted out of the role title, and the title is left as written", () => {
  const m = mapRow(row({ ...base, "Role/Program": "SWE Intern (summer 2027)" }), TRACKER_COLUMNS, SWE);
  assert.equal(m.raw.term, "Summer 2027");
  assert.equal(m.raw.roleTitle, "SWE Intern (summer 2027)");
  assert.equal(mapRow(row({ ...base }), TRACKER_COLUMNS, SWE).raw.term, undefined);
});

test("the title column stands in for Company when there is no column of that name", () => {
  const m = mapRow(row({ "(title)": "Stripe", Name: "Stripe", "Role/Program": "SWE" }), TRACKER_COLUMNS, SWE);
  assert.equal(m.raw.company, "Stripe");
});

test("sector: an explicit default wins; otherwise a well-known company is guessed and marked as a guess", () => {
  assert.equal(mapRow(row({ ...base, Company: "Jane Street", "(title)": "Jane Street" }), TRACKER_COLUMNS, SWE).raw.sector, "Finance");
  const guessed = mapRow(row({ ...base, Company: "Stripe ", "(title)": "Stripe " }), TRACKER_COLUMNS, SWE);
  assert.deepEqual([guessed.raw.sector, guessed.sectorGuessed], ["Fintech", true]);
  const forced = mapRow(row({ ...base, Company: "Stripe", "(title)": "Stripe" }), TRACKER_COLUMNS, { roleFunction: "SWE", sector: "Consulting" });
  assert.deepEqual([forced.raw.sector, forced.sectorGuessed], ["Consulting", false]);
  assert.equal("sector" in mapRow(row({ ...base, Company: "Obscure Co", "(title)": "Obscure Co" }), TRACKER_COLUMNS, SWE).raw, false);
});

test("guessSector ignores case, punctuation and company suffixes; unknown names are null", () => {
  assert.equal(guessSector("  JANE STREET, Inc. "), "Finance");
  assert.equal(guessSector("D. E. Shaw"), "Finance");
  assert.equal(guessSector("Mom & Pop Shop"), null);
});

test("what the mapper produces is accepted by the ordinary application parser", () => {
  const m = mapRow(row({ ...base, Status: "Bookmarked", Location: "NYC" }), TRACKER_COLUMNS, SWE);
  const parsed = parseNewApplication(m.raw, "2026-11-04");
  assert.equal(parsed.status, "saved");
  assert.equal(parsed.statusOn, "2026-09-01");
  assert.equal(parsed.fields.roleFunction, "SWE");
});

test("describeRow shows a row's company and role even when it can't be imported", () => {
  assert.deepEqual(describeRow(row({ "Role/Program": "FDE" }), TRACKER_COLUMNS), { company: "", roleTitle: "FDE" });
});

test("parseImportRequest: which kind of role is required; typos are rejected", () => {
  assert.deepEqual(parseImportRequest({ database: " abc ", roleFunction: "PM" }), { database: "abc", defaults: { roleFunction: "PM", sector: null } });
  const issues = (raw: unknown) => { try { parseImportRequest(raw); return []; } catch (e) { return (e as ValidationError).issues.map((i) => i.field).sort(); } };
  assert.deepEqual(issues({}), ["database", "roleFunction"]);
  assert.deepEqual(issues({ database: "x", roleFunction: "Plumber", sector: "Plumbing", extra: 1 }), ["extra", "roleFunction", "sector"]);
});
