// How far an application got. This drives the progress bar on each row.
//
// Four segments after "not applied yet":
//   0  not applied (saved / drafting)
//   1  applied
//   2  reached assessment (or went past it)
//   3  reached interview (or went past it)
//   4  offer
//
// It is the FURTHEST stage ever reached, read from the dated history, not the
// current status: a rejected application should still show it got to the
// interview. How it ended (rejected / withdrawn / ghosted) is separate, so the
// bar can show both "got this far" and "and then it ended this way".
// It needs no extra input from you, which is why it works and "progress toward
// a job" (one rare event) or "rounds completed" (unknown total) would not.

import type { StatusEvent } from "./application.ts";
import type { Status } from "./status.ts";

export const PROGRESS_STAGES = ["Applied", "Assessment", "Interview", "Offer"] as const;

export type Outcome = "rejected" | "withdrawn" | "ghosted" | null;

export interface Progress {
  level: 0 | 1 | 2 | 3 | 4;
  outcome: Outcome;
}

const LEVEL_OF: Partial<Record<Status, 1 | 2 | 3 | 4>> = {
  applied: 1,
  assessment: 2,
  interview: 3,
  offer: 4,
};

export function computeProgress(history: StatusEvent[], current: Status): Progress {
  let level: Progress["level"] = 0;
  for (const e of history) {
    const l = LEVEL_OF[e.status];
    if (l !== undefined && l > level) level = l;
  }
  const outcome: Outcome = current === "rejected" || current === "withdrawn" || current === "ghosted" ? current : null;
  return { level, outcome };
}
