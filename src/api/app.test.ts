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
