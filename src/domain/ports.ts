// A "port": what the application needs from storage, described in the
// application's own terms. The domain and services depend on THIS interface;
// repositories/ provides the SQLite implementation. So the arrow points
// inward — storage depends on the domain, never the reverse — and a test can
// swap in anything that satisfies the interface.

import type { Application, ApplicationFields, ApplicationPatch, ApplicationQuery, NewApplication, StatusChange, StatusEvent } from "./application.ts";
import type { ExportedApplication } from "./export.ts";
import type { ListFilter, ListPatch, NewList, SavedList } from "./list.ts";

export interface ApplicationRepository {
  /** Inserts the application and its first status event atomically. */
  insert(userId: number, app: NewApplication, dedupeKey: string, now: string): Application;
  findById(userId: number, id: number): Application | null;
  findByDedupeKey(userId: number, key: string): Application | null;
  list(userId: number, query: ApplicationQuery): Application[];
  /** How many applications match — uncapped, unlike list(). */
  count(userId: number, query: ApplicationQuery): number;
  update(userId: number, id: number, patch: ApplicationPatch, dedupeKey: string | null, now: string): Application | null;
  /** Records the event AND updates the application's cached status, atomically. */
  addStatusChange(userId: number, id: number, change: StatusChange, now: string): Application | null;
  /** Removes the newest event and restores the previous status, atomically. */
  undoLastStatusChange(userId: number, id: number, now: string): Application | null;
  events(userId: number, id: number): StatusEvent[];
  archive(userId: number, id: number, now: string): boolean;
  /** Every application INCLUDING archived ones, each with its history, with no row cap. For exports. */
  exportAll(userId: number): ExportedApplication[];
  /** Applications matching the query, each with its history, with no row cap. For stats and reminders. */
  withHistory(userId: number, query: ApplicationQuery): ExportedApplication[];
  /** Your distinct company names with how many (non-archived) applications use each. */
  companyNames(userId: number): { name: string; count: number }[];
  /** One atomic statement: changes the same fields on every listed application. Returns how many changed. */
  updateMany(userId: number, ids: number[], patch: ApplicationPatch, now: string): number;
}

export interface ListRepository {
  insert(userId: number, list: NewList, now: string): SavedList;
  findById(userId: number, id: number): SavedList | null;
  /** Case-insensitive, matching the table's unique index. */
  findByName(userId: number, name: string): SavedList | null;
  all(userId: number): SavedList[];
  update(userId: number, id: number, patch: ListPatch, now: string): SavedList | null;
  remove(userId: number, id: number): boolean;
}

/** Companies that post internships — a source of names for the search box. */
export interface CompanyDirectory {
  names(): Promise<{ names: string[]; available: boolean; note?: string }>;
}

/** Remembers which source row became which application, so importing twice never duplicates. */
export interface ImportLedger {
  /** externalId -> application id, for everything already imported from this source. */
  known(userId: number, source: string): Map<string, number>;
  record(userId: number, source: string, externalId: string, applicationId: number, now: string): void;
}

export type { ApplicationFields, ListFilter };
