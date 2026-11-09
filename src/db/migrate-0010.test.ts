import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "./connection.ts";
import { migrate } from "./migrate.ts";

test("0010: interests belong to a user, need a company, and leave every other table alone", () => {
  const db = openDatabase(":memory:");
  migrate(db);
  db.prepare("INSERT INTO interests (user_id, company, created_at, updated_at) VALUES (1, 'Stripe', 't', 't')").run();
  assert.deepEqual(db.prepare("SELECT company, role_title, url, note FROM interests").all(), [{ company: "Stripe", role_title: null, url: null, note: "" }]);
  assert.throws(() => db.prepare("INSERT INTO interests (user_id, created_at, updated_at) VALUES (1, 't', 't')").run(), /NOT NULL/);
  assert.throws(() => db.prepare("INSERT INTO interests (user_id, company, created_at, updated_at) VALUES (9, 'X', 't', 't')").run(), /FOREIGN KEY/);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM applications").get() as { n: number }).n, 0);
});
