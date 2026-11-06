// Versioned schema migrations.
//
// Why this exists: the old Delta database could be thrown away and rebuilt
// from CSVs, so "delete delta.db when the schema changes" was acceptable.
// A tracker's database is the ONLY copy of your applications, so schema
// changes must be applied in place, in order, exactly once.
//
// The contract:
//   - migrations are numbered files (0001_name.sql, 0002_name.sql, ...)
//   - each runs inside a transaction together with its bookkeeping row, so a
//     failure leaves the database exactly as it was
//   - an applied migration's file is NEVER edited; fix mistakes with a new
//     migration. A checksum makes an accidental edit loud instead of silent.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./connection.ts";

export const DEFAULT_MIGRATIONS_DIR = new URL("./migrations/", import.meta.url).pathname;

interface MigrationFile {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

function loadMigrations(dir: string): MigrationFile[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const seen = new Set<string>();
  return files.map((file) => {
    const m = /^(\d{4})_([a-z0-9_]+)\.sql$/.exec(file);
    if (!m) throw new Error(`bad migration filename "${file}" (expected 0001_some_name.sql)`);
    const [, version, name] = m as unknown as [string, string, string];
    if (seen.has(version)) throw new Error(`two migrations share version ${version}`);
    seen.add(version);
    const sql = readFileSync(join(dir, file), "utf8");
    return { version, name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
  });
}

/** The versions of every migration file in `dir` — what this version of the code knows how to reach. */
export function knownMigrationVersions(dir: string = DEFAULT_MIGRATIONS_DIR): string[] {
  return loadMigrations(dir).map((m) => m.version);
}

export interface MigrateOptions {
  /**
   * Called once, before the first change, only when migrations are about to
   * run against a database that already has data (not a brand-new one). The
   * place to take a backup: a migration is the one routine operation that
   * rewrites your tables.
   */
  beforeApply?: (pendingVersions: string[]) => void;
}

/** Applies every pending migration. Returns the versions it applied. */
export function migrate(db: Db, dir: string = DEFAULT_MIGRATIONS_DIR, options: MigrateOptions = {}): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)`);

  const files = loadMigrations(dir);
  const applied = new Map(
    (db.prepare("SELECT version, checksum FROM schema_migrations").all() as { version: string; checksum: string }[]).map(
      (r) => [r.version, r.checksum],
    ),
  );

  for (const version of applied.keys()) {
    if (!files.some((f) => f.version === version)) {
      throw new Error(`migration ${version} is recorded as applied but its file is missing`);
    }
  }

  const pending = files.filter((f) => !applied.has(f.version));
  if (pending.length && applied.size > 0) options.beforeApply?.(pending.map((f) => f.version));

  const newlyApplied: string[] = [];
  for (const f of files) {
    const recorded = applied.get(f.version);
    if (recorded !== undefined) {
      if (recorded !== f.checksum) {
        throw new Error(`migration ${f.version}_${f.name} was edited after being applied — write a new migration instead`);
      }
      continue;
    }
    // SQLite cannot ALTER a CHECK constraint, so some migrations must rebuild a
    // table (create new, copy, drop old, rename). With foreign keys on, DROP TABLE
    // would cascade-delete child rows, and the pragma cannot be changed inside a
    // transaction — so it is switched off around the transaction and re-enabled
    // after. Safety is restored by foreign_key_check, run BEFORE commit: if the
    // migration left any dangling reference, the whole migration rolls back.
    db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.exec(f.sql);
        const dangling = db.pragma("foreign_key_check") as unknown[];
        if (dangling.length) throw new Error(`migration ${f.version}_${f.name} left ${dangling.length} broken foreign key reference(s)`);
        db.prepare("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)").run(
          f.version,
          f.name,
          f.checksum,
          new Date().toISOString(),
        );
      })();
    } finally {
      db.pragma("foreign_keys = ON");
    }
    newlyApplied.push(f.version);
  }
  return newlyApplied;
}
