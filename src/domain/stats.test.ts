import test from "node:test";
import assert from "node:assert/strict";
import type { Application, StatusEvent } from "./application.ts";
import type { ExportedApplication } from "./export.ts";
import type { Status } from "./status.ts";
import { computeStats } from "./stats.ts";

let n = 0;
function row(history: [Status, string][], over: Partial<Application> = {}): ExportedApplication {
  const id = ++n;
  const events: StatusEvent[] = history.map(([status, occurredOn], i) => ({ id: id * 100 + i, applicationId: id, status, occurredOn, note: null, createdAt: "t" }));
  const application = {
    id, userId: 1, company: `Co${id}`, roleTitle: "SWE", roleFunction: "SWE", sector: null, location: null, term: null, url: null, source: null,
    appliedOn: null, deadlineOn: null, followUpOn: null, resumeVersion: null, compensation: null, notes: "", status: history[history.length - 1]![0],
    archivedAt: null, createdAt: "t", updatedAt: "t", ...over,
  } as Application;
  return { application, history: events };
}

test("an empty tracker has zeros and no rate (not 0%, not NaN)", () => {
  const s = computeStats([]);
  assert.equal(s.total, 0);
  assert.deepEqual(s.funnel, { applied: 0, assessment: 0, interview: 0, offer: 0 });
  assert.deepEqual([s.response.rate, s.daysToFirstResponse.median], [null, null]);
  assert.equal(s.byStatus.applied, 0);
});

test("saved and drafting applications are not 'applied'", () => {
  const s = computeStats([row([["saved", "2026-09-01"]]), row([["saved", "2026-09-01"], ["drafting", "2026-09-02"]]), row([["applied", "2026-09-03"]])]);
  assert.equal(s.total, 3);
  assert.equal(s.funnel.applied, 1);
});

test("funnel counts 'at least this stage': skipping the assessment still counts as getting past it", () => {
  const s = computeStats([
    row([["applied", "2026-09-01"], ["interview", "2026-09-10"]]), // skipped the assessment
    row([["applied", "2026-09-01"], ["assessment", "2026-09-05"]]),
    row([["applied", "2026-09-01"], ["interview", "2026-09-10"], ["offer", "2026-09-20"]]),
    row([["applied", "2026-09-01"]]),
  ]);
  assert.deepEqual(s.funnel, { applied: 4, assessment: 3, interview: 2, offer: 1 });
});

test("response: assessments, interviews, offers and rejections count; silence and withdrawing do not", () => {
  const s = computeStats([
    row([["applied", "2026-09-01"], ["rejected", "2026-09-11"]]),
    row([["applied", "2026-09-01"], ["ghosted", "2026-10-01"]]),
    row([["applied", "2026-09-01"], ["withdrawn", "2026-09-05"]]),
    row([["applied", "2026-09-01"]]),
  ]);
  assert.deepEqual(s.response, { applied: 4, responded: 1, rate: 0.25 });
  assert.equal(s.funnel.assessment, 0); // a rejection is a response but not progress
});

test("an application that was ghosted and later answered counts as responded", () => {
  const s = computeStats([row([["applied", "2026-09-01"], ["ghosted", "2026-10-01"], ["interview", "2026-11-01"]])]);
  assert.equal(s.response.responded, 1);
});

test("days to first response: median of first-applied to first-response; negatives are ignored", () => {
  const s = computeStats([
    row([["applied", "2026-09-01"], ["rejected", "2026-09-05"]]), // 4
    row([["applied", "2026-09-01"], ["interview", "2026-09-11"]]), // 10
    row([["applied", "2026-09-01"], ["assessment", "2026-09-04"], ["interview", "2026-09-30"]]), // first response = 3, not 29
    row([["applied", "2026-09-10"], ["rejected", "2026-09-01"]]), // backdated before applying: not a wait
  ]);
  assert.deepEqual(s.daysToFirstResponse, { median: 4, samples: 3 });
  assert.equal(s.response.responded, 4); // still responded, just no valid wait
});

test("the median of an even count is the midpoint", () => {
  const s = computeStats([row([["applied", "2026-09-01"], ["rejected", "2026-09-03"]]), row([["applied", "2026-09-01"], ["rejected", "2026-09-09"]])]);
  assert.equal(s.daysToFirstResponse.median, 5);
});

test("breakdowns: by current status, function and sector (unknown sector is its own bucket)", () => {
  const s = computeStats([
    row([["applied", "2026-09-01"]], { sector: "Finance" }),
    row([["applied", "2026-09-01"]], { sector: "Finance", roleFunction: "PM" }),
    row([["saved", "2026-09-01"]]),
  ]);
  assert.deepEqual(s.byStatus.applied, 2);
  assert.deepEqual(s.byFunction, { SWE: 2, PM: 1 });
  assert.deepEqual(s.bySector, { Finance: 2, Unknown: 1 });
});
