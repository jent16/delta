import test from "node:test";
import assert from "node:assert/strict";
import type { Application, StatusEvent } from "./application.ts";
import type { ExportedApplication } from "./export.ts";
import { computeReminders } from "./reminders.ts";
import type { Status } from "./status.ts";

const TODAY = "2026-11-05";
let n = 0;
function row(status: Status, over: Partial<Application> = {}, lastEventOn = "2026-11-01"): ExportedApplication {
  const id = ++n;
  const application = {
    id, userId: 1, company: `Co${id}`, roleTitle: "SWE", roleFunction: "SWE", sector: null, location: null, term: null, url: null, source: null,
    appliedOn: null, deadlineOn: null, followUpOn: null, resumeVersion: null, compensation: null, notes: "", status, archivedAt: null,
    createdAt: "t", updatedAt: "t", ...over,
  } as Application;
  const history: StatusEvent[] = [{ id, applicationId: id, status, occurredOn: lastEventOn, note: null, createdAt: "t" }];
  return { application, history };
}
const ids = (xs: { application: Application }[]) => xs.map((x) => x.application.id);

test("follow-ups: overdue, due today and within the window are listed oldest first; later ones are not", () => {
  const a = row("applied", { followUpOn: "2026-11-01" });  // 4 days overdue
  const b = row("applied", { followUpOn: "2026-11-05" });  // today
  const c = row("applied", { followUpOn: "2026-11-12" });  // exactly 7 days out: included
  const d = row("applied", { followUpOn: "2026-11-13" });  // 8 days out: not yet
  const r = computeReminders([c, d, b, a], TODAY);
  assert.deepEqual(ids(r.followUps), [a.application.id, b.application.id, c.application.id]);
  assert.deepEqual(r.followUps.map((f) => f.daysOverdue), [4, 0, -7]);
});

test("closed and archived applications never produce reminders", () => {
  const rows = [
    row("rejected", { followUpOn: "2026-11-01" }),
    row("withdrawn", { followUpOn: "2026-11-01" }),
    row("applied", { followUpOn: "2026-11-01", archivedAt: "2026-10-01T00:00:00Z" }),
  ];
  const r = computeReminders(rows, TODAY);
  assert.deepEqual([r.followUps.length, r.deadlines.length, r.stale.length], [0, 0, 0]);
});

test("deadlines matter only for things you haven't submitted; recently missed ones are flagged, old ones dropped", () => {
  const soon = row("saved", { deadlineOn: "2026-11-08" });
  const today = row("drafting", { deadlineOn: "2026-11-05" });
  const missed = row("saved", { deadlineOn: "2026-11-02" });
  const ancient = row("saved", { deadlineOn: "2026-09-01" });
  const far = row("saved", { deadlineOn: "2026-12-30" });
  const submitted = row("applied", { deadlineOn: "2026-11-06" });
  const r = computeReminders([far, soon, ancient, submitted, missed, today], TODAY);
  assert.deepEqual(r.deadlines.map((d) => [d.application.id, d.daysLeft, d.missed]), [
    [missed.application.id, -3, true],
    [today.application.id, 0, false],
    [soon.application.id, 3, false],
  ]);
});

test("stale: in-flight applications silent for 21+ days with no follow-up date, longest silence first", () => {
  const old = row("applied", {}, "2026-09-01");        // 65 days
  const edge = row("applied", {}, "2026-10-15");       // 21 days: stale
  const justUnder = row("applied", {}, "2026-10-16");  // 20 days: not yet
  const interview = row("interview", {}, "2026-09-20");
  const hasPlan = row("applied", { followUpOn: "2027-01-01" }, "2026-09-01"); // you already decided when to follow up
  const notSent = row("saved", {}, "2026-08-01");      // not applied: nothing to follow up
  const ghosted = row("ghosted", {}, "2026-08-01");    // already flagged as silent
  const r = computeReminders([justUnder, edge, notSent, hasPlan, old, ghosted, interview], TODAY);
  assert.deepEqual(r.stale.map((s) => [s.application.id, s.daysSince]), [[old.application.id, 65], [interview.application.id, 46], [edge.application.id, 21]]);
});

test("the window and stale threshold are adjustable", () => {
  const a = row("applied", { followUpOn: "2026-11-20" }, "2026-10-30");
  assert.equal(computeReminders([a], TODAY, { days: 7, staleDays: 21 }).followUps.length, 0);
  assert.equal(computeReminders([a], TODAY, { days: 30, staleDays: 21 }).followUps.length, 1);
  const b = row("applied", {}, "2026-10-30"); // 6 days
  assert.equal(computeReminders([b], TODAY, { days: 7, staleDays: 5 }).stale.length, 1);
});
