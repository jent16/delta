import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./connection.ts";
import { DEFAULT_MIGRATIONS_DIR, migrate } from "./migrate.ts";

function upTo(version: string) {
  const dir = mkdtempSync(join(tmpdir(), "mig-"));
  for (const f of readdirSync(DEFAULT_MIGRATIONS_DIR)) if (f.slice(0, 4) <= version) cpSync(join(DEFAULT_MIGRATIONS_DIR, f), join(dir, f));
  return dir;
}

test("0011: existing ledger rows survive, and a ledger row now outlives the application it points at", () => {
  const db = openDatabase(":memory:");
  migrate(db, upTo("0010"));
  db.prepare("INSERT INTO companies (id, user_id, name, name_key, created_at, updated_at) VALUES (1, 1, 'Co', 'co', 't', 't')").run();
  db.prepare("INSERT INTO applications (id, user_id, company_id, role_title, status, dedupe_key, created_at, updated_at) VALUES (7, 1, 1, 'SWE', 'saved', 'k', 't', 't')").run();
  db.prepare("INSERT INTO import_records (user_id, source, external_id, application_id, imported_at) VALUES (1, 'notion:x', 'row-1', 7, 't')").run();
  // before: the ledger blocks deleting an application, which is why a delete was only ever an archive
  assert.throws(() => db.prepare("DELETE FROM applications WHERE id = 7").run(), /FOREIGN KEY/);

  assert.deepEqual(migrate(db, upTo("0011")), ["0011"]);
  assert.deepEqual(db.prepare("SELECT source, external_id, application_id FROM import_records").all(), [{ source: "notion:x", external_id: "row-1", application_id: 7 }]);

  db.prepare("DELETE FROM applications WHERE id = 7").run();
  assert.deepEqual(db.prepare("SELECT external_id, application_id FROM import_records").all(), [{ external_id: "row-1", application_id: null }]); // remembered, pointing at nothing
});

test("0011: the ledger still refuses a row for someone who does not exist, and still has one row per source row", () => {
  const db = openDatabase(":memory:");
  migrate(db);
  assert.throws(() => db.prepare("INSERT INTO import_records (user_id, source, external_id, application_id, imported_at) VALUES (9, 's', 'r', NULL, 't')").run(), /FOREIGN KEY/);
  db.prepare("INSERT INTO import_records (user_id, source, external_id, application_id, imported_at) VALUES (1, 's', 'r', NULL, 't')").run();
  assert.throws(() => db.prepare("INSERT INTO import_records (user_id, source, external_id, application_id, imported_at) VALUES (1, 's', 'r', NULL, 't')").run(), /UNIQUE|PRIMARY/);
});
