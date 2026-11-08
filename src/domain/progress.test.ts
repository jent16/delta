import test from "node:test";
import assert from "node:assert/strict";
import type { StatusEvent } from "./application.ts";
import { computeProgress, PROGRESS_STAGES } from "./progress.ts";
import { STATUSES } from "./status.ts";
import type { Status } from "./status.ts";

const events = (...statuses: Status[]): StatusEvent[] =>
  statuses.map((status, i) => ({ id: i + 1, applicationId: 1, status, occurredOn: `2026-09-${String(i + 1).padStart(2, "0")}`, note: null, createdAt: "t" }));

test("before applying there is no progress", () => {
  assert.deepEqual(computeProgress(events("saved"), "saved"), { level: 0, outcome: null });
  assert.deepEqual(computeProgress(events("saved", "drafting"), "drafting"), { level: 0, outcome: null });
});

test("each stage is one segment further", () => {
  assert.equal(computeProgress(events("saved", "applied"), "applied").level, 1);
  assert.equal(computeProgress(events("applied", "assessment"), "assessment").level, 2);
  assert.equal(computeProgress(events("applied", "interview"), "interview").level, 3);
  assert.equal(computeProgress(events("applied", "offer"), "offer").level, 4);
});

test("skipping a stage still counts as getting past it", () => {
  assert.equal(computeProgress(events("applied", "interview"), "interview").level, 3); // no assessment
});

test("it is the furthest stage ever reached, not the current one: a rejection keeps what it earned", () => {
  assert.deepEqual(computeProgress(events("applied", "assessment", "interview", "rejected"), "rejected"), { level: 3, outcome: "rejected" });
  assert.deepEqual(computeProgress(events("applied", "interview", "ghosted"), "ghosted"), { level: 3, outcome: "ghosted" });
});

test("an application that ended without ever being sent shows the outcome at level 0", () => {
  assert.deepEqual(computeProgress(events("saved", "withdrawn"), "withdrawn"), { level: 0, outcome: "withdrawn" });
});

test("a ghosted application that revives is no longer 'ended', and keeps its progress", () => {
  assert.deepEqual(computeProgress(events("applied", "ghosted", "interview"), "interview"), { level: 3, outcome: null });
});

test("history order does not matter: the furthest stage wins wherever it sits", () => {
  assert.equal(computeProgress(events("interview", "applied"), "applied").level, 3);
});

test("only rejected, withdrawn and ghosted are outcomes; no other status is", () => {
  for (const s of STATUSES) {
    const outcome = computeProgress(events(s), s).outcome;
    assert.equal(outcome !== null, s === "rejected" || s === "withdrawn" || s === "ghosted", s);
    if (outcome !== null) assert.equal(outcome, s);
  }
});

test("there are four named segments, matching the highest level", () => {
  assert.deepEqual([...PROGRESS_STAGES], ["Applied", "Assessment", "Interview", "Offer"]);
});
