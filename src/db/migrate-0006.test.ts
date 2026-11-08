import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./connection.ts";
import type { Db } from "./connection.ts";
import { DEFAULT_MIGRATIONS_DIR, migrate } from "./migrate.ts";

// 0006 only ADDS tables (contacts, links, log, settings), so the risk is not data loss but a schema that
// permits nonsense. These tests pin the constraints that keep it honest.

function upTo0006(seed?: (db: Db) => void): Db {
  const dir = mkdtempSync(join(tmpdir(), "mig0006-"));
  try {
    for (const f of readdirSync(DEFAULT_MIGRATIONS_DIR)) if (f < "0006") writeFileSync(join(dir, f), readFileSync(join(DEFAULT_MIGRATIONS_DIR, f)));
    const db = openDatabase(":memory:");
    migrate(db, dir);
    seed?.(db);
    writeFileSync(join(dir, "0006_contacts.sql"), readFileSync(join(DEFAULT_MIGRATIONS_DIR, "0006_contacts.sql")));
    assert.deepEqual(migrate(db, dir), ["0006"]);
    return db;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const seedUserAndCompany = (db: Db) => {
  db.prepare("INSERT INTO users (id, name, created_at) VALUES (2, 'Other', 't')").run();
  db.prepare("INSERT INTO companies (id, user_id, name, name_key, created_at, updated_at) VALUES (1, 1, 'Stripe', 'stripe', 't', 't')").run();
  db.prepare("INSERT INTO applications (id, user_id, company_id, role_title, status, dedupe_key, created_at, updated_at) VALUES (1, 1, 1, 'SWE', 'applied', 'k', 't', 't')").run();
};

test("existing applications, companies and history are untouched by adding the people tables", () => {
  const db = upTo0006(seedUserAndCompany);
  assert.deepEqual(db.prepare("SELECT id, company_id, role_title FROM applications").all(), [{ id: 1, company_id: 1, role_title: "SWE" }]);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM companies").get() as { c: number }).c, 1);
  assert.deepEqual(db.pragma("foreign_key_check"), []);
});

test("the schema refuses nonsense: unknown relationship, role and log kind, a missing name, an unknown company, a duplicate link", () => {
  const db = upTo0006(seedUserAndCompany);
  const contact = (relationship: string) => db.prepare("INSERT INTO contacts (user_id, name, relationship, created_at, updated_at) VALUES (1, 'P', ?, 't', 't')").run(relationship);
  assert.doesNotThrow(() => contact("alumni"));
  assert.throws(() => contact("boss"), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO contacts (user_id, relationship, created_at, updated_at) VALUES (1, 'other', 't', 't')").run(), /NOT NULL/);
  assert.throws(() => db.prepare("INSERT INTO contacts (user_id, name, company_id, created_at, updated_at) VALUES (1, 'P', 999, 't', 't')").run(), /FOREIGN KEY/);
  assert.throws(() => db.prepare("INSERT INTO contacts (user_id, name, created_at, updated_at) VALUES (99, 'P', 't', 't')").run(), /FOREIGN KEY/);
  assert.throws(() => db.prepare("INSERT INTO application_contacts (application_id, contact_id, role, created_at) VALUES (1, 1, 'boss', 't')").run(), /CHECK/);
  db.prepare("INSERT INTO application_contacts (application_id, contact_id, role, created_at) VALUES (1, 1, 'referrer', 't')").run();
  assert.throws(() => db.prepare("INSERT INTO application_contacts (application_id, contact_id, role, created_at) VALUES (1, 1, 'recruiter', 't')").run(), /UNIQUE|PRIMARY/); // one link per pair
  assert.throws(() => db.prepare("INSERT INTO contact_events (contact_id, kind, occurred_on, created_at) VALUES (1, 'yelled', '2026-01-01', 't')").run(), /CHECK/);
  assert.doesNotThrow(() => db.prepare("INSERT INTO contact_events (contact_id, kind, occurred_on, created_at) VALUES (1, 'referral-asked', '2026-01-01', 't')").run());
});

test("deleting a person cascades to their log and links; deleting an application removes only its links", () => {
  const db = upTo0006(seedUserAndCompany);
  db.prepare("INSERT INTO contacts (id, user_id, name, created_at, updated_at) VALUES (1, 1, 'P', 't', 't')").run();
  db.prepare("INSERT INTO contacts (id, user_id, name, created_at, updated_at) VALUES (2, 1, 'Q', 't', 't')").run();
  db.prepare("INSERT INTO application_contacts (application_id, contact_id, role, created_at) VALUES (1, 1, 'other', 't'), (1, 2, 'other', 't')").run();
  db.prepare("INSERT INTO contact_events (contact_id, kind, occurred_on, created_at) VALUES (1, 'note', '2026-01-01', 't')").run();
  db.prepare("DELETE FROM contacts WHERE id = 1").run();
  const n = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
  assert.deepEqual([n("SELECT COUNT(*) c FROM contact_events"), n("SELECT COUNT(*) c FROM application_contacts"), n("SELECT COUNT(*) c FROM applications")], [0, 1, 1]);
  db.prepare("DELETE FROM applications WHERE id = 1").run();
  assert.deepEqual([n("SELECT COUNT(*) c FROM application_contacts"), n("SELECT COUNT(*) c FROM contacts")], [0, 1]); // the person survives
  assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
});

test("settings are one row per user and key, and the indexes exist", () => {
  const db = upTo0006(seedUserAndCompany);
  db.prepare("INSERT INTO user_settings (user_id, key, value) VALUES (1, 'school', 'SFU')").run();
  assert.throws(() => db.prepare("INSERT INTO user_settings (user_id, key, value) VALUES (1, 'school', 'x')").run(), /UNIQUE|PRIMARY/);
  assert.doesNotThrow(() => db.prepare("INSERT INTO user_settings (user_id, key, value) VALUES (2, 'school', 'x')").run());
  const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]).map((r) => r.name);
  for (const i of ["idx_contacts_user_company", "idx_contacts_user_followup", "idx_application_contacts_contact", "idx_contact_events_contact"]) assert.ok(idx.includes(i), i);
});
