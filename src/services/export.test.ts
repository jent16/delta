import test from "node:test";
import assert from "node:assert/strict";
import { makeTracker } from "../testing/harness.ts";

test("the export includes archived applications and their full history", () => {
  const t = makeTracker();
  const a = t.service.add(1, { company: "Stripe", roleTitle: "SWE", appliedOn: "2026-09-01" });
  t.service.changeStatus(1, a.id, { status: "interview", on: "2026-09-20" });
  const b = t.service.add(1, { company: "Figma", roleTitle: "SWE" });
  t.service.archive(1, b.id);
  const j = t.exports.json(1).body;
  assert.deepEqual(j.applications.map((x) => [x.company, x.archived]), [["Stripe", false], ["Figma", true]]);
  assert.deepEqual(j.applications[0]!.history.map((h) => h.status), ["applied", "interview"]);
  assert.equal(j.lists.length, 3);
  assert.equal(t.exports.json(1).filename, "delta-export-2026-09-15.json");
});

test("an export is never truncated, unlike the 500-row list view", () => {
  const t = makeTracker();
  for (let i = 0; i < 620; i++) t.service.add(1, { company: `Company ${i}`, roleTitle: "SWE" });
  assert.equal(t.service.list(1, {}).length, 500); // the view is capped...
  assert.equal(t.exports.json(1).body.applications.length, 620); // ...the export is not
  assert.equal(t.exports.csv(1).body.trim().split("\r\n").length, 621);
});

test("an export contains only the caller's data", () => {
  const t = makeTracker();
  t.db.prepare("INSERT INTO users (id, name, created_at) VALUES (2, 'Other', 'now')").run();
  t.service.add(1, { company: "Mine", roleTitle: "SWE" });
  t.service.add(2, { company: "Theirs", roleTitle: "SWE" });
  assert.deepEqual(t.exports.json(1).body.applications.map((a) => a.company), ["Mine"]);
  assert.ok(!t.exports.csv(2).body.includes("Mine"));
  assert.equal(t.exports.json(2).body.lists.length, 0);
});
