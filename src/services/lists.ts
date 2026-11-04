// Use-cases for saved lists. A list's contents are never stored: asking for a
// list's applications means "run its filter now", so the list is always in
// step with the applications — add, edit or archive one and every list that
// matches it updates with no extra bookkeeping.

import { parseApplicationQuery } from "../domain/application.ts";
import type { Application } from "../domain/application.ts";
import { DuplicateError, NotFoundError } from "../domain/errors.ts";
import { narrowQuery, parseListPatch, parseNewList } from "../domain/list.ts";
import type { SavedList } from "../domain/list.ts";
import type { ApplicationRepository, ListRepository } from "../domain/ports.ts";
import type { Clock } from "./applications.ts";

export type ListWithCount = SavedList & { count: number };

export interface ListService {
  create(userId: number, raw: unknown): ListWithCount;
  all(userId: number): ListWithCount[];
  get(userId: number, id: number): ListWithCount;
  edit(userId: number, id: number, raw: unknown): ListWithCount;
  remove(userId: number, id: number): void;
  /** The list's applications, optionally narrowed by an ad-hoc query (status, q, ...). */
  applications(userId: number, id: number, rawQuery: Record<string, unknown>): { list: ListWithCount; applications: Application[] };
}

export function createListService(deps: { lists: ListRepository; applications: ApplicationRepository; clock: Clock }): ListService {
  const { lists, applications, clock } = deps;
  const now = () => clock().toISOString();

  const mustFind = (userId: number, id: number): SavedList => {
    const list = lists.findById(userId, id);
    if (!list) throw new NotFoundError("list");
    return list;
  };
  const withCount = (userId: number, list: SavedList): ListWithCount => ({ ...list, count: applications.count(userId, list.filter) });

  return {
    create(userId, raw) {
      const input = parseNewList(raw);
      const clash = lists.findByName(userId, input.name);
      if (clash) throw new DuplicateError(clash.id, "list");
      return withCount(userId, lists.insert(userId, input, now()));
    },

    all(userId) {
      return lists.all(userId).map((l) => withCount(userId, l));
    },

    get(userId, id) {
      return withCount(userId, mustFind(userId, id));
    },

    edit(userId, id, raw) {
      const patch = parseListPatch(raw);
      mustFind(userId, id);
      if (patch.name !== undefined) {
        const clash = lists.findByName(userId, patch.name);
        if (clash && clash.id !== id) throw new DuplicateError(clash.id, "list"); // renaming "swe" to "SWE" is fine
      }
      return withCount(userId, lists.update(userId, id, patch, now()) as SavedList);
    },

    remove(userId, id) {
      mustFind(userId, id);
      lists.remove(userId, id);
    },

    applications(userId, id, rawQuery) {
      const list = withCount(userId, mustFind(userId, id));
      const narrowed = narrowQuery(list.filter, parseApplicationQuery(rawQuery));
      // null = the narrowing contradicts the list; return nothing rather than everything
      return { list, applications: narrowed ? applications.list(userId, narrowed) : [] };
    },
  };
}
