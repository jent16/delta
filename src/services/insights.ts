// Read-only questions about your search: how is it going, and what needs
// attention. Both can be scoped to a saved list, or narrowed with the same
// filters the application list takes.

import { parseApplicationQuery } from "../domain/application.ts";
import type { Application, ApplicationQuery } from "../domain/application.ts";
import type { Contact } from "../domain/contact.ts";
import { addDays, daysBetween, toIsoDate } from "../domain/dates.ts";
import { NotFoundError, ValidationError } from "../domain/errors.ts";
import { narrowQuery } from "../domain/list.ts";
import type { ApplicationRepository, ContactRepository, ListRepository } from "../domain/ports.ts";
import { computeReminders, DEFAULT_REMINDERS } from "../domain/reminders.ts";
import type { Reminders } from "../domain/reminders.ts";
import { computeBreakdowns, computeTimeInStage, MIN_SAMPLE } from "../domain/breakdowns.ts";
import type { BreakdownRow, Dimension, StageTime } from "../domain/breakdowns.ts";
import { computeProgress, historyDates } from "../domain/progress.ts";
import type { Progress } from "../domain/progress.ts";
import { computeStats } from "../domain/stats.ts";
import type { Stats } from "../domain/stats.ts";
import type { Clock } from "./applications.ts";

export interface PipelineRow {
  application: Application;
  progress: Progress;
  /** When it was first marked applied (falls back to the application's own applied date), or null if never sent. */
  appliedOn: string | null;
  /** The date of the newest status event. */
  lastChangeOn: string | null;
}

/** The application reminders, plus the people you meant to follow up with (not tied to any list, so only when unscoped). */
export type RemindersWithPeople = Reminders & { contactFollowUps: { contact: Contact; dueOn: string; daysOverdue: number }[] };

export interface InsightsService {
  stats(userId: number, raw: Record<string, unknown>): { scope: { list: { id: number; name: string } | null }; stats: Stats };
  reminders(userId: number, raw: Record<string, unknown>): { scope: { list: { id: number; name: string } | null }; reminders: RemindersWithPeople };
  /** Where replies come from (by function, sector, source, resume version) and how long each stage takes. Same scoping as stats. */
  breakdowns(userId: number, raw: Record<string, unknown>): { scope: { list: { id: number; name: string } | null }; minSample: number; breakdowns: Record<Dimension, BreakdownRow[]>; timeInStage: StageTime[] };
  /** The table: each application with how far it got and its key dates, most recent activity first. Same scoping and filters as stats. */
  pipeline(userId: number, raw: Record<string, unknown>): { scope: { list: { id: number; name: string } | null }; rows: PipelineRow[] };
}

export function createInsightsService(deps: { applications: ApplicationRepository; lists: ListRepository; contacts: ContactRepository; clock: Clock }): InsightsService {
  const { applications, lists, contacts, clock } = deps;

  // `list=<id>` scopes to a saved list; the other parameters narrow within it.
  function scope(userId: number, raw: Record<string, unknown>): { query: ApplicationQuery | null; list: { id: number; name: string } | null } {
    const query = parseApplicationQuery(raw);
    if (raw.list === undefined || raw.list === "") return { query, list: null };
    const id = Number(raw.list);
    if (!Number.isInteger(id) || id < 1) throw new ValidationError([{ field: "list", message: "must be a list id" }]);
    const list = lists.findById(userId, id);
    if (!list) throw new NotFoundError("list");
    return { query: narrowQuery(list.filter, query), list: { id: list.id, name: list.name } };
  }

  const wholeNumber = (raw: unknown, field: string, fallback: number, max: number): number => {
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > max) throw new ValidationError([{ field, message: `must be a whole number from 0 to ${max}` }]);
    return n;
  };

  return {
    stats(userId, raw) {
      const { query, list } = scope(userId, raw);
      return { scope: { list }, stats: computeStats(query ? applications.withHistory(userId, query) : []) };
    },

    breakdowns(userId, raw) {
      const { query, list } = scope(userId, raw);
      const rows = query ? applications.withHistory(userId, query) : [];
      return { scope: { list }, minSample: MIN_SAMPLE, breakdowns: computeBreakdowns(rows), timeInStage: computeTimeInStage(rows) };
    },

    pipeline(userId, raw) {
      const { query, list } = scope(userId, raw);
      const rows = (query ? applications.withHistory(userId, query) : [])
        .map(({ application, history }): PipelineRow => {
          const { firstAppliedOn, lastChangeOn } = historyDates(history);
          return { application, progress: computeProgress(history, application.status), appliedOn: application.appliedOn ?? firstAppliedOn, lastChangeOn };
        })
        // most recent activity first; rows with no activity date last; ties by when they were touched, then id, so the table never shuffles
        .sort((a, b) => (b.lastChangeOn ?? "").localeCompare(a.lastChangeOn ?? "") || b.application.updatedAt.localeCompare(a.application.updatedAt) || b.application.id - a.application.id);
      return { scope: { list }, rows };
    },

    reminders(userId, raw) {
      const days = wholeNumber(raw.days, "days", DEFAULT_REMINDERS.days, 365);
      const staleDays = wholeNumber(raw.staleDays, "staleDays", DEFAULT_REMINDERS.staleDays, 365);
      const { query, list } = scope(userId, raw);
      const rows = query ? applications.withHistory(userId, query) : [];
      const today = toIsoDate(clock());
      // people are not in any saved list, so they appear only when you are not looking at one
      const people = list ? [] : contacts.list(userId, { dueBy: addDays(today, days) });
      const contactFollowUps = people.filter((c) => c.followUpOn).map((c) => ({ contact: c as Contact, dueOn: c.followUpOn as string, daysOverdue: daysBetween(c.followUpOn as string, today) }))
        .sort((a, b) => b.daysOverdue - a.daysOverdue || a.contact.name.localeCompare(b.contact.name));
      return { scope: { list }, reminders: { ...computeReminders(rows, today, { days, staleDays }), contactFollowUps } };
    },
  };
}
