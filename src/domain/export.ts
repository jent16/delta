// Turning the tracker's data into files you can read elsewhere (a spreadsheet,
// a script, a future you). Pure: no database, no file system.
//
// This is for *reading and moving* data. It is not the backup: a backup is a
// copy of the database itself (db/backup.ts) and is what restore uses.

import type { Application, StatusEvent } from "./application.ts";
import type { SavedList } from "./list.ts";

export interface ExportedApplication {
  application: Application;
  /** Oldest first. */
  history: StatusEvent[];
}

export const EXPORT_VERSION = 1;

export function buildJsonExport(exportedAt: string, rows: ExportedApplication[], lists: SavedList[]) {
  return {
    version: EXPORT_VERSION,
    exportedAt,
    applications: rows.map(({ application: a, history }) => ({
      id: a.id,
      company: a.company,
      roleTitle: a.roleTitle,
      roleFunction: a.roleFunction,
      sector: a.sector,
      location: a.location,
      term: a.term,
      url: a.url,
      source: a.source,
      appliedOn: a.appliedOn,
      deadlineOn: a.deadlineOn,
      followUpOn: a.followUpOn,
      resumeVersion: a.resumeVersion,
      compensation: a.compensation,
      notes: a.notes,
      status: a.status,
      archived: a.archivedAt !== null,
      archivedAt: a.archivedAt,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
      history: history.map((e) => ({ status: e.status, on: e.occurredOn, note: e.note })),
    })),
    lists: lists.map((l) => ({ name: l.name, filter: l.filter })),
  };
}

/**
 * One CSV cell. Quotes when needed, and defuses spreadsheet formulas: a cell
 * starting with = + - @ (or a tab/CR) is run as a formula by Excel and Google
 * Sheets, so text like `=HYPERLINK(...)` pasted into a note would execute when
 * the file is opened. A leading apostrophe makes it plain text.
 */
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const COLUMNS = [
  "id", "company", "role_title", "role_function", "sector", "location", "term", "status", "applied_on", "deadline_on",
  "follow_up_on", "source", "resume_version", "compensation", "url", "notes", "archived", "status_history",
] as const;

export function buildCsvExport(rows: ExportedApplication[]): string {
  const lines = [COLUMNS.join(",")];
  for (const { application: a, history } of rows) {
    const cells = [
      a.id, a.company, a.roleTitle, a.roleFunction, a.sector, a.location, a.term, a.status, a.appliedOn, a.deadlineOn,
      a.followUpOn, a.source, a.resumeVersion, a.compensation, a.url, a.notes, a.archivedAt ? "yes" : "no",
      history.map((e) => `${e.status} ${e.occurredOn}`).join("; "),
    ];
    lines.push(cells.map(csvCell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
