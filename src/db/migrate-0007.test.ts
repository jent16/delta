import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "./connection.ts";
import { migrate } from "./migrate.ts";

test("0007: a deleted contact leaves its import record behind with a NULL contact (so a re-import won't resurrect them), and the table is per user and source", () => {
  const db = openDatabase(":memory:");
  migrate(db);
  db.prepare("INSERT INTO users (id, name, created_at) VALUES (2, 'Other', 't')").run();
  db.prepare("INSERT INTO contacts (id, user_id, name, created_at, updated_at) VALUES (1, 1, 'P', 't', 't')").run();
  db.prepare("INSERT INTO contact_import_records (user_id, source, external_id, contact_id, imported_at) VALUES (1, 'linkedin', 'url:a', 1, 't')").run();
  db.prepare("DELETE FROM contacts WHERE id = 1").run();
  assert.deepEqual(db.prepare("SELECT external_id, contact_id FROM contact_import_records").all(), [{ external_id: "url:a", contact_id: null }]);
  assert.throws(() => db.prepare("INSERT INTO contact_import_records (user_id, source, external_id, contact_id, imported_at) VALUES (1, 'linkedin', 'url:a', NULL, 't')").run(), /UNIQUE|PRIMARY/);
  assert.doesNotThrow(() => db.prepare("INSERT INTO contact_import_records (user_id, source, external_id, contact_id, imported_at) VALUES (2, 'linkedin', 'url:a', NULL, 't')").run());
  assert.doesNotThrow(() => db.prepare("INSERT INTO contact_import_records (user_id, source, external_id, contact_id, imported_at) VALUES (1, 'other', 'url:a', NULL, 't')").run());
  assert.throws(() => db.prepare("INSERT INTO contact_import_records (user_id, source, external_id, contact_id, imported_at) VALUES (9, 'linkedin', 'k', NULL, 't')").run(), /FOREIGN KEY/);
  assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
});
