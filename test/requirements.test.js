const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { execFileSync } = require("child_process");
const { makeFixtureDb, rebuild, ROOT } = require("./helpers");
const { roleRequirements, scoreRole, scoreQualificationRole, MIN_SHARE, PREF_SHARE } = require("../lib/requirements");
const { qualificationsForRole } = require("../lib/qualifications");

const { dir, dbPath } = makeFixtureDb();
const db = new Database(dbPath);
test.after(() => db.close());

const role = (title) => db.prepare("SELECT role_id, title FROM roles WHERE title = ?").get(title);
const skillId = (name) => db.prepare("SELECT skill_id FROM skills WHERE name = ?").get(name).skill_id;
const names = (list) => list.map((s) => s.name).sort();

test("tiers: thresholds are inclusive and exact (50% required = minimum, 20% mentioned = preferred)", () => {
  assert.equal(MIN_SHARE, 0.5);
  assert.equal(PREF_SHARE, 0.2);
  const req = roleRequirements(db, role("Backend Engineer Intern").role_id);
  assert.equal(req.postings, 6); // the skill-less posting still counts toward the denominator
  assert.deepEqual(names(req.minimum), ["Python", "SQL"]); // SQL sits exactly on 3/6
  assert.deepEqual(names(req.preferred), ["Docker", "Git"]);
  const rolledUp = [...req.minimum, ...req.preferred].map((s) => s.name);
  assert.ok(!rolledUp.includes("Rust")); // 1/6 = 16.7% < 20%
});

test("tiers: industries come from the postings, not an asserted label", () => {
  assert.deepEqual(roleRequirements(db, role("Backend Engineer Intern").role_id).industries, ["Consumer Tech", "Fintech"]);
  // PM: one classified posting and one seed-style posting with no industry
  assert.deepEqual(roleRequirements(db, role("Product Manager Intern").role_id).industries, ["Fintech"]);
});

test("scoreRole: coverage and fitScore ignore postings with no required skills", () => {
  const r = role("Backend Engineer Intern");
  const have = new Set([skillId("Python"), skillId("SQL")]);
  const s = scoreRole(db, r, have);
  assert.deepEqual(s.minimum, { have: 2, total: 2, missing: [] });
  assert.deepEqual(s.preferred.missing.sort(), ["Docker", "Git"]);
  // per-posting required shares: 2/3, 2/3, 1, 1, 1 -> mean 0.8667 -> 87.
  // The empty 6th posting must NOT be averaged in as 0% (that would give 72).
  assert.equal(s.fitScore, 87);
  const empty = s.listings.find((l) => l.company === "Co6");
  assert.deepEqual(empty.required, { have: 0, total: 0, missing: [] }); // still shown honestly as 0/0
});

test("scoreRole: nothing owned -> 0%, everything owned -> 100%", () => {
  const r = role("Backend Engineer Intern");
  assert.equal(scoreRole(db, r, new Set()).fitScore, 0);
  const all = new Set(["Python", "SQL", "Git", "Docker", "Rust"].map(skillId));
  assert.equal(scoreRole(db, r, all).fitScore, 100);
});

test("scoreRole: a role with no extracted skills at all scores 0, not NaN", () => {
  const s = scoreRole(db, role("Product Manager Intern"), new Set([skillId("Python")]));
  assert.equal(s.fitScore, 0);
  assert.ok(Number.isFinite(s.fitScore));
});

test("scoreQualificationRole: share evidenced, in checklist order, unassessed = not evidenced", () => {
  const r = role("Product Manager Intern");
  const quals = qualificationsForRole(r.title);
  const assessment = [
    { name: quals[2], evidenced: true, evidence: "shipped with eng + design" },
    { name: quals[0], evidenced: true, evidence: "prioritized features" },
    { name: quals[1], evidenced: false, evidence: "" },
  ]; // deliberately out of order and incomplete
  const s = scoreQualificationRole(db, r, quals, assessment);
  assert.deepEqual(s.qualifications.map((q) => q.name), quals);
  assert.equal(s.qualifications.filter((q) => q.evidenced).length, 2);
  assert.equal(s.fitScore, 33); // 2/6
  assert.equal(s.minimum.total, 6);
  assert.deepEqual(s.minimum.missing, quals.filter((q) => q !== quals[0] && q !== quals[2]));
  assert.equal(s.postings, 2); // real posting count still flows through
});

test("scoreQualificationRole: no assessment at all -> 0%, no crash", () => {
  const r = role("Product Manager Intern");
  const s = scoreQualificationRole(db, r, qualificationsForRole(r.title), null);
  assert.equal(s.fitScore, 0);
});

// requirements.js and requirements.py are two implementations of one rule
// ("keep in sync" is only a comment until something enforces it)
test("JS and Python implementations agree on minimum/preferred", () => {
  const py = `
import json, sqlite3, sys
sys.path.insert(0, ${JSON.stringify(ROOT)})
from requirements import role_requirements
cur = sqlite3.connect(${JSON.stringify(dbPath)}).cursor()
out = {}
for rid, title in cur.execute("SELECT role_id, title FROM roles").fetchall():
    r = role_requirements(cur, rid)
    out[title] = {"postings": r["postings"], "minimum": sorted(n for _, n in r["minimum"]), "preferred": sorted(n for _, n in r["preferred"])}
print(json.dumps(out))`;
  const fromPy = JSON.parse(execFileSync("python3", ["-c", py], { encoding: "utf8" }));
  for (const title of Object.keys(fromPy)) {
    const js = roleRequirements(db, role(title).role_id);
    assert.deepEqual(
      { postings: js.postings, minimum: names(js.minimum), preferred: names(js.preferred) },
      fromPy[title],
      `JS and Python disagree for ${title}`
    );
  }
});

// resumes/profiles must survive a rebuild, and ids must not shift under them
test("build_db.py: re-running is idempotent and never touches runtime tables", () => {
  const countsOf = (conn) => Object.fromEntries(["roles", "skills", "job_postings", "posting_skills"].map((t) => [t, conn.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c]));
  const before = countsOf(db);
  const backendId = role("Backend Engineer Intern").role_id;

  const w = new Database(dbPath);
  w.prepare("INSERT INTO profiles (name, created_at) VALUES ('Me', 'now')").run();
  w.prepare("INSERT INTO resumes (profile_id, filename, uploaded_at, fit_role_id) VALUES (1, 'r.pdf', 'now', ?)").run(backendId);
  w.close();

  rebuild(dir);
  rebuild(dir);

  // Read through a FRESH connection. A connection opened before the rebuild
  // keeps pointing at the old file if build_db.py deletes and recreates it,
  // so it would happily report the old data and hide exactly this bug.
  const fresh = new Database(dbPath);
  try {
    assert.deepEqual(countsOf(fresh), before); // no duplicate seed rows
    assert.equal(fresh.prepare("SELECT role_id FROM roles WHERE title = 'Backend Engineer Intern'").get().role_id, backendId); // ids stable
    assert.deepEqual(fresh.prepare("SELECT filename, fit_role_id FROM resumes").get(), { filename: "r.pdf", fit_role_id: backendId }); // runtime data survived
    assert.equal(fresh.prepare("SELECT COUNT(*) c FROM profiles").get().c, 1);
  } finally {
    fresh.close();
  }
});
