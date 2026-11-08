import test from "node:test";
import assert from "node:assert/strict";
import type { Application, StatusEvent } from "./application.ts";
import { computeBreakdowns, computeTimeInStage, MIN_SAMPLE } from "./breakdowns.ts";
import type { ExportedApplication } from "./export.ts";
import type { Status } from "./status.ts";

let n = 0;
function row(history: [Status, string][], over: Partial<Application> = {}): ExportedApplication {
  const id = ++n;
  const events: StatusEvent[] = history.map(([status, occurredOn], i) => ({ id: id * 100 + i, applicationId: id, status, occurredOn, note: null, createdAt: "t" }));
  const application = { id, userId: 1, companyId: 1, company: `Co${id}`, roleTitle: "SWE", roleFunction: "SWE", sector: null, location: null, term: null, url: null, source: null,
    appliedOn: null, deadlineOn: null, followUpOn: null, resumeVersion: null, compensation: null, notes: "", status: history[history.length - 1]![0], archivedAt: null, createdAt: "t", updatedAt: "t", ...over } as Application;
  return { application, history: events };
}
const by = (rows: ExportedApplication[], dim: "function" | "sector" | "source" | "resume") => computeBreakdowns(rows)[dim];

test("rows are grouped by the dimension, counting only applications that were actually sent", () => {
  const rows = [
    row([["applied", "2026-09-01"]], { roleFunction: "SWE" }),
    row([["applied", "2026-09-01"], ["interview", "2026-09-10"]], { roleFunction: "SWE" }),
    row([["applied", "2026-09-01"], ["rejected", "2026-09-12"]], { roleFunction: "PM" }),
    row([["saved", "2026-09-01"]], { roleFunction: "PM" }),                // never sent: not counted anywhere
  ];
  assert.deepEqual(by(rows, "function"), [
    { key: "SWE", sent: 2, replied: 1, interviews: 1, offers: 0, ghosted: 0 },
    { key: "PM", sent: 1, replied: 1, interviews: 0, offers: 0, ghosted: 0 },
  ]);
});

test("replied = assessment, interview, offer or a rejection; silence and withdrawing are not replies", () => {
  const rows = [
    row([["applied", "2026-09-01"], ["assessment", "2026-09-05"]]),
    row([["applied", "2026-09-01"], ["rejected", "2026-09-05"]]),
    row([["applied", "2026-09-01"], ["ghosted", "2026-10-01"]]),
    row([["applied", "2026-09-01"], ["withdrawn", "2026-09-05"]]),
    row([["applied", "2026-09-01"]]),
  ];
  const r = by(rows, "function")[0]!;
  assert.deepEqual([r.sent, r.replied, r.ghosted], [5, 2, 1]);
});

test("interviews and offers count at-least-that-far, so a skipped assessment still counts", () => {
  const rows = [row([["applied", "2026-09-01"], ["interview", "2026-09-10"], ["offer", "2026-09-20"]]), row([["applied", "2026-09-01"], ["interview", "2026-09-10"]])];
  const r = by(rows, "function")[0]!;
  assert.deepEqual([r.interviews, r.offers], [2, 1]);
});

test("an application that was ghosted and then revived is counted once, as replied, and is no longer ghosted", () => {
  const r = by([row([["applied", "2026-09-01"], ["ghosted", "2026-10-01"], ["interview", "2026-10-20"]])], "function")[0]!;
  assert.deepEqual([r.sent, r.replied, r.interviews, r.ghosted], [1, 1, 1, 0]);
});

test("missing or blank values group as Unknown, which always sorts last whatever its size; the rest by size then name", () => {
  const rows = [
    ...[1, 2, 3, 4].map(() => row([["applied", "2026-09-01"]], { source: null })),
    ...[1, 2].map(() => row([["applied", "2026-09-01"]], { source: "Referral" })),
    row([["applied", "2026-09-01"]], { source: "  " }),                 // blank is unknown too
    row([["applied", "2026-09-01"]], { source: "LinkedIn" }),
    row([["applied", "2026-09-01"]], { source: "Career fair" }),
  ];
  assert.deepEqual(by(rows, "source").map((r) => [r.key, r.sent]), [["Referral", 2], ["Career fair", 1], ["LinkedIn", 1], ["Unknown", 5]]);
});

test("sector and resume version group the same way; resume version is trimmed", () => {
  const rows = [
    row([["applied", "2026-09-01"]], { sector: "Fintech", resumeVersion: " v2 " }),
    row([["applied", "2026-09-01"]], { sector: "Fintech", resumeVersion: "v2" }),
    row([["applied", "2026-09-01"]], { sector: null, resumeVersion: null }),
  ];
  assert.deepEqual(by(rows, "sector").map((r) => [r.key, r.sent]), [["Fintech", 2], ["Unknown", 1]]);
  assert.deepEqual(by(rows, "resume").map((r) => [r.key, r.sent]), [["v2", 2], ["Unknown", 1]]);
});

test("nothing sent means empty tables, not zero rows", () => {
  const b = computeBreakdowns([row([["saved", "2026-09-01"]])]);
  assert.deepEqual([b.function, b.sector, b.source, b.resume], [[], [], [], []]);
  assert.deepEqual(computeBreakdowns([]).function, []);
});

test("MIN_SAMPLE is the point below which a rate is a hint (so the UI can say so)", () => {
  assert.equal(MIN_SAMPLE, 10);
});

// ---- time in stage ----
const stage = (rows: ExportedApplication[], s: Status) => computeTimeInStage(rows).find((t) => t.stage === s)!;

test("time in a stage is the days until the next recorded event; medians across applications", () => {
  const rows = [
    row([["saved", "2026-09-01"], ["drafting", "2026-09-04"], ["applied", "2026-09-10"], ["assessment", "2026-09-20"], ["interview", "2026-10-05"]]),
    row([["applied", "2026-09-01"], ["assessment", "2026-09-05"]]),
    row([["applied", "2026-09-01"], ["assessment", "2026-09-11"]]),
  ];
  assert.deepEqual(stage(rows, "saved"), { stage: "saved", median: 3, samples: 1 });
  assert.deepEqual(stage(rows, "drafting"), { stage: "drafting", median: 6, samples: 1 });
  assert.deepEqual(stage(rows, "applied"), { stage: "applied", median: 10, samples: 3 }); // 10, 4, 10 -> 10
  assert.deepEqual(stage(rows, "assessment"), { stage: "assessment", median: 15, samples: 1 });
  assert.deepEqual(stage(rows, "interview"), { stage: "interview", median: null, samples: 0 }); // nothing after it yet
});

test("a move into ghosted is not leaving the stage: its date is when YOU gave up", () => {
  const rows = [row([["applied", "2026-09-01"], ["ghosted", "2026-11-05"]])]; // "marked ghosted" two months later
  assert.deepEqual(stage(rows, "applied"), { stage: "applied", median: null, samples: 0 });
  // but coming back from ghosted to a real step is not time spent "in applied" either, and ghosted is not a stage we report
  const revived = [row([["applied", "2026-09-01"], ["ghosted", "2026-10-01"], ["interview", "2026-10-20"]])];
  assert.equal(stage(revived, "applied").samples, 0);
  assert.equal(computeTimeInStage(revived).some((t) => t.stage === "ghosted"), false);
});

test("a rejection or withdrawal does end a stage; a next event dated BEFORE this one (a backdated oddity) is skipped", () => {
  const rows = [row([["applied", "2026-09-01"], ["rejected", "2026-09-13"]]), row([["applied", "2026-09-20"], ["assessment", "2026-09-10"]])];
  assert.deepEqual(stage(rows, "applied"), { stage: "applied", median: 12, samples: 1 });
});

test("the five stages are always reported, in order, even with no data", () => {
  assert.deepEqual(computeTimeInStage([]).map((t) => [t.stage, t.median, t.samples]), [["saved", null, 0], ["drafting", null, 0], ["applied", null, 0], ["assessment", null, 0], ["interview", null, 0]]);
});

test("an offer that arrived with no interview recorded still counts as having got past the interview stage", () => {
  const r = by([row([["applied", "2026-09-01"], ["offer", "2026-09-20"]])], "function")[0]!;
  assert.deepEqual([r.interviews, r.offers, r.replied], [1, 1, 1]);
});
