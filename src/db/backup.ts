// Backups of the tracker database, and restoring from one.
//
// Why VACUUM INTO and not copying the file: the database runs in WAL mode, so
// recent changes can sit in a separate "-wal" file. A plain file copy can miss
// them or catch a write half-done and produce a backup that won't open.
// VACUUM INTO asks SQLite itself for a consistent, compact snapshot, and does
// so safely while the server is running.
//
// A backup nobody has checked is a hope, not a backup, so every one is opened
// and compared against the live data before it is reported as done.

import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Db } from "./connection.ts";
import { knownMigrationVersions } from "./migrate.ts";

export interface BackupInfo {
  file: string;
  name: string;
  bytes: number;
  applications: number;
  statusEvents: number;
}

export interface BackupFile {
  file: string;
  name: string;
  bytes: number;
  createdAt: Date;
  /** "auto"/"manual" backups are pruned; labelled ones (pre-migration, pre-import, pre-restore) never are. */
  labelled: boolean;
}

// tracker-20261105-143000.db            (regular: pruned to the newest N)
// tracker-pre-import-20261105-143000.db (labelled: kept until you delete it)
const NAME = /^tracker-(?:([a-z0-9-]+?)-)?(\d{8})-(\d{6})(?:-\d+)?\.db$/;

const stamp = (d: Date): string => d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const parseStamp = (date: string, time: string): Date =>
  new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}Z`);

interface Summary {
  ok: boolean;
  problem?: string;
  applications: number;
  statusEvents: number;
  versions: string[];
}

/** Opens a database file read-only and checks it is intact and really is a tracker database. */
export function inspectDatabase(file: string): Summary {
  const empty = { applications: 0, statusEvents: 0, versions: [] as string[] };
  let db: Database.Database | undefined;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const integrity = db.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") return { ok: false, problem: `integrity check failed: ${String(integrity)}`, ...empty };
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));
    for (const t of ["applications", "status_events", "schema_migrations"]) {
      if (!tables.has(t)) return { ok: false, problem: `not a Delta tracker database (no "${t}" table)`, ...empty };
    }
    const count = (t: string) => (db!.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    const versions = (db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: string }[]).map((r) => r.version);
    return { ok: true, applications: count("applications"), statusEvents: count("status_events"), versions };
  } catch (e) {
    return { ok: false, problem: e instanceof Error ? e.message : "cannot open", ...empty };
  } finally {
    db?.close();
  }
}

/**
 * Writes a verified snapshot of `db` into `dir`. Throws (and removes the file)
 * if the copy doesn't open or doesn't contain what the live database does.
 */
export function createBackup(db: Db, dir: string, opts: { label?: string; now?: Date } = {}): BackupInfo {
  mkdirSync(dir, { recursive: true });
  const base = `tracker-${opts.label ? `${opts.label}-` : ""}${stamp(opts.now ?? new Date())}`;
  let file = join(dir, `${base}.db`);
  for (let n = 2; existsSync(file); n++) file = join(dir, `${base}-${n}.db`); // two in the same second
  db.prepare("VACUUM INTO ?").run(file);

  const live = {
    applications: (db.prepare("SELECT COUNT(*) AS n FROM applications").get() as { n: number }).n,
    statusEvents: (db.prepare("SELECT COUNT(*) AS n FROM status_events").get() as { n: number }).n,
  };
  const check = inspectDatabase(file);
  if (!check.ok || check.applications !== live.applications || check.statusEvents !== live.statusEvents) {
    rmSync(file, { force: true });
    throw new Error(`backup failed verification (${check.problem ?? `expected ${live.applications}/${live.statusEvents} rows, copy has ${check.applications}/${check.statusEvents}`}); it was discarded`);
  }
  return { file, name: basename(file), bytes: statSync(file).size, ...live };
}

/** Backups in `dir`, newest first. Files that don't look like ours are ignored. */
export function listBackups(dir: string): BackupFile[] {
  if (!existsSync(dir)) return [];
  const out: BackupFile[] = [];
  for (const name of readdirSync(dir)) {
    const m = NAME.exec(name);
    if (!m) continue;
    out.push({ file: join(dir, name), name, bytes: statSync(join(dir, name)).size, createdAt: parseStamp(m[2]!, m[3]!), labelled: m[1] !== undefined });
  }
  return out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.name.localeCompare(a.name));
}

/** Deletes regular backups beyond the newest `keep`. Labelled backups are never touched. Returns what it removed. */
export function pruneBackups(dir: string, keep: number): string[] {
  const removable = listBackups(dir).filter((b) => !b.labelled).slice(keep);
  for (const b of removable) rmSync(b.file, { force: true });
  return removable.map((b) => b.name);
}

/** Takes a regular backup if the newest one is older than `maxAgeHours` (or there is none). */
export function backupIfStale(db: Db, dir: string, opts: { maxAgeHours: number; keep: number; now?: Date }): BackupInfo | null {
  const now = opts.now ?? new Date();
  const newest = listBackups(dir).find((b) => !b.labelled);
  if (newest && now.getTime() - newest.createdAt.getTime() < opts.maxAgeHours * 3_600_000) return null;
  const info = createBackup(db, dir, { now });
  pruneBackups(dir, opts.keep);
  return info;
}

export interface RestoreResult {
  restoredFrom: string;
  /** Where the database you had before the restore was saved. Null if there was none. */
  safetyCopy: string | null;
  applications: number;
  statusEvents: number;
}

/**
 * Replaces `targetFile` with a backup. Refuses rather than guesses:
 *  - the backup must open, pass the integrity check and look like a tracker database
 *  - it must not come from a NEWER version of the code than this one
 *  - the server must not be running. A running server keeps writing to the file
 *    it already opened, which this replaces, and those writes would be lost
 *    silently. An open WAL-mode database leaves "-wal"/"-shm" files beside it,
 *    so their presence is treated as "in use" (a false alarm after a crash is
 *    safe; pass `force` once you know nothing is running).
 */
export function restoreBackup(opts: { backupFile: string; targetFile: string; safetyDir: string; now?: Date; force?: boolean }): RestoreResult {
  const { backupFile, targetFile } = opts;
  const check = inspectDatabase(backupFile);
  if (!check.ok) throw new Error(`cannot restore: ${check.problem}`);
  const known = new Set(knownMigrationVersions());
  const newer = check.versions.filter((v) => !known.has(v));
  if (newer.length) throw new Error(`cannot restore: this backup has schema version(s) ${newer.join(", ")} that this code doesn't know — it was made by a newer Delta`);

  const inUse = [`${targetFile}-wal`, `${targetFile}-shm`].filter((f) => existsSync(f));
  if (inUse.length && !opts.force) {
    throw new Error("cannot restore: the tracker database looks like it is in use (found " + inUse.map((f) => basename(f)).join(", ") + "). Stop `npm run tracker` first, then try again");
  }

  let safetyCopy: string | null = null;
  if (existsSync(targetFile)) {
    mkdirSync(opts.safetyDir, { recursive: true });
    const safety = join(opts.safetyDir, `tracker-pre-restore-${stamp(opts.now ?? new Date())}.db`);
    let n = 2;
    let dest = safety;
    while (existsSync(dest)) dest = safety.replace(/\.db$/, `-${n++}.db`);
    // a snapshot if it opens; a raw file copy if it is too damaged to open (that is probably why you're restoring)
    try {
      const live = new Database(targetFile, { fileMustExist: true });
      try { live.prepare("VACUUM INTO ?").run(dest); } finally { live.close(); }
    } catch {
      copyFileSync(targetFile, dest);
    }
    safetyCopy = dest;
  }

  // copy beside the target, then rename: the target is never left half-written
  mkdirSync(dirname(targetFile), { recursive: true });
  const temp = `${targetFile}.restoring`;
  copyFileSync(backupFile, temp);
  renameSync(temp, targetFile);
  for (const f of [`${targetFile}-wal`, `${targetFile}-shm`]) rmSync(f, { force: true }); // stale files from the replaced database
  return { restoredFrom: backupFile, safetyCopy, applications: check.applications, statusEvents: check.statusEvents };
}
