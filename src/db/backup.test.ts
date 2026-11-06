import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { backupIfStale, createBackup, inspectDatabase, listBackups, pruneBackups, restoreBackup } from "./backup.ts";
import { openDatabase } from "./connection.ts";
import type { Db } from "./connection.ts";
import { DEFAULT_MIGRATIONS_DIR, migrate } from "./migrate.ts";

function sandbox(run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "backup-"));
  try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const addApp = (db: Db, company: string) => {
  const id = Number(db.prepare("INSERT INTO applications (user_id, company, role_title, status, dedupe_key, created_at, updated_at) VALUES (1,?,?,'applied',?,'t','t')").run(company, "SWE", company).lastInsertRowid);
  db.prepare("INSERT INTO status_events (application_id, status, occurred_on, created_at) VALUES (?, 'applied', '2026-09-01', 't')").run(id);
};
const apps = (file: string) => { const d = new Database(file, { readonly: true }); try { return (d.prepare("SELECT company FROM applications ORDER BY id").all() as { company: string }[]).map((r) => r.company); } finally { d.close(); } };
const T = (s: string) => new Date(`${s}Z`);
function liveDb(dir: string, companies: string[] = ["Stripe", "Figma"]) {
  const db = openDatabase(join(dir, "tracker.db"));
  migrate(db);
  companies.forEach((c) => addApp(db, c));
  return db;
}

test("a backup is a verified snapshot, and later changes don't leak into it", () => {
  sandbox((dir) => {
    const db = liveDb(dir);
    const b = createBackup(db, join(dir, "b"), { now: T("2026-11-05T10:00:00") });
    assert.deepEqual([b.applications, b.statusEvents], [2, 2]);
    assert.match(b.name, /^tracker-20261105-100000\.db$/);
    addApp(db, "Later Co");
    assert.deepEqual(apps(b.file), ["Stripe", "Figma"]);
    db.close();
  });
});

test("a backup taken straight after a write includes it (the WAL problem a plain file copy has)", () => {
  sandbox((dir) => {
    const db = liveDb(dir, ["First"]);
    addApp(db, "Just Written"); // committed, but possibly still only in the -wal file
    assert.ok(existsSync(join(dir, "tracker.db-wal")), "precondition: the database really is in WAL mode with a wal file");
    const b = createBackup(db, join(dir, "b"));
    assert.deepEqual(apps(b.file), ["First", "Just Written"]);
    db.close();
  });
});

test("backups in the same second get distinct names, and a label is part of the name", () => {
  sandbox((dir) => {
    const db = liveDb(dir);
    const now = T("2026-11-05T10:00:00");
    const a = createBackup(db, join(dir, "b"), { now });
    const b = createBackup(db, join(dir, "b"), { now });
    const c = createBackup(db, join(dir, "b"), { now, label: "pre-import" });
    assert.deepEqual([a.name, b.name, c.name], ["tracker-20261105-100000.db", "tracker-20261105-100000-2.db", "tracker-pre-import-20261105-100000.db"]);
    db.close();
  });
});

test("inspectDatabase rejects anything that isn't an intact tracker database", () => {
  sandbox((dir) => {
    const db = liveDb(dir);
    const good = createBackup(db, join(dir, "b")).file;
    db.close();
    assert.equal(inspectDatabase(good).ok, true);

    writeFileSync(join(dir, "garbage.db"), "this is not a database at all");
    assert.equal(inspectDatabase(join(dir, "garbage.db")).ok, false);

    const other = new Database(join(dir, "other.db")); other.exec("CREATE TABLE t (x)"); other.close();
    assert.match(inspectDatabase(join(dir, "other.db")).problem!, /not a Delta tracker database/);

    copyFileSync(good, join(dir, "cut.db")); truncateSync(join(dir, "cut.db"), 5000);
    assert.equal(inspectDatabase(join(dir, "cut.db")).ok, false);

    assert.equal(inspectDatabase(join(dir, "missing.db")).ok, false);
  });
});

test("listBackups: newest first, foreign files ignored, labelled ones flagged", () => {
  sandbox((dir) => {
    const b = join(dir, "b"); mkdirSync(b);
    for (const n of ["tracker-20261101-090000.db", "tracker-20261103-090000.db", "tracker-pre-migration-0005-20261102-090000.db", "notes.txt", "tracker-bogus.db"]) writeFileSync(join(b, n), "x");
    const l = listBackups(b);
    assert.deepEqual(l.map((x) => x.name), ["tracker-20261103-090000.db", "tracker-pre-migration-0005-20261102-090000.db", "tracker-20261101-090000.db"]);
    assert.deepEqual(l.map((x) => x.labelled), [false, true, false]);
    assert.deepEqual(listBackups(join(dir, "does-not-exist")), []);
  });
});

test("prune keeps the newest N regular backups, and never deletes a labelled one or a foreign file", () => {
  sandbox((dir) => {
    const b = join(dir, "b"); mkdirSync(b);
    const names = ["tracker-20261101-090000.db", "tracker-20261102-090000.db", "tracker-20261103-090000.db", "tracker-20261104-090000.db", "tracker-pre-import-20261101-080000.db", "my-own-copy.db"];
    names.forEach((n) => writeFileSync(join(b, n), "x"));
    assert.deepEqual(pruneBackups(b, 2).sort(), ["tracker-20261101-090000.db", "tracker-20261102-090000.db"]);
    assert.deepEqual(readdirSync(b).sort(), ["my-own-copy.db", "tracker-20261103-090000.db", "tracker-20261104-090000.db", "tracker-pre-import-20261101-080000.db"]);
  });
});

test("backupIfStale: takes one when there is none or the newest is old; skips when recent; prunes", () => {
  sandbox((dir) => {
    const db = liveDb(dir);
    const b = join(dir, "b");
    const opts = { maxAgeHours: 12, keep: 2 };
    assert.ok(backupIfStale(db, b, { ...opts, now: T("2026-11-05T00:00:00") }));      // none yet
    assert.equal(backupIfStale(db, b, { ...opts, now: T("2026-11-05T11:59:00") }), null); // 11h59 old: still fresh
    assert.ok(backupIfStale(db, b, { ...opts, now: T("2026-11-05T12:00:00") }));      // 12h: stale
    assert.ok(backupIfStale(db, b, { ...opts, now: T("2026-11-06T00:00:00") }));
    assert.equal(listBackups(b).length, 2); // pruned to keep=2
    // a recent labelled backup does not count as "recent regular backup"
    createBackup(db, b, { now: T("2026-11-06T23:00:00"), label: "pre-import" });
    assert.ok(backupIfStale(db, b, { ...opts, now: T("2026-11-06T23:30:00") }));
    db.close();
  });
});

test("restore round trip: the backup's data comes back, and the database you had is saved first", () => {
  sandbox((dir) => {
    const db = liveDb(dir);
    const backup = createBackup(db, join(dir, "b"), { now: T("2026-11-05T10:00:00") });
    addApp(db, "Added After"); db.prepare("DELETE FROM applications WHERE company = 'Figma'").run();
    db.close();

    const r = restoreBackup({ backupFile: backup.file, targetFile: join(dir, "tracker.db"), safetyDir: join(dir, "b"), now: T("2026-11-05T11:00:00") });
    assert.deepEqual(apps(join(dir, "tracker.db")), ["Stripe", "Figma"]);
    assert.deepEqual(apps(r.safetyCopy!), ["Stripe", "Added After"]); // what you had before is not lost
    assert.match(r.safetyCopy!, /tracker-pre-restore-20261105-110000\.db$/);
    assert.equal(listBackups(join(dir, "b")).find((x) => x.file === r.safetyCopy)!.labelled, true); // so pruning never deletes it
    assert.deepEqual(readdirSync(dir).filter((f) => f.includes("restoring")), []); // no temp file left behind
  });
});

test("restore refuses a bad or too-new backup, and leaves the current database untouched", () => {
  sandbox((dir) => {
    const db = liveDb(dir); db.close();
    const target = join(dir, "tracker.db");
    const common = { targetFile: target, safetyDir: join(dir, "b") };

    writeFileSync(join(dir, "garbage.db"), "nope");
    assert.throws(() => restoreBackup({ ...common, backupFile: join(dir, "garbage.db") }), /cannot restore/);

    const d2 = openDatabase(join(dir, "future.db")); migrate(d2);
    d2.prepare("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES ('9999','from_the_future','x','t')").run(); d2.close();
    assert.throws(() => restoreBackup({ ...common, backupFile: join(dir, "future.db") }), /newer Delta/);

    assert.deepEqual(apps(target), ["Stripe", "Figma"]);
    assert.ok(!existsSync(join(dir, "b")) || readdirSync(join(dir, "b")).length === 0, "no safety copy is made for a refused restore");
  });
});

test("restore refuses while the database is in use (a running server would keep writing to the replaced file)", () => {
  sandbox((dir) => {
    const live = liveDb(dir);
    const backup = createBackup(live, join(dir, "b"));
    const args = { backupFile: backup.file, targetFile: join(dir, "tracker.db"), safetyDir: join(dir, "b") };
    assert.throws(() => restoreBackup(args), /looks like it is in use.*Stop/);
    live.close(); // a clean close removes the -wal/-shm files
    assert.doesNotThrow(() => restoreBackup(args));
  });
});

test("restore can set up a machine with no database yet, and an old backup is upgraded by the next migrate", () => {
  sandbox((dir) => {
    // an old backup: only migration 0001 had run
    const old = join(dir, "old"); mkdirSync(old);
    copyFileSync(join(DEFAULT_MIGRATIONS_DIR, "0001_init.sql"), join(old, "0001_init.sql"));
    const v1 = openDatabase(join(dir, "v1.db")); migrate(v1, old); addApp(v1, "Legacy Co"); v1.close();

    const target = join(dir, "fresh", "tracker.db");
    const r = restoreBackup({ backupFile: join(dir, "v1.db"), targetFile: target, safetyDir: join(dir, "b") });
    assert.equal(r.safetyCopy, null);
    const db = openDatabase(target);
    const applied = migrate(db); // what the server does on its next start
    assert.ok(applied.length >= 1 && applied[0] === "0002");
    assert.deepEqual((db.prepare("SELECT company FROM applications").all() as { company: string }[]).map((x) => x.company), ["Legacy Co"]);
    assert.equal((db.prepare("SELECT COUNT(*) c FROM lists").get() as { c: number }).c, 3);
    db.close();
  });
});

test("a backup that fails verification is discarded and reported, never left behind as if it were good", () => {
  sandbox((dir) => {
    const real = liveDb(dir);
    // a database whose snapshot comes out as garbage (a stand-in for a full disk or a failed write)
    const broken = new Proxy(real, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => (sql.startsWith("VACUUM INTO") ? { run: (file: string) => writeFileSync(file, "not a database") } : target.prepare(sql));
        }
        const v = (target as unknown as Record<string | symbol, unknown>)[prop];
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as Db;
    assert.throws(() => createBackup(broken, join(dir, "b")), /failed verification.*discarded/);
    assert.deepEqual(readdirSync(join(dir, "b")), []); // the bad file was removed
    real.close();
  });
});

test("a snapshot that is a valid database but is MISSING rows is rejected too", () => {
  sandbox((dir) => {
    const real = liveDb(dir, ["A", "B", "C"]);
    const smaller = liveDb(mkdtempSync(join(dir, "other-")), ["Only One"]);
    const lossy = new Proxy(real, {
      get(target, prop) {
        if (prop === "prepare") {
          // the "backup" is a perfectly healthy tracker database... that holds 1 application instead of 3
          return (sql: string) => (sql.startsWith("VACUUM INTO") ? { run: (file: string) => smaller.prepare("VACUUM INTO ?").run(file) } : target.prepare(sql));
        }
        const v = (target as unknown as Record<string | symbol, unknown>)[prop];
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as Db;
    assert.throws(() => createBackup(lossy, join(dir, "b")), /failed verification.*expected 3\/3 rows, copy has 1\/1/);
    assert.deepEqual(readdirSync(join(dir, "b")), []);
    real.close(); smaller.close();
  });
});

test("restoring forcibly over an open database removes its leftover -wal/-shm, which would otherwise be replayed onto the restored data", () => {
  sandbox((dir) => {
    const live = liveDb(dir);
    const backup = createBackup(live, join(dir, "b"));
    addApp(live, "Unflushed"); // sits in the old database's -wal
    const target = join(dir, "tracker.db");
    assert.ok(existsSync(`${target}-wal`) && existsSync(`${target}-shm`), "precondition: wal and shm exist");
    restoreBackup({ backupFile: backup.file, targetFile: target, safetyDir: join(dir, "b"), force: true });
    assert.ok(!existsSync(`${target}-wal`) && !existsSync(`${target}-shm`));
    assert.deepEqual(apps(target), ["Stripe", "Figma"]); // exactly the backup, nothing replayed from the old WAL
    live.close();
  });
});
