// Use-cases. A service is where "what the app does" is decided: it applies
// domain rules, asks the repository (through its port) to persist, and returns
// domain objects. It knows nothing about HTTP or SQL — so the same service can
// back a web API, a CSV importer or a command-line tool.
//
// Dependencies arrive as arguments (the repository, a clock) rather than being
// imported. That one habit is what makes this layer testable: a test hands in
// an in-memory database and a frozen clock.

import { dedupeKey, parseApplicationPatch, parseBulkEdit, parseBulkStatusChange, parseApplicationQuery, parseNewApplication, parseStatusChange } from "../domain/application.ts";
import type { Application, StatusEvent } from "../domain/application.ts";
import { toIsoDate } from "../domain/dates.ts";
import { DuplicateError, InvalidTransitionError, NotFoundError, ValidationError } from "../domain/errors.ts";
import type { ApplicationRepository } from "../domain/ports.ts";
import { canTransition, nextStatuses } from "../domain/status.ts";

export type Clock = () => Date;

export interface ApplicationService {
  add(userId: number, raw: unknown): Application;
  get(userId: number, id: number): { application: Application; events: StatusEvent[]; nextStatuses: readonly string[] };
  list(userId: number, rawQuery: Record<string, unknown>): Application[];
  edit(userId: number, id: number, raw: unknown): Application;
  changeStatus(userId: number, id: number, raw: unknown): Application;
  undoStatusChange(userId: number, id: number): Application;
  archive(userId: number, id: number): void;
  /** Moves many applications to one status. Refuses unless EVERY one may legally make that move; then changes all or none. */
  changeStatusMany(userId: number, raw: unknown): { updated: number; applications: Application[] };
  /** Changes the same safe fields on many applications, all or nothing. */
  editMany(userId: number, raw: unknown): { updated: number; applications: Application[] };
}

export function createApplicationService(deps: { repo: ApplicationRepository; clock: Clock }): ApplicationService {
  const { repo, clock } = deps;
  const now = () => clock().toISOString();
  const today = () => toIsoDate(clock());

  const mustFind = (userId: number, id: number): Application => {
    const app = repo.findById(userId, id);
    if (!app) throw new NotFoundError("application");
    return app;
  };

  return {
    add(userId, raw) {
      const input = parseNewApplication(raw, today());
      const key = dedupeKey(input.fields);
      const existing = repo.findByDedupeKey(userId, key);
      if (existing) throw new DuplicateError(existing.id);
      return repo.insert(userId, input, key, now());
    },

    get(userId, id) {
      const application = mustFind(userId, id);
      return { application, events: repo.events(userId, id), nextStatuses: nextStatuses(application.status) };
    },

    list(userId, rawQuery) {
      return repo.list(userId, parseApplicationQuery(rawQuery));
    },

    edit(userId, id, raw) {
      const patch = parseApplicationPatch(raw);
      const current = mustFind(userId, id);
      // only re-check for a duplicate when the fields that define identity actually changed
      let newKey: string | null = null;
      if ("company" in patch || "roleTitle" in patch || "term" in patch) {
        const merged = { company: patch.company ?? current.company, roleTitle: patch.roleTitle ?? current.roleTitle, term: "term" in patch ? (patch.term ?? null) : current.term };
        const key = dedupeKey(merged);
        if (key !== dedupeKey(current)) {
          const clash = repo.findByDedupeKey(userId, key);
          if (clash && clash.id !== id) throw new DuplicateError(clash.id);
          newKey = key;
        }
      }
      return repo.update(userId, id, patch, newKey, now()) as Application;
    },

    changeStatus(userId, id, raw) {
      const change = parseStatusChange(raw, today());
      const current = mustFind(userId, id);
      if (!canTransition(current.status, change.status)) {
        throw new InvalidTransitionError(current.status, change.status, nextStatuses(current.status));
      }
      return repo.addStatusChange(userId, id, change, now()) as Application;
    },

    undoStatusChange(userId, id) {
      mustFind(userId, id);
      if (repo.events(userId, id).length <= 1) {
        throw new ValidationError([{ field: "status", message: "nothing to undo — this is the first status" }]);
      }
      return repo.undoLastStatusChange(userId, id, now()) as Application;
    },

    archive(userId, id) {
      mustFind(userId, id);
      repo.archive(userId, id, now());
    },

    changeStatusMany(userId, raw) {
      const { ids, change } = parseBulkStatusChange(raw, today());
      const current = ids.map((id) => ({ id, app: repo.findById(userId, id) }));
      const missing = current.filter((c) => !c.app).map((c) => c.id);
      if (missing.length) throw new NotFoundError(`application(s) ${missing.join(", ")}`);
      // all-or-nothing: if even one can't legally make this move, say which, and change nothing
      const blocked = current.filter((c) => !canTransition((c.app as Application).status, change.status));
      if (blocked.length) {
        throw new ValidationError([
          { field: "ids", message: `cannot move to "${change.status}" from their current status: ${blocked.map((c) => `#${c.id} (${(c.app as Application).status})`).join(", ")}` },
        ]);
      }
      const applications = repo.addStatusChangeMany(userId, ids, change, now());
      return { updated: applications.length, applications };
    },

    editMany(userId, raw) {
      const { ids, set } = parseBulkEdit(raw);
      // all or nothing: if any id isn't yours (or doesn't exist), nothing is changed
      const missing = ids.filter((id) => !repo.findById(userId, id));
      if (missing.length) throw new NotFoundError(`application(s) ${missing.join(", ")}`);
      const updated = repo.updateMany(userId, ids, set, now());
      return { updated, applications: ids.map((id) => repo.findById(userId, id) as Application) };
    },
  };
}
