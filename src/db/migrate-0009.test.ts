import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./connection.ts";
import { DEFAULT_MIGRATIONS_DIR, migrate } from "./migrate.ts";

// migrate to 0008 first, put data in, then apply 0009, the way an existing install meets it
function upTo(version: string) {
  const dir = mkdtempSync(join(tmpdir(), "mig-"));
  for (const f of readdirSync(DEFAULT_MIGRATIONS_DIR)) if (f.slice(0, 4) <= version) cpSync(join(DEFAULT_MIGRATIONS_DIR, f), join(dir, f));
  return dir;
}

test("0009: people who already have applications keep Simon Fraser as their school; nobody else gets one", () => {
  const db = openDatabase(":memory:");
  migrate(db, upTo("0008"));
  db.prepare("INSERT INTO users (id, name, created_at) VALUES (2, 'New', 't')").run();
  db.prepare("INSERT INTO users (id, name, created_at) VALUES (3, 'Has own', 't')").run();
  db.prepare("INSERT INTO companies (id, user_id, name, name_key, created_at, updated_at) VALUES (1, 1, 'Co', 'co', 't', 't')").run();
  db.prepare("INSERT INTO companies (id, user_id, name, name_key, created_at, updated_at) VALUES (2, 3, 'Co', 'co', 't', 't')").run();
  for (const [id, u] of [[1, 1], [2, 3]]) db.prepare("INSERT INTO applications (id, user_id, company_id, role_title, status, dedupe_key, created_at, updated_at) VALUES (?, ?, ?, 'SWE', 'saved', ?, 't', 't')").run(id, u, id, `k${id}`);
  db.prepare("INSERT INTO user_settings (user_id, key, value) VALUES (3, 'school', 'University of Waterloo')").run();

  assert.deepEqual(migrate(db), ["0009"]);
  const schools = db.prepare("SELECT user_id, value FROM user_settings WHERE key = 'school' ORDER BY user_id").all();
  assert.deepEqual(schools, [{ user_id: 1, value: "Simon Fraser University" }, { user_id: 3, value: "University of Waterloo" }]); // user 2 has no applications: nothing written; user 3's choice wins
});

test("0009: a brand-new database starts with no school for anyone", () => {
  const db = openDatabase(":memory:");
  migrate(db);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM user_settings").get() as { n: number }).n, 0);
});
