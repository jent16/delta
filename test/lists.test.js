const test = require("node:test");
const assert = require("node:assert/strict");
const { tracksForRole, GENERAL } = require("../lib/tracks");
const { INDUSTRIES } = require("../lib/industries");
const { qualificationsForRole } = require("../lib/qualifications");

// lib/extract-skills.js falls back to the LAST element of these lists when
// Claude returns something invalid — so "last = the catch-all" is a contract.
test("fallback convention: the last track / industry is the catch-all", () => {
  for (const role of ["Software Engineer Intern", "Backend Engineer Intern", "Full Stack Engineer Intern", "Product Manager Intern", "Anything Else"]) {
    const tracks = tracksForRole(role);
    assert.equal(tracks[tracks.length - 1], GENERAL, `${role}`);
  }
  assert.equal(INDUSTRIES[INDUSTRIES.length - 1], "General Technology");
});

test("closed lists have no duplicates and no commas (commas break Notion options)", () => {
  for (const list of [INDUSTRIES, tracksForRole("Software Engineer Intern"), qualificationsForRole("Product Manager Intern")]) {
    assert.equal(new Set(list).size, list.length);
    assert.ok(list.every((x) => !x.includes(",")));
  }
});

test("tracksForRole: case-insensitive, unknown roles get the generic list", () => {
  assert.deepEqual(tracksForRole("  BACKEND engineer intern "), tracksForRole("backend engineer intern"));
  assert.deepEqual(tracksForRole("Underwater Basket Intern"), ["Technical", "Business", GENERAL]);
});

test("qualificationsForRole: PM is checklist-scored, SWE roles are not", () => {
  assert.equal(qualificationsForRole("Product Manager Intern").length, 6);
  assert.equal(qualificationsForRole("product manager intern").length, 6);
  assert.equal(qualificationsForRole("Backend Engineer Intern"), null);
  assert.equal(qualificationsForRole(undefined), null);
});
