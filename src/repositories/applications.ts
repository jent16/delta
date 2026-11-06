// The ONLY place SQL for applications lives. Everything above this layer
// talks in domain objects (camelCase, typed unions); everything below is rows
// (snake_case, strings). Translating between the two happens here and
// nowhere else, so a column rename touches one file.

import type { Application, ApplicationPatch, ApplicationQuery, NewApplication, StatusChange, StatusEvent } from "../domain/application.ts";
import type { ApplicationRepository } from "../domain/ports.ts";
import type { Db } from "../db/connection.ts";
import type { ExportedApplication } from "../domain/export.ts";
import type { RoleFunction, Sector } from "../domain/vocab.ts";
import type { Status } from "../domain/status.ts";

interface AppRow {
  id: number;
  user_id: number;
  company: string;
  role_title: string;
  role_function: string;
  sector: string | null;
  location: string | null;
  term: string | null;
  url: string | null;
  source: string | null;
  applied_on: string | null;
  deadline_on: string | null;
  follow_up_on: string | null;
  resume_version: string | null;
  compensation: string | null;
  notes: string;
  status: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id: number;
  application_id: number;
  status: string;
  occurred_on: string;
  note: string | null;
  created_at: string;
}

const toApplication = (r: AppRow): Application => ({
  id: r.id,
  userId: r.user_id,
  company: r.company,
  roleTitle: r.role_title,
  roleFunction: r.role_function as RoleFunction,
  sector: r.sector as Sector | null,
  location: r.location,
  term: r.term,
  url: r.url,
  source: r.source,
  appliedOn: r.applied_on,
  deadlineOn: r.deadline_on,
  followUpOn: r.follow_up_on,
  resumeVersion: r.resume_version,
  compensation: r.compensation,
  notes: r.notes,
  status: r.status as Status,
  archivedAt: r.archived_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toEvent = (r: EventRow): StatusEvent => ({
  id: r.id,
  applicationId: r.application_id,
  status: r.status as Status,
  occurredOn: r.occurred_on,
  note: r.note,
  createdAt: r.created_at,
});

// Column names come from this fixed map, never from request data, so building
// an UPDATE from a patch can't be steered into arbitrary SQL.
const PATCH_COLUMNS: Record<keyof ApplicationPatch, string> = {
  company: "company",
  roleTitle: "role_title",
  roleFunction: "role_function",
  sector: "sector",
  location: "location",
  term: "term",
  url: "url",
  source: "source",
  appliedOn: "applied_on",
  deadlineOn: "deadline_on",
  followUpOn: "follow_up_on",
  resumeVersion: "resume_version",
  compensation: "compensation",
  notes: "notes",
};

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const MAX_ROWS = 500;

// One place that turns a query into SQL, shared by list() and count() so a
// list's number can never disagree with the rows it shows.
function whereClause(userId: number, query: ApplicationQuery): { sql: string; params: (string | number)[] } {
  const where: string[] = ["user_id = ?"];
  const params: (string | number)[] = [userId];
  if (!query.includeArchived) where.push("archived_at IS NULL");
  const anyOf = (column: string, values: readonly string[] | undefined) => {
    if (!values?.length) return;
    where.push(`${column} IN (${values.map(() => "?").join(", ")})`);
    params.push(...values);
  };
  anyOf("status", query.statuses);
  anyOf("role_function", query.roleFunctions);
  anyOf("sector", query.sectors);
  // closed list in the domain (parseApplicationQuery), mapped to column names here — never request text in SQL
  const MISSING_COLUMNS = { sector: "sector", term: "term", location: "location", url: "url" } as const;
  for (const field of query.missing ?? []) where.push(`${MISSING_COLUMNS[field]} IS NULL`);
  if (query.q) {
    const like = `%${escapeLike(query.q)}%`;
    where.push("(company LIKE ? ESCAPE '\\' OR role_title LIKE ? ESCAPE '\\' OR location LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\')");
    params.push(like, like, like, like);
  }
  return { sql: where.join(" AND "), params };
}

export function createApplicationRepository(db: Db): ApplicationRepository {
  const selectOne = db.prepare("SELECT * FROM applications WHERE id = ? AND user_id = ?");

  const findById = (userId: number, id: number): Application | null => {
    const row = selectOne.get(id, userId) as AppRow | undefined;
    return row ? toApplication(row) : null;
  };

  const withHistory = (userId: number, query: ApplicationQuery): ExportedApplication[] => {
    const { sql, params } = whereClause(userId, query);
    const apps = (db.prepare(`SELECT * FROM applications WHERE ${sql} ORDER BY id`).all(...params) as AppRow[]).map(toApplication);
    // one query for the user's events, grouped in memory, instead of one query per application
    const events = db
      .prepare("SELECT e.* FROM status_events e JOIN applications a ON a.id = e.application_id WHERE a.user_id = ? ORDER BY e.id")
      .all(userId) as EventRow[];
    const byApp = new Map<number, StatusEvent[]>();
    for (const e of events) {
      const list = byApp.get(e.application_id) ?? [];
      list.push(toEvent(e));
      byApp.set(e.application_id, list);
    }
    return apps.map((application) => ({ application, history: byApp.get(application.id) ?? [] }));
  };

  return {
    findById,

    insert(userId, app, dedupeKey, now) {
      const f = app.fields;
      // Two writes that must succeed or fail together: wrapped in one transaction.
      const id = db.transaction(() => {
        const res = db
          .prepare(
            `INSERT INTO applications (user_id, company, role_title, role_function, sector, location, term, url, source,
               applied_on, deadline_on, follow_up_on, resume_version, compensation, notes, status, dedupe_key, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(userId, f.company, f.roleTitle, f.roleFunction, f.sector, f.location, f.term, f.url, f.source,
            f.appliedOn, f.deadlineOn, f.followUpOn, f.resumeVersion, f.compensation, f.notes, app.status, dedupeKey, now, now);
        const newId = Number(res.lastInsertRowid);
        db.prepare("INSERT INTO status_events (application_id, status, occurred_on, note, created_at) VALUES (?, ?, ?, NULL, ?)").run(
          newId, app.status, app.statusOn, now,
        );
        return newId;
      })();
      return findById(userId, id) as Application;
    },

    findByDedupeKey(userId, key) {
      const row = db
        .prepare("SELECT * FROM applications WHERE user_id = ? AND dedupe_key = ? AND archived_at IS NULL ORDER BY id LIMIT 1")
        .get(userId, key) as AppRow | undefined;
      return row ? toApplication(row) : null;
    },

    list(userId, query: ApplicationQuery) {
      const { sql, params } = whereClause(userId, query);
      const rows = db
        .prepare(`SELECT * FROM applications WHERE ${sql} ORDER BY updated_at DESC, id DESC LIMIT ${MAX_ROWS}`)
        .all(...params) as AppRow[];
      return rows.map(toApplication);
    },

    count(userId, query: ApplicationQuery) {
      const { sql, params } = whereClause(userId, query);
      return (db.prepare(`SELECT COUNT(*) AS n FROM applications WHERE ${sql}`).get(...params) as { n: number }).n;
    },

    update(userId, id, patch, dedupeKey, now) {
      if (!findById(userId, id)) return null;
      const sets: string[] = [];
      const params: (string | number | null)[] = [];
      for (const key of Object.keys(patch) as (keyof ApplicationPatch)[]) {
        sets.push(`${PATCH_COLUMNS[key]} = ?`);
        params.push(patch[key] ?? null);
      }
      if (dedupeKey !== null) {
        sets.push("dedupe_key = ?");
        params.push(dedupeKey);
      }
      sets.push("updated_at = ?");
      params.push(now, id, userId);
      db.prepare(`UPDATE applications SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`).run(...params);
      return findById(userId, id);
    },

    addStatusChange(userId, id, change: StatusChange, now) {
      if (!findById(userId, id)) return null;
      db.transaction(() => {
        db.prepare("INSERT INTO status_events (application_id, status, occurred_on, note, created_at) VALUES (?, ?, ?, ?, ?)").run(
          id, change.status, change.on, change.note, now,
        );
        db.prepare("UPDATE applications SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?").run(change.status, now, id, userId);
      })();
      return findById(userId, id);
    },

    addStatusChangeMany(userId, ids, change, now) {
      db.transaction(() => {
        for (const id of ids) {
          // each id must be this user's; if not, throwing rolls back every change made so far
          if (!findById(userId, id)) throw new Error(`application ${id} not found for this user`);
          db.prepare("INSERT INTO status_events (application_id, status, occurred_on, note, created_at) VALUES (?, ?, ?, ?, ?)").run(
            id, change.status, change.on, change.note, now,
          );
          db.prepare("UPDATE applications SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?").run(change.status, now, id, userId);
        }
      })();
      return ids.map((id) => findById(userId, id) as Application);
    },

    undoLastStatusChange(userId, id, now) {
      if (!findById(userId, id)) return null;
      db.transaction(() => {
        const newest = db.prepare("SELECT id FROM status_events WHERE application_id = ? ORDER BY id DESC LIMIT 1").get(id) as { id: number };
        db.prepare("DELETE FROM status_events WHERE id = ?").run(newest.id);
        const previous = db.prepare("SELECT status FROM status_events WHERE application_id = ? ORDER BY id DESC LIMIT 1").get(id) as { status: string };
        db.prepare("UPDATE applications SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?").run(previous.status, now, id, userId);
      })();
      return findById(userId, id);
    },

    events(userId, id) {
      if (!findById(userId, id)) return [];
      return (db.prepare("SELECT * FROM status_events WHERE application_id = ? ORDER BY id").all(id) as EventRow[]).map(toEvent);
    },

    exportAll(userId) {
      return withHistory(userId, { includeArchived: true });
    },

    withHistory(userId, query) {
      return withHistory(userId, query);
    },

    companyNames(userId) {
      return db
        .prepare("SELECT MIN(company) AS name, COUNT(*) AS count FROM applications WHERE user_id = ? AND archived_at IS NULL GROUP BY LOWER(TRIM(company)) ORDER BY count DESC, name")
        .all(userId) as { name: string; count: number }[];
    },

    updateMany(userId, ids, patch, now) {
      const sets: string[] = [];
      const params: (string | number | null)[] = [];
      for (const [key, value] of Object.entries(patch) as [keyof ApplicationPatch, string | null][]) {
        sets.push(`${PATCH_COLUMNS[key]} = ?`); // column names come from the fixed PATCH_COLUMNS map, never from the request
        params.push(value);
      }
      if (!sets.length || !ids.length) return 0;
      sets.push("updated_at = ?");
      params.push(now, userId, ...ids);
      return db.prepare(`UPDATE applications SET ${sets.join(", ")} WHERE user_id = ? AND id IN (${ids.map(() => "?").join(", ")})`).run(...params).changes;
    },

    archive(userId, id, now) {
      const res = db.prepare("UPDATE applications SET archived_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND archived_at IS NULL").run(now, now, id, userId);
      return res.changes > 0;
    },
  };
}
