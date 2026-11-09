import test from "node:test";
import assert from "node:assert/strict";
import { startApi, startAuthApi } from "../testing/harness.ts";

const ME = { name: "Justin", email: "justin@example.com", password: "a long enough one" };

test("signed out: every data route is 401; only health, vocab and the sign-in routes are open", async (t) => {
  const api = await startAuthApi();
  t.after(() => api.close());
  const b = api.browser();
  assert.equal((await b.call("GET", "/api/health")).status, 200);
  assert.equal((await b.call("GET", "/api/vocab")).status, 200);
  for (const [method, path] of [["GET", "/api/applications"], ["GET", "/api/contacts"], ["GET", "/api/companies"], ["GET", "/api/lists"], ["GET", "/api/stats"], ["GET", "/api/export"], ["GET", "/api/export.csv"],
    ["GET", "/api/settings"], ["GET", "/api/profile"], ["POST", "/api/applications"], ["POST", "/api/import/linkedin/preview"], ["POST", "/api/auth/change-password"], ["POST", "/api/auth/delete-account"],
    ["GET", "/api/reminders"], ["GET", "/api/pipeline"], ["GET", "/api/breakdowns"], ["POST", "/api/resume-versions"]] as const) {
    const r = await b.call(method, path, method === "POST" ? {} : undefined);
    assert.equal(r.status, 401, `${method} ${path}`);
    assert.equal(r.body.error, "unauthenticated");
  }
  const state = (await b.call("GET", "/api/auth/state")).body;
  assert.deepEqual(state, { account: null, canSignUp: true, claimsExistingData: true });
});

test("sign up sets an HttpOnly cookie, signs you in, claims the existing data, and /state shows who you are", async (t) => {
  const api = await startAuthApi();
  t.after(() => api.close());
  api.service.add(1, { company: "Stripe", roleTitle: "SWE" });
  const b = api.browser();
  const up = await b.call("POST", "/api/auth/signup", ME);
  assert.equal(up.status, 201);
  assert.deepEqual([up.body.account.email, up.body.claimed, "password" in up.body.account, "passwordHash" in up.body.account], ["justin@example.com", true, false, false]);
  assert.match(up.setCookie!, /^delta_session=[A-Za-z0-9_-]{40,}/);
  assert.match(up.setCookie!, /HttpOnly/i);
  assert.match(up.setCookie!, /SameSite=Lax/i);
  assert.match(up.setCookie!, /Path=\//);
  assert.doesNotMatch(up.setCookie!, /Secure/i);
  assert.equal((await b.call("GET", "/api/applications")).body.applications.length, 1);
  assert.equal((await b.call("GET", "/api/auth/state")).body.account.name, "Justin");
});

test("the cookie is marked Secure when the server is told it is served over https", async (t) => {
  const api = await startAuthApi({}, true);
  t.after(() => api.close());
  const up = await api.browser().call("POST", "/api/auth/signup", ME);
  assert.match(up.setCookie!, /Secure/i);
});

test("API responses are never cached", async (t) => {
  const api = await startAuthApi();
  t.after(() => api.close());
  const b = api.browser();
  await b.call("POST", "/api/auth/signup", ME);
  for (const path of ["/api/applications", "/api/auth/state", "/api/health"]) assert.equal((await b.call("GET", path)).headers.get("cache-control"), "no-store", path);
});

test("sign out ends the session on the server, not just in the browser", async (t) => {
  const api = await startAuthApi();
  t.after(() => api.close());
  const b = api.browser();
  await b.call("POST", "/api/auth/signup", ME);
  const stolen = b.cookie; // a copy of the cookie, as an attacker or another tab might hold
  const out = await b.call("POST", "/api/auth/signout");
  assert.equal(out.status, 204);
  assert.equal(b.cookie, "");
  const replay = api.browser();
  replay.cookie = stolen;
  assert.equal((await replay.call("GET", "/api/applications")).status, 401);
});

test("sign in: right credentials work; wrong ones are a 401 with the same words whether or not the email exists", async (t) => {
  const api = await startAuthApi();
  t.after(() => api.close());
  await api.browser().call("POST", "/api/auth/signup", ME);
  const b = api.browser();
  const wrong = await b.call("POST", "/api/auth/signin", { email: ME.email, password: "nope nope nope" });
  const unknown = await b.call("POST", "/api/auth/signin", { email: "who@example.com", password: "nope nope nope" });
  assert.deepEqual([wrong.status, unknown.status, wrong.body.message === unknown.body.message], [401, 401, true]);
  assert.equal(wrong.setCookie, null);
  assert.equal((await b.call("POST", "/api/auth/signin", { email: ME.email })).status, 400);
  const ok = await b.call("POST", "/api/auth/signin", { email: ME.email, password: ME.password });
  assert.equal(ok.status, 200);
  assert.equal((await b.call("GET", "/api/applications")).status, 200);
});

test("signing in again from a browser that still holds an old session retires that session", async (t) => {
  const api = await startAuthApi();
  t.after(() => api.close());
  const b = api.browser();
  await b.call("POST", "/api/auth/signup", ME);
  const first = b.cookie;
  await b.call("POST", "/api/auth/signin", { email: ME.email, password: ME.password });
  assert.notEqual(b.cookie, first);
  assert.equal((api.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n, 1);
  const old = api.browser();
  old.cookie = first;
  assert.equal((await old.call("GET", "/api/applications")).status, 401);
});

test("too many wrong passwords: 429 with Retry-After", async (t) => {
  const api = await startAuthApi();
  t.after(() => api.close());
  await api.browser().call("POST", "/api/auth/signup", ME);
  const b = api.browser();
  for (let i = 0; i < 5; i++) await b.call("POST", "/api/auth/signin", { email: ME.email, password: "nope nope nope" });
  const locked = await b.call("POST", "/api/auth/signin", { email: ME.email, password: ME.password });
  assert.equal(locked.status, 429);
  assert.equal(Number(locked.headers.get("retry-after")) > 0, true);
});

test("a bad or expired cookie is 401 and gets cleared", async (t) => {
  const api = await startAuthApi();
  t.after(() => api.close());
  const b = api.browser();
  b.cookie = "delta_session=garbage";
  const r = await b.call("GET", "/api/applications");
  assert.equal(r.status, 401);
  assert.match(r.setCookie ?? "", /^delta_session=;/);
  b.cookie = "other=1; delta_session=garbage; third=3";   // found among other cookies, still not valid
  assert.equal((await b.call("GET", "/api/applications")).status, 401);
});

test("two people only ever see their own data", async (t) => {
  const api = await startAuthApi();
  t.after(() => api.close());
  const a = api.browser(), c = api.browser();
  await a.call("POST", "/api/auth/signup", ME);
  await c.call("POST", "/api/auth/signup", { name: "Chris", email: "chris@example.com", password: "another long one" });
  const mine = (await a.call("POST", "/api/applications", { company: "Stripe", roleTitle: "SWE" })).body;
  await a.call("POST", "/api/contacts", { name: "Priya" });
  assert.equal((await c.call("GET", "/api/applications")).body.applications.length, 0);
  assert.equal((await c.call("GET", `/api/applications/${mine.id}`)).status, 404);
  assert.equal((await c.call("GET", "/api/contacts")).body.contacts.length, 0);
  assert.equal((await c.call("GET", "/api/companies")).body.companies.length, 0);
  assert.equal((await c.call("PATCH", `/api/applications/${mine.id}`, { notes: "hacked" })).status, 404);
  assert.equal((await a.call("GET", `/api/applications/${mine.id}`)).body.application.notes, "");
  assert.equal((await c.call("GET", "/api/export")).body.applications.length, 0);
});

test("a request that came from another website is refused, even with a valid cookie", async (t) => {
  const api = await startAuthApi();
  t.after(() => api.close());
  const b = api.browser();
  await b.call("POST", "/api/auth/signup", ME);
  const base = new URL(api.base);
  assert.equal((await b.call("POST", "/api/applications", { company: "X", roleTitle: "Y" }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await b.call("POST", "/api/applications", { company: "X", roleTitle: "Y" }, { origin: "null" })).status, 403);
  assert.equal((await b.call("POST", "/api/applications", { company: "X", roleTitle: "Y" }, { origin: "not a url" })).status, 403);
  assert.equal((await b.call("POST", "/api/applications", { company: "X", roleTitle: "Y" }, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await b.call("POST", "/api/auth/signin", ME, { origin: "https://evil.example" })).status, 403);
  assert.equal((await b.call("GET", "/api/applications")).body.applications.length, 0); // none of them got through
  // our own page (same origin) and tools with no Origin header are fine
  assert.equal((await b.call("POST", "/api/applications", { company: "X", roleTitle: "Y" }, { origin: base.origin })).status, 201);
  assert.equal((await b.call("POST", "/api/applications", { company: "X2", roleTitle: "Y" }, { "sec-fetch-site": "same-origin" })).status, 201);
});

test("changing the password signs out other browsers; deleting the account needs the password and ends everything", async (t) => {
  const api = await startAuthApi();
  t.after(() => api.close());
  const a = api.browser(), other = api.browser();
  await a.call("POST", "/api/auth/signup", ME);
  await other.call("POST", "/api/auth/signin", { email: ME.email, password: ME.password });
  assert.equal((await a.call("POST", "/api/auth/change-password", { current: "wrong wrong wrong", next: "a brand new password" })).status, 400);
  assert.equal((await a.call("POST", "/api/auth/change-password", { current: ME.password, next: "a brand new password" })).status, 204);
  assert.equal((await a.call("GET", "/api/applications")).status, 200);
  assert.equal((await other.call("GET", "/api/applications")).status, 401);

  await a.call("POST", "/api/applications", { company: "Stripe", roleTitle: "SWE" });
  assert.equal((await a.call("POST", "/api/auth/delete-account", { password: "wrong wrong wrong" })).status, 400);
  assert.equal((await a.call("GET", "/api/applications")).body.applications.length, 1);
  assert.equal((await a.call("POST", "/api/auth/delete-account", { password: "a brand new password" })).status, 204);
  assert.equal(a.cookie, "");
  assert.equal((await a.call("GET", "/api/applications")).status, 401);
  assert.equal((await api.browser().call("POST", "/api/auth/signin", { email: ME.email, password: "a brand new password" })).status, 401);
  assert.equal((api.db.prepare("SELECT COUNT(*) AS n FROM applications").get() as { n: number }).n, 0);
});

test("closed sign-ups: refused with 403 once the existing data is claimed", async (t) => {
  const api = await startAuthApi({ allowSignup: false });
  t.after(() => api.close());
  assert.equal((await api.browser().call("POST", "/api/auth/signup", ME)).status, 201);
  const late = await api.browser().call("POST", "/api/auth/signup", { ...ME, email: "late@example.com" });
  assert.equal(late.status, 403);
  assert.equal(late.body.error, "signups_closed");
  assert.deepEqual((await api.browser().call("GET", "/api/auth/state")).body, { account: null, canSignUp: false, claimsExistingData: false });
});

test("sign-up validation comes back as field issues", async (t) => {
  const api = await startAuthApi();
  t.after(() => api.close());
  const r = await api.browser().call("POST", "/api/auth/signup", { name: "", email: "x", password: "" });
  assert.equal(r.status, 400);
  assert.deepEqual(r.body.issues.map((i: { field: string }) => i.field), ["email", "name", "password"]);
  assert.equal(r.setCookie, null);
  // a short, simple password is NOT a validation problem: the page warns, the server accepts
  const ok = await api.browser().call("POST", "/api/auth/signup", { name: "A", email: "a@example.com", password: "abc" });
  assert.equal(ok.status, 201);
});

test("profile and resume versions over HTTP", async (t) => {
  const api = await startAuthApi();
  t.after(() => api.close());
  const b = api.browser();
  await b.call("POST", "/api/auth/signup", ME);
  await b.call("POST", "/api/applications", { company: "Stripe", roleTitle: "SWE", resumeVersion: "SWE-v3" });
  let p = (await b.call("GET", "/api/profile")).body;
  assert.deepEqual([p.profile.name, p.profile.email, p.resumeVersions, p.unlisted], ["Justin", ME.email, [], [{ name: "SWE-v3", uses: 1 }]]);

  const saved = await b.call("PATCH", "/api/profile", { name: "Justin Tan", school: "SFU", program: "CS", gradYear: 2028, targetRoles: ["SWE"], targetTerms: ["Summer 2027"] });
  assert.deepEqual([saved.status, saved.body.profile.name, saved.body.profile.gradYear], [200, "Justin Tan", 2028]);
  assert.equal((await b.call("PATCH", "/api/profile", { gradYear: 1 })).status, 400);
  assert.equal((await b.call("PATCH", "/api/profile", { email: "x@y.co" })).status, 400);
  assert.equal((await b.call("GET", "/api/settings")).body.school, "SFU"); // the older settings route sees the same data

  const v = await b.call("POST", "/api/resume-versions", { name: "SWE-v3" });
  assert.equal(v.status, 201);
  assert.equal((await b.call("POST", "/api/resume-versions", { name: "swe-v3" })).status, 400);
  assert.equal((await b.call("PATCH", `/api/resume-versions/${v.body.id}`, { name: "SWE-final" })).body.uses, 1);
  assert.equal((await b.call("GET", "/api/applications")).body.applications[0].resumeVersion, "SWE-final");
  assert.equal((await b.call("PATCH", "/api/resume-versions/999", { note: "x" })).status, 404);
  assert.equal((await b.call("PATCH", "/api/resume-versions/abc", { note: "x" })).status, 400);
  assert.equal((await b.call("DELETE", `/api/resume-versions/${v.body.id}`)).status, 204);
  assert.equal((await b.call("DELETE", `/api/resume-versions/${v.body.id}`)).status, 404);
  p = (await b.call("GET", "/api/profile")).body;
  assert.deepEqual([p.resumeVersions.length, p.unlisted.map((u: { name: string }) => u.name)], [0, ["SWE-final"]]);
});

test("the fixed-user test mode still works, and createApp refuses to start with neither kind of identity", async (t) => {
  const api = await startApi();
  t.after(() => api.close());
  assert.equal((await api.call("GET", "/api/profile")).status, 200);
  const { createApp } = await import("./app.ts");
  assert.throws(() => createApp({ ...({} as Parameters<typeof createApp>[0]) }), /auth|currentUserId/);
});
