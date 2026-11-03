// Integration: the real server.js against a fixture DB and the mock Claude/
// Notion server (scripts/mock-api.js). Asserts on what was *called*, not just
// what came back — scoping exists to avoid spending on Claude calls, so the
// call log is the thing worth checking.
const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("net");
const path = require("path");
const Database = require("better-sqlite3");
const { spawn } = require("child_process");
const { makeFixtureDb, tinyPdf, ROOT } = require("./helpers");

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

let server, mock, base, mockBase, dbPath;
const procs = [];

async function waitFor(url) {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url)).status < 500) return; } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${url}`);
}

test.before(async () => {
  const fx = makeFixtureDb();
  dbPath = fx.dbPath;
  const [port, mockPort] = [await freePort(), await freePort()];
  base = `http://localhost:${port}`;
  mockBase = `http://localhost:${mockPort}`;
  const env = { ...process.env, PORT: String(port), MOCK_PORT: String(mockPort) };
  mock = spawn("node", [path.join(ROOT, "scripts/mock-api.js")], { env, stdio: "ignore" });
  server = spawn("node", [path.join(ROOT, "server.js"), "--mock"], { cwd: fx.dir, env, stdio: "ignore" });
  procs.push(mock, server);
  await waitFor(`${base}/roles`);
  await waitFor(`${mockBase}/__calls`);
});
test.after(() => procs.forEach((p) => p.kill()));

const api = async (method, url, body) => {
  const res = await fetch(base + url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};
const upload = async (fields = {}) => {
  const fd = new FormData();
  fd.append("resume", new Blob([tinyPdf("Python and SQL experience")], { type: "application/pdf" }), "resume.pdf");
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const res = await fetch(`${base}/resume`, { method: "POST", body: fd });
  return { status: res.status, body: await res.json() };
};
const claudeCalls = async () => {
  const calls = (await (await fetch(`${mockBase}/__calls`)).json()).filter((c) => c.url.startsWith("/v1/messages"));
  return {
    skills: calls.filter((c) => c.tool === "record_resume_skills").length,
    qualifications: calls.filter((c) => c.tool === "record_qualifications").length,
    explain: calls.filter((c) => c.tool === null).length,
    total: calls.length,
  };
};
const diff = (after, before) => Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - before[k]]));

let sweProfile, pmProfile;

test("profiles: created with targets; a bad Notion database value is rejected, a URL is parsed", async () => {
  const roles = (await api("GET", "/roles")).body.roles;
  const id = (t) => roles.find((r) => r.title === t).role_id;
  sweProfile = (await api("POST", "/profiles", { name: "SWE", roleIds: [id("Backend Engineer Intern")] })).body.profile.profile_id;
  pmProfile = (await api("POST", "/profiles", { name: "PM", roleIds: [id("Product Manager Intern")] })).body.profile.profile_id;

  assert.equal((await api("PUT", `/profiles/${sweProfile}`, { notionDatabaseId: "not a db" })).status, 400);
  const ok = await api("PUT", `/profiles/${sweProfile}`, { notionDatabaseId: "https://notion.so/w/T-0123456789abcdef0123456789abcdef?v=1" });
  assert.equal(ok.body.profile.notion_database_id, "0123456789abcdef0123456789abcdef");
});

test("upload validation: no file and non-PDF are 400s, and cost nothing", async () => {
  const before = await claudeCalls();
  assert.equal((await fetch(`${base}/resume`, { method: "POST", body: new FormData() })).status, 400);
  const fd = new FormData();
  fd.append("resume", new Blob(["hi"], { type: "text/plain" }), "x.txt");
  assert.equal((await fetch(`${base}/resume`, { method: "POST", body: fd })).status, 400);
  assert.deepEqual(diff(await claudeCalls(), before), { skills: 0, qualifications: 0, explain: 0, total: 0 });
});

test("scoped profile: PM is never assessed — the Claude call doesn't happen at all", async () => {
  const before = await claudeCalls();
  const { status, body } = await upload({ profileId: sweProfile });
  assert.equal(status, 200);
  assert.equal(body.scopedToTargets, true);
  assert.deepEqual(body.results.map((r) => r.role), ["Backend Engineer Intern"]);
  assert.equal(body.fit.role, "Backend Engineer Intern");
  // extract + explain only; record_qualifications (the PM checklist) is skipped entirely
  assert.deepEqual(diff(await claudeCalls(), before), { skills: 1, qualifications: 0, explain: 1, total: 2 });
});

test("vocabulary-only matching: unknown skills are reported but never added to the vocabulary", async () => {
  const skillsBefore = new Database(dbPath, { readonly: true }).prepare("SELECT COUNT(*) c FROM skills").get().c;
  const { body } = await upload({ profileId: sweProfile });
  assert.deepEqual(body.matchedSkills, ["Python"]);
  assert.ok(body.unmatchedSkills.includes("Figma")); // mock Claude returns Figma; no posting asks for it
  const db = new Database(dbPath, { readonly: true });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM skills").get().c, skillsBefore);
  db.close();
});

test("broadenFit opt-in: the PM assessment is made and cached on the resume", async () => {
  const before = await claudeCalls();
  const { body } = await upload({ profileId: sweProfile, broadenFit: "true" });
  assert.equal(body.scopedToTargets, false);
  assert.deepEqual(diff(await claudeCalls(), before), { skills: 1, qualifications: 1, explain: 1, total: 3 });
  const db = new Database(dbPath, { readonly: true });
  const stored = JSON.parse(db.prepare("SELECT qualifications FROM resumes WHERE resume_id = ?").get(body.resumeId).qualifications);
  db.close();
  assert.equal(stored["Product Manager Intern"].length, 6);
});

test("PM-only profile: SWE roles are excluded and PM is assessed", async () => {
  const before = await claudeCalls();
  const { body } = await upload({ profileId: pmProfile });
  assert.deepEqual(body.results.map((r) => r.role), ["Product Manager Intern"]);
  assert.equal(body.fit.role, "Product Manager Intern");
  assert.ok(body.fit.qualifications.length === 6);
  assert.equal(diff(await claudeCalls(), before).qualifications, 1);
});

test("no profile: searches every role (unscoped, same as before profiles existed)", async () => {
  const { body } = await upload();
  assert.equal(body.scopedToTargets, false);
  assert.deepEqual(body.results.map((r) => r.role).sort(), ["Backend Engineer Intern", "Product Manager Intern"]);
});

test("GET /resume/:id re-scores for free — zero Claude calls — including with ?broaden", async () => {
  const { body } = await upload({ profileId: sweProfile });
  const before = await claudeCalls();
  const plain = await api("GET", `/resume/${body.resumeId}`);
  assert.equal(plain.status, 200);
  assert.equal(plain.body.scopedToTargets, true);
  // broadening can't retroactively assess PM (it was never assessed at upload) — but it must not crash or call Claude
  const broad = await api("GET", `/resume/${body.resumeId}?broaden=1`);
  assert.equal(broad.status, 200);
  assert.equal(broad.body.scopedToTargets, false);
  assert.deepEqual(diff(await claudeCalls(), before), { skills: 0, qualifications: 0, explain: 0, total: 0 });
  assert.equal((await api("GET", "/resume/99999")).status, 404);
});

test("course-based readiness excludes qualifications-based roles (no resume text to assess)", async () => {
  const { body } = await api("GET", "/readiness/1");
  assert.deepEqual(body.results.map((r) => r.role), ["Backend Engineer Intern"]);
});

test("tracker: refuses cleanly when a profile has no Notion database, and unknown ids 404", async () => {
  const noDb = (await api("POST", "/profiles", { name: "NoDb", roleIds: [] })).body.profile.profile_id;
  const r = await api("POST", "/tracker", { profileId: noDb, listingId: "x" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /no Notion database/);
  assert.equal((await api("POST", "/tracker", { profileId: 99999, listingId: "x" })).status, 404);
  assert.equal((await api("POST", "/tracker", {})).status, 400);
});
