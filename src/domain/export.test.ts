import test from "node:test";
import assert from "node:assert/strict";
import type { Application, StatusEvent } from "./application.ts";
import { buildCsvExport, buildJsonExport, csvCell } from "./export.ts";

const app = (over: Partial<Application> = {}): Application => ({
  id: 1, userId: 1, companyId: 7, company: "Stripe", roleTitle: "SWE Intern", roleFunction: "SWE", sector: "Fintech", location: null, term: null, url: null,
  source: null, appliedOn: "2026-09-05", deadlineOn: null, followUpOn: null, resumeVersion: null, compensation: null, notes: "", status: "applied",
  archivedAt: null, createdAt: "t", updatedAt: "t", ...over,
});
const ev = (status: StatusEvent["status"], on: string): StatusEvent => ({ id: 1, applicationId: 1, status, occurredOn: on, note: null, createdAt: "t" });

test("csvCell: quotes only when needed, doubles quotes, keeps newlines inside quotes", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("line1\nline2"), '"line1\nline2"');
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(0), "0");
});

test("csvCell defuses spreadsheet formulas", () => {
  for (const evil of ['=HYPERLINK("http://evil","click")', "+1+1", "-2+3", "@SUM(A1)", "\tcmd"]) {
    assert.ok(csvCell(evil).replace(/^"/, "").startsWith("'"), evil);
  }
  assert.equal(csvCell("Summer 2027"), "Summer 2027");
  assert.equal(csvCell("a-b"), "a-b"); // only a LEADING sign is dangerous
});

test("the CSV has one row per application, a header, the history in one cell, and archived rows marked", () => {
  const csv = buildCsvExport([
    { application: app(), history: [ev("applied", "2026-09-05"), ev("rejected", "2026-09-21")] },
    { application: app({ id: 2, company: "Figma, Inc.", notes: "=1+1", archivedAt: "2026-10-01T00:00:00Z" }), history: [ev("saved", "2026-09-01")] },
  ]);
  const lines = csv.trim().split("\r\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /^id,company,role_title,/);
  assert.match(lines[1]!, /,applied 2026-09-05; rejected 2026-09-21$/);
  assert.match(lines[2]!, /"Figma, Inc\."/);
  assert.match(lines[2]!, /,'=1\+1,yes,saved 2026-09-01$/);
});

test("the JSON export carries every field, the history, and the lists", () => {
  const j = buildJsonExport("2026-11-05T00:00:00Z", [{ application: app({ archivedAt: "x" }), history: [ev("applied", "2026-09-05")] }], [
    { id: 1, userId: 1, name: "SWE", filter: { roleFunctions: ["SWE"] }, createdAt: "t", updatedAt: "t" },
  ], [{ id: 7, userId: 1, name: "Stripe", sector: "Fintech", createdAt: "t", updatedAt: "t", applications: 1, totalApplications: 1 }]);
  assert.equal(j.version, 3);
  assert.deepEqual(j.companies, [{ id: 7, name: "Stripe", sector: "Fintech" }]); // the sector is stored once, here
  assert.equal(j.applications[0]!.companyId, 7);
  assert.deepEqual(j.applications[0]!.history, [{ status: "applied", on: "2026-09-05", note: null }]);
  assert.equal(j.applications[0]!.archived, true);
  assert.deepEqual(j.lists, [{ name: "SWE", filter: { roleFunctions: ["SWE"] } }]);
});
