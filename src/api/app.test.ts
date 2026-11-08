import test from "node:test";
import assert from "node:assert/strict";
import { startApi } from "../testing/harness.ts";

// The API layer's whole job is translating HTTP <-> services, so these tests
// only check that translation: status codes, response shapes, error mapping.
// The rules themselves are tested in the domain and service tests.

test("create -> read -> change status -> undo -> archive, end to end over HTTP", async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const created = await api.call("POST", "/api/applications", { company: "Stripe", roleTitle: "SWE Intern", roleFunction: "SWE", sector: "Fintech" });
  assert.equal(created.status, 201);
  const id = created.body.id;

  assert.equal((await api.call("GET", `/api/applications/${id}`)).body.application.company, "Stripe");
  const moved = await api.call("POST", `/api/applications/${id}/status`, { status: "applied", note: "submitted" });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.status, "applied");
  assert.equal((await api.call("POST", `/api/applications/${id}/status/undo`)).body.status, "saved");
  assert.equal((await api.call("PATCH", `/api/applications/${id}`, { notes: "hi" })).body.notes, "hi");

  assert.equal((await api.call("GET", "/api/applications?function=SWE")).body.applications.length, 1);
  assert.equal((await api.call("DELETE", `/api/applications/${id}`)).status, 204);
  assert.equal((await api.call("GET", "/api/applications")).body.applications.length, 0);
  assert.equal((await api.call("GET", "/api/applications?includeArchived=1")).body.applications.length, 1);
});

test("domain errors map to the right HTTP statuses and shapes", async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const bad = await api.call("POST", "/api/applications", { roleTitle: "x", sector: "Mining" });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, "validation");
  assert.deepEqual(bad.body.issues.map((i: { field: string }) => i.field).sort(), ["company", "sector"]);

  const a = (await api.call("POST", "/api/applications", { company: "A", roleTitle: "B" })).body;
  const dup = await api.call("POST", "/api/applications", { company: "a", roleTitle: "b" });
  assert.equal(dup.status, 409);
  assert.deepEqual([dup.body.error, dup.body.existingId], ["duplicate", a.id]);

  const illegal = await api.call("POST", `/api/applications/${a.id}/status`, { status: "offer" });
  assert.equal(illegal.status, 409);
  assert.equal(illegal.body.error, "invalid_transition");
  assert.ok(illegal.body.allowed.includes("applied"));

  assert.equal((await api.call("GET", "/api/applications/9999")).status, 404);
  assert.equal((await api.call("GET", "/api/applications/abc")).status, 400);
  assert.equal((await api.call("GET", "/api/applications?status=bogus")).status, 400);
});

test("malformed JSON is a 400 with a clear message, not a crash or a stack trace", async (t) => {
  const api = await startApi();
  t.after(() => api.close());
  const res = await fetch(`${api.base}/api/applications`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, "validation");
  assert.ok(!JSON.stringify(body).includes("at ")); // no stack trace leaked
});

test("health check", async (t) => {
  const api = await startApi();
  t.after(() => api.close());
  assert.deepEqual((await api.call("GET", "/api/health")).body, { ok: true });
});

test("lists over HTTP: starter lists, create, run with narrowing, rename, delete", async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const starter = await api.call("GET", "/api/lists");
  assert.deepEqual(starter.body.lists.map((l: { name: string }) => l.name), ["SWE", "PM", "Fintech-adjacent"]);

  await api.call("POST", "/api/applications", { company: "Jane Street", roleTitle: "SWE Intern", roleFunction: "SWE", sector: "Finance" });
  await api.call("POST", "/api/applications", { company: "Figma", roleTitle: "SWE Intern", roleFunction: "SWE", sector: "Consumer Tech" });
  const fintech = starter.body.lists[2];

  const run = await api.call("GET", `/api/lists/${fintech.id}/applications?q=jane`);
  assert.equal(run.status, 200);
  assert.deepEqual(run.body.applications.map((a: { company: string }) => a.company), ["Jane Street"]);
  assert.equal(run.body.list.count, 1);
  assert.equal((await api.call("GET", `/api/lists/${fintech.id}/applications?function=PM`)).body.applications.length, 0);
  assert.equal((await api.call("GET", `/api/lists/${fintech.id}/applications?status=bogus`)).status, 400);

  const created = await api.call("POST", "/api/lists", { name: "Offers", filter: { statuses: ["offer"] } });
  assert.equal(created.status, 201);
  assert.equal((await api.call("POST", "/api/lists", { name: "offers" })).status, 409); // duplicate name
  assert.equal((await api.call("POST", "/api/lists", { name: "Bad", filter: { sectors: ["Plumbing"] } })).status, 400);
  assert.equal((await api.call("PATCH", `/api/lists/${created.body.id}`, { name: "Won" })).body.name, "Won");
  assert.equal((await api.call("DELETE", `/api/lists/${created.body.id}`)).status, 204);
  assert.equal((await api.call("GET", `/api/lists/${created.body.id}`)).status, 404);
});

test("import over HTTP: preview writes nothing, commit does, errors map to sensible statuses", async (t) => {
  const { SourceError } = await import("../domain/errors.ts");
  let fail = false;
  const rows = [{ externalId: "r1", fields: { Company: "Stripe", "(title)": "Stripe", "Role/Program": "SWE", Status: "Applied", Applied: "2026-09-05" }, createdOn: "2026-09-01", editedOn: "2026-09-02" }];
  const api = await startApi(1, { notion: () => ({ id: "notion:x", fetchRows: async () => { if (fail) throw new SourceError("Notion refused the request (404)"); return rows; } }) });
  t.after(() => api.close());
  const req = { database: "x", roleFunction: "SWE" };

  const preview = await api.call("POST", "/api/import/notion/preview", req);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.summary.create, 1);
  assert.equal((await api.call("GET", "/api/applications")).body.applications.length, 0);

  const commit = await api.call("POST", "/api/import/notion/commit", req);
  assert.equal(commit.status, 200);
  assert.equal(commit.body.items[0].applicationId, 1);
  assert.equal((await api.call("GET", "/api/applications")).body.applications.length, 1);
  assert.equal((await api.call("POST", "/api/import/notion/commit", req)).body.summary.alreadyImported, 1);

  assert.equal((await api.call("POST", "/api/import/notion/preview", { database: "x" })).status, 400); // roleFunction missing
  fail = true;
  const refused = await api.call("POST", "/api/import/notion/preview", req);
  assert.equal(refused.status, 502);
  assert.equal(refused.body.error, "source_error");
});

test("export over HTTP: JSON and CSV, both as downloads", async (t) => {
  const api = await startApi();
  t.after(() => api.close());
  await api.call("POST", "/api/applications", { company: "Stripe", roleTitle: "SWE Intern", appliedOn: "2026-09-05" });
  const json = await fetch(`${api.base}/api/export`);
  assert.match(json.headers.get("content-disposition")!, /attachment; filename="delta-export-2026-09-15\.json"/);
  assert.equal((await json.json()).applications[0].company, "Stripe");
  const csv = await fetch(`${api.base}/api/export.csv`);
  assert.match(csv.headers.get("content-type")!, /text\/csv/);
  assert.match(csv.headers.get("content-disposition")!, /\.csv"/);
  assert.match(await csv.text(), /^id,company,role_title/);
});

test("3c over HTTP: company search, bulk edit, stats and reminders", async (t) => {
  const api = await startApi(1, undefined, { names: async () => ({ names: ["Rippling", "Stripe Inc"], available: true }) });
  t.after(() => api.close());
  const a = await api.call("POST", "/api/applications", { company: "Jane Street", roleTitle: "SWE", appliedOn: "2026-09-01" });
  const b = await api.call("POST", "/api/applications", { company: "Citadel", roleTitle: "SWE", appliedOn: "2026-09-02" });

  const search = await api.call("GET", "/api/companies/search?q=ripling");
  assert.equal(search.status, 200);
  assert.deepEqual(search.body.suggestions.map((s: { name: string }) => s.name), ["Rippling"]);
  assert.equal((await api.call("GET", "/api/companies/search")).status, 400);

  // "bulk" must not be mistaken for an application id
  const bulk = await api.call("POST", "/api/applications/bulk", { ids: [a.body.id, b.body.id], set: { sector: "Finance" } });
  assert.equal(bulk.status, 200);
  assert.equal(bulk.body.updated, 2);
  assert.equal((await api.call("POST", "/api/applications/bulk", { ids: [a.body.id, 999], set: { sector: "Finance" } })).status, 404);
  assert.equal((await api.call("POST", "/api/applications/bulk", { ids: [a.body.id], set: { company: "x" } })).status, 400);
  assert.equal((await api.call("GET", "/api/applications?missing=sector")).body.applications.length, 0);

  const stats = await api.call("GET", "/api/stats");
  assert.deepEqual([stats.body.stats.total, stats.body.stats.funnel.applied, stats.body.stats.bySector], [2, 2, { Finance: 2 }]);
  assert.equal((await api.call("GET", "/api/stats?list=999")).status, 404);

  await api.call("PATCH", `/api/applications/${a.body.id}`, { followUpOn: "2026-09-10" });
  const rem = await api.call("GET", "/api/reminders?days=3");
  assert.equal(rem.body.reminders.followUps.length, 1);
  assert.equal((await api.call("GET", "/api/reminders?days=-5")).status, 400);
});

test("bulk status change over HTTP", async (t) => {
  const api = await startApi();
  t.after(() => api.close());
  const a = await api.call("POST", "/api/applications", { company: "A", roleTitle: "SWE", appliedOn: "2026-09-01" });
  const b = await api.call("POST", "/api/applications", { company: "B", roleTitle: "SWE" }); // saved
  const blocked = await api.call("POST", "/api/applications/bulk/status", { ids: [a.body.id, b.body.id], status: "ghosted" });
  assert.equal(blocked.status, 400);
  assert.match(blocked.body.issues[0].message, new RegExp(`#${b.body.id} \\(saved\\)`));
  const ok = await api.call("POST", "/api/applications/bulk/status", { ids: [a.body.id], status: "ghosted", note: "silence" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.applications[0].status, "ghosted");
  assert.equal((await api.call("POST", "/api/applications/bulk/status", { ids: [999], status: "ghosted" })).status, 404);
});

test("GET /api/pipeline returns rows with progress, honours list scoping, and rejects a bad list", async (t) => {
  const api = await startApi();
  t.after(() => api.close());
  const a = (await api.call("POST", "/api/applications", { company: "Stripe", roleTitle: "SWE", roleFunction: "SWE" })).body;
  await api.call("POST", `/api/applications/${a.id}/status`, { status: "applied" });
  await api.call("POST", `/api/applications/${a.id}/status`, { status: "interview" });
  await api.call("POST", `/api/applications/${a.id}/status`, { status: "rejected" });
  await api.call("POST", "/api/applications", { company: "Shopify", roleTitle: "PM", roleFunction: "PM" });

  const all = await api.call("GET", "/api/pipeline");
  assert.equal(all.status, 200);
  assert.equal(all.body.rows.length, 2);
  const stripe = all.body.rows.find((r: { application: { company: string } }) => r.application.company === "Stripe");
  assert.deepEqual(stripe.progress, { level: 3, outcome: "rejected" });

  const pmList = (await api.call("GET", "/api/lists")).body.lists.find((l: { name: string }) => l.name === "PM");
  const pm = await api.call("GET", `/api/pipeline?list=${pmList.id}`);
  assert.deepEqual(pm.body.rows.map((r: { application: { company: string } }) => r.application.company), ["Shopify"]);

  assert.equal((await api.call("GET", "/api/pipeline?list=abc")).status, 400);
  assert.equal((await api.call("GET", "/api/pipeline?list=999")).status, 404);
});

test("GET /api/stats includes the weekly applied counts", async (t) => {
  const api = await startApi();
  t.after(() => api.close());
  await api.call("POST", "/api/applications", { company: "Stripe", roleTitle: "SWE", appliedOn: "2026-09-14" });
  const { body } = await api.call("GET", "/api/stats");
  assert.deepEqual(body.stats.appliedByWeek, [{ weekStart: "2026-09-14", count: 1 }]);
});

test("GET /api/vocab serves the status rules and closed lists, and GET /api/applications/:id includes progress", async (t) => {
  const api = await startApi();
  t.after(() => api.close());
  const v = (await api.call("GET", "/api/vocab")).body;
  assert.ok(v.statuses.includes("drafting") && v.sectors.includes("Fintech") && v.roleFunctions.includes("Quant"));
  assert.deepEqual(v.transitions.applied, ["assessment", "interview", "offer", "rejected", "withdrawn", "ghosted"]);
  assert.deepEqual(v.progressStages, ["Applied", "Assessment", "Interview", "Offer"]);
  const a = (await api.call("POST", "/api/applications", { company: "Stripe", roleTitle: "SWE" })).body;
  await api.call("POST", `/api/applications/${a.id}/status`, { status: "applied" });
  assert.deepEqual((await api.call("GET", `/api/applications/${a.id}`)).body.progress, { level: 1, outcome: null });
});

test("companies over HTTP: list, set a sector once for every application, rename, refuse a clash, merge", async (t) => {
  const api = await startApi();
  t.after(() => api.close());
  const a = (await api.call("POST", "/api/applications", { company: "Stirpe", roleTitle: "SWE" })).body;
  await api.call("POST", "/api/applications", { company: "Stirpe", roleTitle: "PM" });
  const figma = (await api.call("POST", "/api/applications", { company: "Figma", roleTitle: "Data" })).body;
  assert.equal(typeof a.companyId, "number");

  const list = (await api.call("GET", "/api/companies")).body.companies;
  assert.deepEqual(list.map((c: { name: string; sector: null; applications: number }) => [c.name, c.sector, c.applications]), [["Figma", null, 1], ["Stirpe", null, 2]]);

  // one PATCH classifies every application at the company
  const sector = await api.call("PATCH", `/api/companies/${a.companyId}`, { sector: "Fintech" });
  assert.equal(sector.status, 200);
  assert.deepEqual((await api.call("GET", "/api/applications?sector=Fintech")).body.applications.map((x: { roleTitle: string }) => x.roleTitle).sort(), ["PM", "SWE"]);

  assert.equal((await api.call("PATCH", `/api/companies/${a.companyId}`, { name: "Stripe" })).body.name, "Stripe");
  assert.equal((await api.call("GET", `/api/applications/${a.id}`)).body.application.company, "Stripe");

  // a clash is a 409 that names the existing company, so the UI can offer to merge
  const clash = await api.call("PATCH", `/api/companies/${figma.companyId}`, { name: "stripe" });
  assert.equal(clash.status, 409);
  assert.deepEqual([clash.body.error, clash.body.existingId, clash.body.existingName], ["company_exists", a.companyId, "Stripe"]);

  assert.equal((await api.call("PATCH", `/api/companies/${a.companyId}`, { sector: "Mining" })).status, 400);
  assert.equal((await api.call("PATCH", "/api/companies/999", { sector: "Fintech" })).status, 404);
  assert.equal((await api.call("PATCH", "/api/companies/abc", { sector: "Fintech" })).status, 400);

  const merged = await api.call("POST", `/api/companies/${figma.companyId}/merge`, { into: a.companyId });
  assert.equal(merged.status, 200);
  assert.deepEqual([merged.body.company.name, merged.body.company.applications, merged.body.moved], ["Stripe", 3, 1]);
  assert.equal((await api.call("GET", "/api/companies")).body.companies.length, 1);
  assert.equal((await api.call("POST", `/api/companies/${a.companyId}/merge`, { into: a.companyId })).status, 400);
  // merging that would make two identical applications is refused, with the reason
  const x = (await api.call("POST", "/api/applications", { company: "Stripe Inc", roleTitle: "SWE" })).body; // Stripe already has a SWE role
  const refused = await api.call("POST", `/api/companies/${x.companyId}/merge`, { into: a.companyId });
  assert.equal(refused.status, 400);
  assert.match(refused.body.issues[0].message, /already has: SWE/);
});

test("a path named 'search' is never read as a company id", async (t) => {
  const api = await startApi();
  t.after(() => api.close());
  assert.equal((await api.call("GET", "/api/companies/search?q=zzz")).status, 200);
  assert.equal((await api.call("GET", "/api/companies/search")).status, 400); // missing q is the search's own validation error
});
