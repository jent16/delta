// "Where do replies come from, and how long does each stage take?" Pure: give it rows, get numbers.
//
// Same definitions as stats.ts (see its header): only applications that were actually SENT count, "replied"
// means a real response (assessment, interview, offer or a rejection; silence and withdrawing are not replies).
//
// These tables are useful only if you can see HOW MUCH data is behind each number, so every row carries its
// counts and the payload carries MIN_SAMPLE: below that a rate is a hint, not a finding. (With 4 replies from
// 94 applications, "Fintech replies 25%" is one reply.)

import type { Application } from "./application.ts";
import { daysBetween } from "./dates.ts";
import type { ExportedApplication } from "./export.ts";
import type { Status } from "./status.ts";

export const MIN_SAMPLE = 10;

export const DIMENSIONS = ["function", "sector", "source", "resume"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export interface BreakdownRow {
  key: string;
  sent: number;
  replied: number;
  interviews: number;
  offers: number;
  /** Sent, and now marked ghosted. */
  ghosted: number;
}

const UNKNOWN = "Unknown";
const REPLIES: Status[] = ["assessment", "interview", "offer", "rejected"];
const INTERVIEWS: Status[] = ["interview", "offer"];

const KEY_OF: Record<Dimension, (a: Application) => string> = {
  function: (a) => a.roleFunction,
  sector: (a) => a.sector ?? UNKNOWN,
  source: (a) => a.source?.trim() || UNKNOWN,
  resume: (a) => a.resumeVersion?.trim() || UNKNOWN,
};

export function computeBreakdowns(rows: ExportedApplication[]): Record<Dimension, BreakdownRow[]> {
  const out = {} as Record<Dimension, BreakdownRow[]>;
  for (const dim of DIMENSIONS) {
    const groups = new Map<string, BreakdownRow>();
    for (const { application: a, history } of rows) {
      if (!history.some((e) => e.status === "applied")) continue; // never sent: not part of any rate
      const key = KEY_OF[dim](a);
      const g = groups.get(key) ?? { key, sent: 0, replied: 0, interviews: 0, offers: 0, ghosted: 0 };
      g.sent++;
      if (history.some((e) => REPLIES.includes(e.status))) g.replied++;
      if (history.some((e) => INTERVIEWS.includes(e.status))) g.interviews++;
      if (history.some((e) => e.status === "offer")) g.offers++;
      if (a.status === "ghosted") g.ghosted++;
      groups.set(key, g);
    }
    // biggest groups first; "Unknown" always last so it doesn't push real groups down; then by name
    out[dim] = [...groups.values()].sort((x, y) => Number(x.key === UNKNOWN) - Number(y.key === UNKNOWN) || y.sent - x.sent || x.key.localeCompare(y.key));
  }
  return out;
}

export interface StageTime {
  stage: Status;
  /** Median whole days spent in this stage before moving on to the next real step. */
  median: number | null;
  samples: number;
}

const STAGES: Status[] = ["saved", "drafting", "applied", "assessment", "interview"];

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/**
 * How long applications sit in each stage: the days between entering a stage and the next recorded event.
 * A move INTO "ghosted" is not counted as leaving the stage: its date is the day YOU decided to stop waiting,
 * not something that happened to the application, so counting it would make "applied" look like however long
 * you left it before cleaning up. Backdated oddities (a next event dated before this one) are skipped.
 */
export function computeTimeInStage(rows: ExportedApplication[]): StageTime[] {
  const days = new Map<Status, number[]>(STAGES.map((s) => [s, []]));
  for (const { history } of rows) {
    for (let i = 0; i < history.length - 1; i++) {
      const here = history[i]!, next = history[i + 1]!;
      if (!days.has(here.status) || next.status === "ghosted") continue;
      const d = daysBetween(here.occurredOn, next.occurredOn);
      if (d >= 0) days.get(here.status)!.push(d);
    }
  }
  return STAGES.map((stage) => ({ stage, median: median(days.get(stage)!), samples: days.get(stage)!.length }));
}
