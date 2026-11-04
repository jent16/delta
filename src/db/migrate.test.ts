import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./connection.ts";
import { DEFAULT_MIGRATIONS_DIR, migrate } from "./migrate.ts";

function withDir(files: Record<string, string>, run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "migrations-"));
  try {
    for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the real migrations apply to an empty database, and again as a no-op", () => {
  const db = openDatabase(":memory:");
  // every file on disk is applied, in order, with no gaps — without hardcoding
  // the list, so adding migration 0003 doesn't mean editing this test
  const onDisk = readdirSync(DEFAULT_MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).map((f) => f.slice(0, 4)).sort();
  assert.deepEqual(onDisk, onDisk.map((_, i) => String(i + 1).padStart(4, "0")));
  assert.deepEqual(migrate(db), onDisk);
  assert.deepEqual(migrate(db), []); // idempotent: safe to run on every startup
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
  for (const t of ["users", "applications", "status_events", "lists", "schema_migrations"]) assert.ok(tables.includes(t), t);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM users").get() as { c: number }).c, 1); // the local user exists
});

test("migrations run in order and only the new ones run later", () => {
  withDir({ "0001_a.sql": "CREATE TABLE a (x);", "0002_b.sql": "CREATE TABLE b (x);" }, (dir) => {
    const db = openDatabase(":memory:");
    assert.deepEqual(migrate(db, dir), ["0001", "0002"]);
    writeFileSync(join(dir, "0003_c.sql"), "CREATE TABLE c (x);");
    assert.deepEqual(migrate(db, dir), ["0003"]);
  });
});

test("a failing migration rolls back completely and leaves nothing recorded", () => {
  withDir({ "0001_a.sql": "CREATE TABLE a (x);", "0002_bad.sql": "CREATE TABLE b (x); INSERT INTO nope VALUES (1);" }, (dir) => {
    const db = openDatabase(":memory:");
    assert.throws(() => migrate(db, dir));
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    assert.ok(tables.includes("a")); // 0001 succeeded before the failure
    assert.ok(!tables.includes("b")); // half of 0002 did NOT stick
    assert.deepEqual((db.prepare("SELECT version FROM schema_migrations").all() as { version: string }[]).map((r) => r.version), ["0001"]);
  });
});

test("editing an already-applied migration is refused", () => {
  withDir({ "0001_a.sql": "CREATE TABLE a (x);" }, (dir) => {
    const db = openDatabase(":memory:");
    migrate(db, dir);
    writeFileSync(join(dir, "0001_a.sql"), "CREATE TABLE a (x, y);"); // someone 'fixes' history
    assert.throws(() => migrate(db, dir), /edited after being applied/);
  });
});

test("a recorded migration whose file vanished is refused", () => {
  withDir({ "0001_a.sql": "CREATE TABLE a (x);" }, (dir) => {
    const db = openDatabase(":memory:");
    migrate(db, dir);
    withDir({}, (emptyDir) => assert.throws(() => migrate(db, emptyDir), /file is missing/));
  });
});

test("bad filenames and duplicate versions are refused", () => {
  withDir({ "init.sql": "" }, (dir) => assert.throws(() => migrate(openDatabase(":memory:"), dir), /bad migration filename/));
  withDir({ "0001_a.sql": "", "0001_b.sql": "" }, (dir) => assert.throws(() => migrate(openDatabase(":memory:"), dir), /share version/));
});

// --- migration 0003 rebuilds the two status tables; prove no data is lost ---

test("0003 (table rebuild) keeps every application and status event, and the database is still protected afterwards", () => {
  const dir = mkdtempSync(join(tmpdir(), "mig-upto-"));
  try {
    // a database exactly as it was before 0003: only the first two real migrations
    for (const f of readdirSync(DEFAULT_MIGRATIONS_DIR)) {
      if (f < "0003") writeFileSync(join(dir, f), readFileSync(join(DEFAULT_MIGRATIONS_DIR, f)));
    }
    const db = openDatabase(":memory:");
    migrate(db, dir);
    const app = db.prepare(
      "INSERT INTO applications (user_id, company, role_title, status, dedupe_key, created_at, updated_at) VALUES (1,'Stripe','SWE Intern','interview','k','t','t')",
    );
    app.run();
    app.run();
    const ev = db.prepare("INSERT INTO status_events (application_id, status, occurred_on, note, created_at) VALUES (?, ?, ?, ?, 't')");
    ev.run(1, "applied", "2026-09-01", "submitted");
    ev.run(1, "interview", "2026-09-20", null);
    ev.run(2, "applied", "2026-09-02", null);

    assert.deepEqual(migrate(db), readdirSync(DEFAULT_MIGRATIONS_DIR).filter((f) => f >= "0003").map((f) => f.slice(0, 4)));

    // nothing was cascade-deleted by the rebuild
    assert.equal((db.prepare("SELECT COUNT(*) c FROM applications").get() as { c: number }).c, 2);
    assert.deepEqual(db.prepare("SELECT id, application_id, status, occurred_on, note FROM status_events ORDER BY id").all(), [
      { id: 1, application_id: 1, status: "applied", occurred_on: "2026-09-01", note: "submitted" },
      { id: 2, application_id: 1, status: "interview", occurred_on: "2026-09-20", note: null },
      { id: 3, application_id: 2, status: "applied", occurred_on: "2026-09-02", note: null },
    ]);
    // the new status is accepted, an unknown one still rejected by the database itself
    assert.doesNotThrow(() => db.prepare("UPDATE applications SET status = 'drafting' WHERE id = 1").run());
    assert.throws(() => db.prepare("UPDATE applications SET status = 'daydreaming' WHERE id = 1").run(), /CHECK/);
    // foreign keys are back on, and still cascade
    assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
    assert.throws(() => db.prepare("INSERT INTO status_events (application_id, status, occurred_on, created_at) VALUES (999,'applied','2026-01-01','t')").run(), /FOREIGN KEY/);
    db.prepare("DELETE FROM applications WHERE id = 2").run();
    assert.equal((db.prepare("SELECT COUNT(*) c FROM status_events WHERE application_id = 2").get() as { c: number }).c, 0);
    // indexes survived the drop
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]).map((r) => r.name);
    for (const i of ["idx_applications_user_status", "idx_applications_user_dedupe", "idx_status_events_app"]) assert.ok(idx.includes(i), i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a migration that leaves a dangling foreign key is rolled back, and foreign keys are re-enabled", () => {
  withDir(
    {
      "0001_a.sql": "CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (id INTEGER PRIMARY KEY, p INTEGER REFERENCES parent(id));",
      "0002_bad.sql": "INSERT INTO child (p) VALUES (42);", // points at a parent that doesn't exist
    },
    (dir) => {
      const db = openDatabase(":memory:");
      assert.throws(() => migrate(db, dir), /broken foreign key/);
      assert.equal((db.prepare("SELECT COUNT(*) c FROM child").get() as { c: number }).c, 0); // rolled back
      assert.equal((db.prepare("SELECT COUNT(*) c FROM schema_migrations").get() as { c: number }).c, 1); // only 0001 recorded
      assert.equal(db.pragma("foreign_keys", { simple: true }), 1); // not left switched off
    },
  );
});
