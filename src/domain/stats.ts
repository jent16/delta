// Numbers about how your search is going, computed from the applications and
// their dated status history. Pure: give it rows, get numbers.
//
// Definitions (the numbers are only meaningful if these are fixed):
//   applied       an application that ever had an "applied" event
//   reached X     had an event at stage X or LATER on the main track
//                 (applied -> assessment -> interview -> offer). "Later" counts
//                 because stages can be skipped: going Applied -> Interview
//                 means you got past the assessment stage, not that you failed it.
//   responded     applied AND heard something real back: assessment, interview,
//                 offer or a rejection. Silence (ghosted) and withdrawing are not responses.
//   days to response   first applied date -> first response date. Rows imported
//                 from Notion have approximate rejection dates (see decisions.md).

import type { ExportedApplication } from "./export.ts";
import { daysBetween } from "./dates.ts";
import { STATUSES } from "./status.ts";
import type { Status } from "./status.ts";

export interface Stats {
  total: number;
  byStatus: Record<Status, number>;
  byFunction: Record<string, number>;
  bySector: Record<string, number>;
  funnel: { applied: number; assessment: number; interview: number; offer: number };
  response: { applied: number; responded: number; rate: number | null };
  daysToFirstResponse: { median: number | null; samples: number };
}

const REACHED_ASSESSMENT: Status[] = ["assessment", "interview", "offer"];
const REACHED_INTERVIEW: Status[] = ["interview", "offer"];
const RESPONSES: Status[] = ["assessment", "interview", "offer", "rejected"];

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

export function computeStats(rows: ExportedApplication[]): Stats {
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
  const byFunction: Record<string, number> = {};
  const bySector: Record<string, number> = {};
  const funnel = { applied: 0, assessment: 0, interview: 0, offer: 0 };
  let responded = 0;
  const waits: number[] = [];

  for (const { application: a, history } of rows) {
    byStatus[a.status]++;
    byFunction[a.roleFunction] = (byFunction[a.roleFunction] ?? 0) + 1;
    const sector = a.sector ?? "Unknown";
    bySector[sector] = (bySector[sector] ?? 0) + 1;

    const has = (set: Status[]) => history.some((e) => set.includes(e.status));
    const appliedEvents = history.filter((e) => e.status === "applied");
    if (!appliedEvents.length) continue;
    funnel.applied++;
    if (has(REACHED_ASSESSMENT)) funnel.assessment++;
    if (has(REACHED_INTERVIEW)) funnel.interview++;
    if (history.some((e) => e.status === "offer")) funnel.offer++;

    const responses = history.filter((e) => RESPONSES.includes(e.status));
    if (responses.length) {
      responded++;
      const firstApplied = appliedEvents.map((e) => e.occurredOn).sort()[0]!;
      const firstResponse = responses.map((e) => e.occurredOn).sort()[0]!;
      const days = daysBetween(firstApplied, firstResponse);
      if (days >= 0) waits.push(days); // a backdated oddity (response before applying) is not a wait
    }
  }

  return {
    total: rows.length,
    byStatus,
    byFunction,
    bySector,
    funnel,
    response: { applied: funnel.applied, responded, rate: funnel.applied ? Math.round((responded / funnel.applied) * 1000) / 1000 : null },
    daysToFirstResponse: { median: median(waits), samples: waits.length },
  };
}
