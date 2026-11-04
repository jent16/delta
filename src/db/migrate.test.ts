import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
