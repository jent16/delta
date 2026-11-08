import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "./connection.ts";
import { migrate } from "./migrate.ts";
import { createUserRepository } from "../repositories/users.ts";

test("0008: the existing user stays, gains empty account columns, and emails are unique only once set", () => {
  const db = openDatabase(":memory:");
  migrate(db);
  assert.deepEqual(db.prepare("SELECT id, name, email, email_key, password_hash FROM users").all(), [{ id: 1, name: "Me", email: null, email_key: null, password_hash: null }]);
  // several unclaimed rows may coexist (NULL keys don't clash), but two rows can't share an email
  db.prepare("INSERT INTO users (name, created_at) VALUES ('x', 't')").run();
  db.prepare("INSERT INTO users (name, email, email_key, created_at) VALUES ('a', 'A@x.co', 'a@x.co', 't')").run();
  assert.throws(() => db.prepare("INSERT INTO users (name, email, email_key, created_at) VALUES ('b', 'a@x.co', 'a@x.co', 't')").run(), /UNIQUE/);
});

test("0008: a session goes when its user goes, and resume version names are unique per person", () => {
  const db = openDatabase(":memory:");
  migrate(db);
  db.prepare("INSERT INTO users (id, name, created_at) VALUES (2, 'B', 't')").run();
  db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at) VALUES ('h', 2, 't', 't', 't')").run();
  db.prepare("DELETE FROM users WHERE id = 2").run();
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n, 0);
  db.prepare("INSERT INTO resume_versions (user_id, name, name_key, created_at) VALUES (1, 'A', 'a', 't')").run();
  assert.throws(() => db.prepare("INSERT INTO resume_versions (user_id, name, name_key, created_at) VALUES (1, 'a', 'a', 't')").run(), /UNIQUE/);
  assert.throws(() => db.prepare("INSERT INTO resume_versions (user_id, name, name_key, created_at) VALUES (9, 'a', 'a', 't')").run(), /FOREIGN KEY/);
});

test("0008: migrating a database that already has applications keeps every row", () => {
  const db = openDatabase(":memory:");
  migrate(db, undefined);
  db.prepare("INSERT INTO companies (user_id, name, name_key, created_at, updated_at) VALUES (1, 'Stripe', 'stripe', 't', 't')").run();
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM companies").get() as { n: number }).n, 1);
  assert.deepEqual(migrate(db), []); // nothing left to apply
});

// Deleting an account must remove every row that belongs to it. This test is what stops a future table from being forgotten:
// it fills EVERY table the schema has with one person's rows, deletes that person, and requires that nothing of theirs remains
// while a second person's identical rows are untouched.
test("deleting an account leaves no row of theirs in any table, and none of anyone else's touched — including tables added later", () => {
  const db = openDatabase(":memory:");
  migrate(db);
  const users = createUserRepository(db);
  const NOW = "2026-01-01T00:00:00Z";
  for (const id of [2, 3]) db.prepare("INSERT INTO users (id, name, email, email_key, password_hash, created_at) VALUES (?, 'u', ?, ?, 'h', ?)").run(id, `u${id}@x.co`, `u${id}@x.co`, NOW);
  const seed = (u: number) => {
    db.prepare("INSERT INTO companies (id, user_id, name, name_key, created_at, updated_at) VALUES (?, ?, 'Co', 'co', ?, ?)").run(u * 10, u, NOW, NOW);
    db.prepare(`INSERT INTO applications (id, user_id, company_id, role_title, status, dedupe_key, created_at, updated_at) VALUES (?, ?, ?, 'SWE', 'saved', 'k', ?, ?)`).run(u * 10, u, u * 10, NOW, NOW);
    db.prepare("INSERT INTO status_events (application_id, status, occurred_on, created_at) VALUES (?, 'saved', '2026-01-01', ?)").run(u * 10, NOW);
    db.prepare("INSERT INTO contacts (id, user_id, name, company_id, created_at, updated_at) VALUES (?, ?, 'P', ?, ?, ?)").run(u * 10, u, u * 10, NOW, NOW);
    db.prepare("INSERT INTO application_contacts (application_id, contact_id, role, created_at) VALUES (?, ?, 'other', ?)").run(u * 10, u * 10, NOW);
    db.prepare("INSERT INTO contact_events (contact_id, kind, occurred_on, created_at) VALUES (?, 'note', '2026-01-01', ?)").run(u * 10, NOW);
    db.prepare("INSERT INTO lists (user_id, name, filter, created_at, updated_at) VALUES (?, 'L', '{}', ?, ?)").run(u, NOW, NOW);
    db.prepare("INSERT INTO import_records (user_id, source, external_id, application_id, imported_at) VALUES (?, 's', 'e', ?, ?)").run(u, u * 10, NOW);
    db.prepare("INSERT INTO contact_import_records (user_id, source, external_id, contact_id, imported_at) VALUES (?, 's', 'e', ?, ?)").run(u, u * 10, NOW);
    db.prepare("INSERT INTO user_settings (user_id, key, value) VALUES (?, 'school', 'X')").run(u);
    db.prepare("INSERT INTO resume_versions (user_id, name, name_key, created_at) VALUES (?, 'R', 'r', ?)").run(u, NOW);
    db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)").run(`h${u}`, u, NOW, NOW, NOW);
  };
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'").all() as { name: string }[]).map((r) => r.name);
  const counts = () => Object.fromEntries(tables.map((t) => [t, (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n]));
  seed(3);
  const withThree = counts();
  seed(2);
  const withBoth = counts();
  // every table must have been seeded for person 2 for this test to mean anything (a table added later fails here until it is added to seed())
  for (const t of tables) if (t !== "users") assert.ok(withBoth[t]! > withThree[t]!, `${t} was not seeded — add it to this test and to deleteAccount`);

  users.deleteAccount(2);

  const after = counts();
  for (const t of tables) assert.equal(after[t], t === "users" ? withThree[t]! - 1 : withThree[t], `${t}: expected exactly the rows from before person 2 existed`);
  assert.deepEqual(db.pragma("foreign_key_check"), []);
  // and the other person is intact end to end
  assert.deepEqual(db.prepare("SELECT user_id FROM applications").all(), [{ user_id: 3 }]);
  assert.equal(users.findById(3)?.email, "u3@x.co");
});

test("claiming and creating accounts is atomic: two sign-ups cannot both take the unclaimed user", () => {
  const db = openDatabase(":memory:");
  migrate(db);
  const users = createUserRepository(db);
  const a = users.register({ name: "A", email: "a@x.co", emailKey: "a@x.co", passwordHash: "h" }, "t");
  const b = users.register({ name: "B", email: "b@x.co", emailKey: "b@x.co", passwordHash: "h" }, "t");
  assert.deepEqual([a.claimed, a.user.id, b.claimed, b.user.id > 1], [true, 1, false, true]);
  assert.equal(users.hasUnclaimed(), false);
  assert.throws(() => users.register({ name: "C", email: "A@x.co", emailKey: "a@x.co", passwordHash: "h" }, "t"), /UNIQUE/);
});
