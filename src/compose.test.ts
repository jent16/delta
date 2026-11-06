import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db/connection.ts";
import { DEFAULT_MIGRATIONS_DIR, migrate } from "./db/migrate.ts";
import { composeTracker } from "./compose.ts";

test("starting the app on an old database backs it up BEFORE migrating, and the backup is the old data", () => {
  const dir = mkdtempSync(join(tmpdir(), "compose-"));
  try {
    // a database as it was when only migration 0001 existed, holding one application
    const old = join(dir, "old"); mkdirSync(old);
    copyFileSync(join(DEFAULT_MIGRATIONS_DIR, "0001_init.sql"), join(old, "0001_init.sql"));
    const v1 = openDatabase(join(dir, "tracker.db")); migrate(v1, old);
    v1.prepare("INSERT INTO applications (user_id, company, role_title, status, dedupe_key, created_at, updated_at) VALUES (1,'Stripe','SWE','applied','k','t','t')").run();
    v1.close();

    const t = composeTracker({ dataDir: dir, env: {} });
    assert.ok(t.migrationsApplied.length >= 3);
    assert.match(t.preMigrationBackup!.name, /^tracker-pre-migration-0002-\d{8}-\d{6}\.db$/);
    assert.equal(t.preMigrationBackup!.applications, 1);
    // the backup holds the OLD schema: it has no lists table
    const b = openDatabase(t.preMigrationBackup!.file);
    assert.equal((b.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name = 'lists'").get() as { c: number }).c, 0);
    b.close(); t.db.close();

    // the next start has nothing to migrate, so makes no new backup
    const again = composeTracker({ dataDir: dir, env: {} });
    assert.equal(again.preMigrationBackup, null);
    again.db.close();
    assert.equal(readdirSync(join(dir, "backups")).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a brand-new install makes no backup (there is nothing to protect), and DELTA_BACKUP_DIR is honoured", () => {
  const dir = mkdtempSync(join(tmpdir(), "compose-"));
  try {
    const t = composeTracker({ dataDir: join(dir, "data"), env: { DELTA_BACKUP_DIR: join(dir, "synced") } });
    assert.equal(t.preMigrationBackup, null);
    assert.equal(t.backupDir, join(dir, "synced"));
    t.db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
