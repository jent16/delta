// A "port": what the application needs from storage, described in the
// application's own terms. The domain and services depend on THIS interface;
// repositories/ provides the SQLite implementation. So the arrow points
// inward — storage depends on the domain, never the reverse — and a test can
// swap in anything that satisfies the interface.

import type { Application, ApplicationFields, ApplicationPatch, ApplicationQuery, NewApplication, StatusChange, StatusEvent } from "./application.ts";

export interface ApplicationRepository {
  /** Inserts the application and its first status event atomically. */
  insert(userId: number, app: NewApplication, dedupeKey: string, now: string): Application;
  findById(userId: number, id: number): Application | null;
  findByDedupeKey(userId: number, key: string): Application | null;
  list(userId: number, query: ApplicationQuery): Application[];
  update(userId: number, id: number, patch: ApplicationPatch, dedupeKey: string | null, now: string): Application | null;
  /** Records the event AND updates the application's cached status, atomically. */
  addStatusChange(userId: number, id: number, change: StatusChange, now: string): Application | null;
  /** Removes the newest event and restores the previous status, atomically. */
  undoLastStatusChange(userId: number, id: number, now: string): Application | null;
  events(userId: number, id: number): StatusEvent[];
  archive(userId: number, id: number, now: string): boolean;
}

export type { ApplicationFields };
