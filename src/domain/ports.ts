// A "port": what the application needs from storage, described in the
// application's own terms. The domain and services depend on THIS interface;
// repositories/ provides the SQLite implementation. So the arrow points
// inward — storage depends on the domain, never the reverse — and a test can
// swap in anything that satisfies the interface.

import type { Application, ApplicationFields, ApplicationPatch, ApplicationQuery, NewApplication, StatusChange, StatusEvent } from "./application.ts";
import type { CompanySummary } from "./company-record.ts";
import type { Contact, ContactEvent, ContactFields, ContactPatch, ContactQuery, ContactSummary, LinkedApplication, LinkedContact, LinkRole, NewContactEvent } from "./contact.ts";
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
  /** Records the same status change on every listed application in ONE transaction: all of them or none. */
  addStatusChangeMany(userId: number, ids: number[], change: StatusChange, now: string): Application[];
  /** Removes the newest event and restores the previous status, atomically. */
  undoLastStatusChange(userId: number, id: number, now: string): Application | null;
  events(userId: number, id: number): StatusEvent[];
  archive(userId: number, id: number, now: string): boolean;
  /** Every application INCLUDING archived ones, each with its history, with no row cap. For exports. */
  exportAll(userId: number): ExportedApplication[];
  /** Applications matching the query, each with its history, with no row cap. For stats and reminders. */
  withHistory(userId: number, query: ApplicationQuery): ExportedApplication[];
  /** One atomic statement: changes the same fields on every listed application. Returns how many changed. */
  updateMany(userId: number, ids: number[], patch: ApplicationPatch, now: string): number;
}

/** Companies: the name and sector, stored once; applications point at them. */
export interface CompanyRepository {
  /** All of the user's companies, by name, each with how many applications point at it. */
  all(userId: number): CompanySummary[];
  findById(userId: number, id: number): CompanySummary | null;
  /** The company with this name, matched by identity key (case and spacing don't matter). */
  findByName(userId: number, name: string): CompanySummary | null;
  /** Changes the name (and so the key), and re-derives the duplicate key of every application there. */
  rename(userId: number, id: number, name: string, now: string): CompanySummary | null;
  setSector(userId: number, id: number, sector: string | null, now: string): CompanySummary | null;
  /** Roles that would collide if `fromId`'s applications moved to `intoId` (same role and term already there). */
  mergeConflicts(userId: number, fromId: number, intoId: number): string[];
  /** Moves every application of `fromId` to `intoId` and removes `fromId`, atomically. */
  merge(userId: number, fromId: number, intoId: number, now: string): { company: CompanySummary; moved: number } | null;
}

/** People you know at companies, their links to applications, and the dated log of what you did with them. */
export interface ContactRepository {
  /** Creates the contact (and its company by name, in the same transaction, if one is given). */
  insert(userId: number, fields: ContactFields, now: string): Contact;
  findById(userId: number, id: number): Contact | null;
  list(userId: number, query: ContactQuery): ContactSummary[];
  /** Applies the patch. A `company` name moves the contact to that company (created if new); null clears it. */
  update(userId: number, id: number, patch: ContactPatch, now: string): Contact | null;
  /** Permanently deletes the person, their log and their links. */
  remove(userId: number, id: number): boolean;
  events(userId: number, id: number): ContactEvent[];
  addEvent(userId: number, id: number, event: NewContactEvent, now: string): ContactEvent | null;
  /** Links the person to an application (both must be this user's); linking again changes the role. */
  link(userId: number, contactId: number, applicationId: number, role: LinkRole, now: string): boolean;
  unlink(userId: number, contactId: number, applicationId: number): boolean;
  forApplication(userId: number, applicationId: number): LinkedContact[];
  applicationsOf(userId: number, contactId: number): LinkedApplication[];
  /** Everything for the data export, with each person's log and links. */
  exportAll(userId: number): { contact: Contact; events: ContactEvent[]; links: LinkedApplication[] }[];
}

/** One user's preferences, stored as key/value rows. */
export interface SettingsRepository {
  all(userId: number): Record<string, string>;
  /** A null value removes the row, so the default applies again. */
  set(userId: number, key: string, value: string | null): void;
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
