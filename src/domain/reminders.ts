// What needs your attention today. Pure: give it rows and today's date.
//
// Three kinds of reminder:
//   followUps   you set a follow-up date and it is due (or overdue)
//   deadlines   a deadline is coming up for something you haven't submitted
//   stale       applied/in-progress and nothing has happened for a while, with no
//               follow-up date set: probably time to follow up, or mark it ghosted

import type { Application } from "./application.ts";
import { addDays, daysBetween } from "./dates.ts";
import type { ExportedApplication } from "./export.ts";
import { isClosed } from "./status.ts";

export interface RemindersOptions {
  /** Look this many days ahead for follow-ups and deadlines. */
  days: number;
  /** Days of silence before an application counts as stale. */
  staleDays: number;
}

export const DEFAULT_REMINDERS: RemindersOptions = { days: 7, staleDays: 21 };

export interface Reminders {
  today: string;
  followUps: { application: Application; dueOn: string; daysOverdue: number }[];
  deadlines: { application: Application; deadlineOn: string; daysLeft: number; missed: boolean }[];
  stale: { application: Application; lastChangeOn: string; daysSince: number }[];
}

const IN_FLIGHT = new Set(["applied", "assessment", "interview"]);
const MISSED_GRACE_DAYS = 7; // a deadline that passed this long ago is old news, not a reminder

export function computeReminders(rows: ExportedApplication[], today: string, opts: RemindersOptions = DEFAULT_REMINDERS): Reminders {
  const horizon = addDays(today, opts.days);
  const out: Reminders = { today, followUps: [], deadlines: [], stale: [] };

  for (const { application: a, history } of rows) {
    if (a.archivedAt || isClosed(a.status)) continue;

    if (a.followUpOn && a.followUpOn <= horizon) {
      out.followUps.push({ application: a, dueOn: a.followUpOn, daysOverdue: daysBetween(a.followUpOn, today) });
    }

    if (a.deadlineOn && (a.status === "saved" || a.status === "drafting")) {
      const daysLeft = daysBetween(today, a.deadlineOn);
      if (daysLeft <= opts.days && daysLeft >= -MISSED_GRACE_DAYS) out.deadlines.push({ application: a, deadlineOn: a.deadlineOn, daysLeft, missed: daysLeft < 0 });
    }

    if (IN_FLIGHT.has(a.status) && !a.followUpOn && history.length) {
      const last = history[history.length - 1]!.occurredOn; // newest by insertion order, which is what "latest" means here
      const daysSince = daysBetween(last, today);
      if (daysSince >= opts.staleDays) out.stale.push({ application: a, lastChangeOn: last, daysSince });
    }
  }

  out.followUps.sort((x, y) => x.dueOn.localeCompare(y.dueOn));
  out.deadlines.sort((x, y) => x.deadlineOn.localeCompare(y.deadlineOn));
  out.stale.sort((x, y) => y.daysSince - x.daysSince);
  return out;
}
