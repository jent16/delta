import test from "node:test";
import assert from "node:assert/strict";
import type { StatusEvent } from "./application.ts";
import { computeProgress, historyDates, PROGRESS_STAGES } from "./progress.ts";
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

const on = (status: Status, occurredOn: string, id: number): StatusEvent => ({ id, applicationId: 1, status, occurredOn, note: null, createdAt: "t" });

test("historyDates: first applied date and the newest event's date", () => {
  assert.deepEqual(historyDates([on("saved", "2026-08-01", 1), on("applied", "2026-09-02", 2), on("interview", "2026-09-20", 3)]), { firstAppliedOn: "2026-09-02", lastChangeOn: "2026-09-20" });
});

test("historyDates: nothing sent yet means no applied date; no history means no dates at all", () => {
  assert.deepEqual(historyDates([on("saved", "2026-08-01", 1), on("drafting", "2026-08-05", 2)]), { firstAppliedOn: null, lastChangeOn: "2026-08-05" });
  assert.deepEqual(historyDates([]), { firstAppliedOn: null, lastChangeOn: null });
});

test("historyDates: with more than one applied event the EARLIEST date is the first; 'last' is the newest recorded event, even if back-dated", () => {
  const h = [on("applied", "2026-09-10", 1), on("ghosted", "2026-10-30", 2), on("applied", "2026-09-01", 3), on("interview", "2026-10-02", 4)];
  assert.deepEqual(historyDates(h), { firstAppliedOn: "2026-09-01", lastChangeOn: "2026-10-02" });
});
