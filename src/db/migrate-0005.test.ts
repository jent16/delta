import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dedupeKey } from "../domain/application.ts";
import { identityKey } from "../domain/keys.ts";
import { openDatabase } from "./connection.ts";
import type { Db } from "./connection.ts";
import { DEFAULT_MIGRATIONS_DIR, migrate } from "./migrate.ts";

// Migration 0005 moves the company name and sector off every application onto a companies table.
// It rewrites the table that holds the only copy of your applications, so it is tested against awkward data.

/** A database exactly as it was before 0005, with `seed` run against the old schema; then 0005 is applied. */
function migrateWith(seed: (db: Db) => void): Db {
  const dir = mkdtempSync(join(tmpdir(), "mig0005-"));
  try {
    for (const f of readdirSync(DEFAULT_MIGRATIONS_DIR)) if (f < "0005") writeFileSync(join(dir, f), readFileSync(join(DEFAULT_MIGRATIONS_DIR, f)));
    const db = openDatabase(":memory:");
    migrate(db, dir);
    db.prepare("INSERT INTO users (id, name, created_at) VALUES (2, 'Other', 't')").run();
    seed(db);
    // apply exactly 0005 (later migrations are tested on their own)
    writeFileSync(join(dir, "0005_companies.sql"), readFileSync(join(DEFAULT_MIGRATIONS_DIR, "0005_companies.sql")));
    assert.deepEqual(migrate(db, dir), ["0005"]);
    return db;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let n = 0;
const old = (db: Db, o: { user?: number; company: string; role?: string; term?: string | null; sector?: string | null; status?: string; archived?: boolean; at?: string }) => {
  const id = Number(
    db.prepare("INSERT INTO applications (user_id, company, role_title, term, sector, status, dedupe_key, archived_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(o.user ?? 1, o.company, o.role ?? `Role ${++n}`, o.term ?? null, o.sector ?? null, o.status ?? "applied", "stale-old-key", o.archived ? "t" : null, o.at ?? "2026-09-01T00:00:00Z", o.at ?? "2026-09-01T00:00:00Z").lastInsertRowid,
  );
  db.prepare("INSERT INTO status_events (application_id, status, occurred_on, note, created_at) VALUES (?, ?, '2026-09-01', ?, 't')").run(id, o.status ?? "applied", `event for ${id}`);
  return id;
};
const companies = (db: Db) => db.prepare("SELECT user_id, name, name_key, sector FROM companies ORDER BY id").all() as { user_id: number; name: string; name_key: string; sector: string | null }[];

test("companies are created from the distinct names; spellings that differ only by case or spacing become ONE company", () => {
  const db = migrateWith((d) => {
    old(d, { company: "Skydio" }); old(d, { company: "skydio" }); old(d, { company: "SKYDIO " }); old(d, { company: "  sky   dio" });
    old(d, { company: "Stripe" });
  });
  assert.deepEqual(companies(db).map((c) => c.name_key).sort(), ["sky dio", "skydio", "stripe"]); // (ids follow key order; nothing depends on it)
  assert.equal((db.prepare("SELECT COUNT(*) c FROM applications").get() as { c: number }).c, 5);
  const counts = db.prepare("SELECT c.name_key k, COUNT(*) n FROM applications a JOIN companies c ON c.id = a.company_id GROUP BY c.id ORDER BY c.name_key").all();
  assert.deepEqual(counts, [{ k: "sky dio", n: 1 }, { k: "skydio", n: 3 }, { k: "stripe", n: 1 }]);
});

test("the display name is the first-added spelling that is not all lowercase", () => {
  const db = migrateWith((d) => { old(d, { company: "linkedin" }); old(d, { company: "LinkedIn" }); old(d, { company: "Linkedin" }); old(d, { company: "coinbase" }); });
  assert.deepEqual(companies(db).map((c) => c.name).sort(), ["LinkedIn", "coinbase"]); // not the earlier "linkedin"; all-lowercase is used only when it is all there is
});

test("sector: the company takes the most common sector among its applications (ties alphabetical); none stays none", () => {
  const db = migrateWith((d) => {
    old(d, { company: "A", sector: "Fintech" }); old(d, { company: "A", sector: "Fintech" }); old(d, { company: "A", sector: "Finance" });
    old(d, { company: "B", sector: "Finance" }); old(d, { company: "B", sector: "Fintech" }); // tie -> alphabetical: Finance
    old(d, { company: "C" }); old(d, { company: "C", sector: "Telecom" });                      // one blank, one set -> the set one
    old(d, { company: "D" });
  });
  assert.deepEqual(companies(db).map((c) => [c.name, c.sector]), [["A", "Fintech"], ["B", "Finance"], ["C", "Telecom"], ["D", null]]);
});

test("companies are per user: the same name for two users is two companies", () => {
  const db = migrateWith((d) => { old(d, { company: "Stripe", user: 1 }); old(d, { company: "Stripe", user: 2 }); });
  assert.deepEqual(companies(db).map((c) => [c.user_id, c.name_key]), [[1, "stripe"], [2, "stripe"]]);
  assert.throws(() => db.prepare("INSERT INTO companies (user_id, name, name_key, created_at, updated_at) VALUES (1,'STRIPE','stripe','t','t')").run(), /UNIQUE/); // one per user per key
});

test("nothing is lost: every application and status event survives with its id, status and dates, archived ones included", () => {
  const db = migrateWith((d) => {
    old(d, { company: "A", status: "interview" }); old(d, { company: "A", status: "rejected", archived: true }); old(d, { company: "B", status: "saved" });
    d.prepare("INSERT INTO status_events (application_id, status, occurred_on, note, created_at) VALUES (1, 'interview', '2026-09-20', 'second', 't')").run();
  });
  assert.deepEqual(db.prepare("SELECT id, status, archived_at FROM applications ORDER BY id").all(), [
    { id: 1, status: "interview", archived_at: null }, { id: 2, status: "rejected", archived_at: "t" }, { id: 3, status: "saved", archived_at: null },
  ]);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM status_events").get() as { c: number }).c, 4); // none cascade-deleted by the rebuild
  assert.deepEqual(db.prepare("SELECT application_id, note FROM status_events WHERE application_id = 1 ORDER BY id").all(), [{ application_id: 1, note: "event for 1" }, { application_id: 1, note: "second" }]);
});

test("the old company and sector columns are gone, and the database still protects itself", () => {
  const db = migrateWith((d) => { old(d, { company: "A", sector: "Fintech" }); });
  const cols = (db.prepare("PRAGMA table_info(applications)").all() as { name: string }[]).map((c) => c.name);
  assert.ok(!cols.includes("company") && !cols.includes("sector"), "one place for each fact");
  assert.ok(cols.includes("company_id"));
  assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
  assert.throws(() => db.prepare("INSERT INTO applications (user_id, company_id, role_title, status, dedupe_key, created_at, updated_at) VALUES (1, 999, 'x', 'saved', 'k', 't', 't')").run(), /FOREIGN KEY/);
  assert.throws(() => db.prepare("INSERT INTO applications (user_id, role_title, status, dedupe_key, created_at, updated_at) VALUES (1, 'x', 'saved', 'k', 't', 't')").run(), /NOT NULL/);
  assert.throws(() => db.prepare("UPDATE applications SET status = 'daydreaming'").run(), /CHECK/);
  assert.deepEqual(db.pragma("foreign_key_check"), []);
  const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]).map((r) => r.name);
  for (const i of ["idx_applications_user_status", "idx_applications_user_dedupe", "idx_applications_company", "companies_user_key", "idx_status_events_app"]) assert.ok(idx.includes(i), i);
  // deleting an application still deletes its history (the cascade survived the rebuild)
  db.prepare("DELETE FROM applications").run();
  assert.equal((db.prepare("SELECT COUNT(*) c FROM status_events").get() as { c: number }).c, 0);
});

// The SQL in the migration and identityKey()/dedupeKey() in code must agree EXACTLY, or an application you add
// tomorrow would not be recognised as a duplicate of one that was migrated today.
const AWKWARD = [
  "Stripe", "STRIPE", "  Stripe  ", "Stripe\tInc", "Stripe\nInc", "Stripe\r\nInc", "a  b", "a   b", "a    b",
  "x" + " ".repeat(200) + "y", "Zürich Insurance", "ÉCOLE Polytechnique", "Café ÀB", "日本の会社", "AT&T", "O'Reilly (Media)", "  ", "Two  Spaces  Here",
];
test("SQL and TypeScript compute identical keys for awkward strings (tabs, newlines, long runs of spaces, accents, non-Latin)", () => {
  const db = migrateWith((d) => {
    AWKWARD.forEach((name, i) => { if (name.trim()) old(d, { company: name, role: AWKWARD[(i + 3) % AWKWARD.length]!.trim() ? AWKWARD[(i + 3) % AWKWARD.length]! : "Role", term: i % 2 ? AWKWARD[(i + 5) % AWKWARD.length]! : null }); });
  });
  const rows = db.prepare("SELECT a.dedupe_key, a.role_title, a.term, c.name, c.name_key FROM applications a JOIN companies c ON c.id = a.company_id").all() as
    { dedupe_key: string; role_title: string; term: string | null; name: string; name_key: string }[];
  assert.ok(rows.length >= 10);
  for (const r of rows) {
    assert.equal(r.name_key, identityKey(r.name), `company key for ${JSON.stringify(r.name)}`);
    assert.equal(r.dedupe_key, dedupeKey({ company: r.name, roleTitle: r.role_title, term: r.term }), `dedupe key for ${JSON.stringify([r.name, r.role_title, r.term])}`);
  }
});

test("identityKey: ASCII lowercase, collapsed whitespace, trimmed; accents and other scripts are left alone", () => {
  assert.equal(identityKey("  Hello\t World\n "), "hello world");
  assert.equal(identityKey("Zürich"), "zürich");
  assert.equal(identityKey("ÉCOLE"), "École"); // only A-Z are lowercased, exactly as SQLite's lower() does; keeps the two in agreement
  assert.equal(identityKey(null), "");
  assert.equal(identityKey(undefined), "");
});

test("the migration is applied once and recorded", () => {
  const db = migrateWith((d) => { old(d, { company: "A" }); });
  assert.ok((db.prepare("SELECT version FROM schema_migrations WHERE version = '0005'").get() as unknown) !== undefined);
});
