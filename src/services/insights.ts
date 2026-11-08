// Read-only questions about your search: how is it going, and what needs
// attention. Both can be scoped to a saved list, or narrowed with the same
// filters the application list takes.

import { parseApplicationQuery } from "../domain/application.ts";
import type { Application, ApplicationQuery } from "../domain/application.ts";
import { toIsoDate } from "../domain/dates.ts";
import { NotFoundError, ValidationError } from "../domain/errors.ts";
import { narrowQuery } from "../domain/list.ts";
import type { ApplicationRepository, ListRepository } from "../domain/ports.ts";
import { computeReminders, DEFAULT_REMINDERS } from "../domain/reminders.ts";
import type { Reminders } from "../domain/reminders.ts";
import { computeProgress } from "../domain/progress.ts";
import type { Progress } from "../domain/progress.ts";
import { computeStats } from "../domain/stats.ts";
import type { Stats } from "../domain/stats.ts";
import type { Clock } from "./applications.ts";

export interface InsightsService {
  stats(userId: number, raw: Record<string, unknown>): { scope: { list: { id: number; name: string } | null }; stats: Stats };
  reminders(userId: number, raw: Record<string, unknown>): { scope: { list: { id: number; name: string } | null }; reminders: Reminders };
  /** The table: each application with how far it got, newest activity first. Same scoping and filters as stats. */
  pipeline(userId: number, raw: Record<string, unknown>): { scope: { list: { id: number; name: string } | null }; rows: { application: Application; progress: Progress }[] };
}

export function createInsightsService(deps: { applications: ApplicationRepository; lists: ListRepository; clock: Clock }): InsightsService {
  const { applications, lists, clock } = deps;

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

    pipeline(userId, raw) {
      const { query, list } = scope(userId, raw);
      const rows = (query ? applications.withHistory(userId, query) : [])
        .map(({ application, history }) => ({ application, progress: computeProgress(history, application.status) }))
        .sort((a, b) => b.application.updatedAt.localeCompare(a.application.updatedAt) || b.application.id - a.application.id);
      return { scope: { list }, rows };
    },

    reminders(userId, raw) {
      const days = wholeNumber(raw.days, "days", DEFAULT_REMINDERS.days, 365);
      const staleDays = wholeNumber(raw.staleDays, "staleDays", DEFAULT_REMINDERS.staleDays, 365);
      const { query, list } = scope(userId, raw);
      const rows = query ? applications.withHistory(userId, query) : [];
      return { scope: { list }, reminders: computeReminders(rows, toIsoDate(clock()), { days, staleDays }) };
    },
  };
}
