import test from "node:test";
import assert from "node:assert/strict";
import { createLoginThrottle, emailKey, hashToken, newSessionToken, parseLogin, parseNameChange, parsePasswordChange, parsePasswordConfirmation, parseSignup, sessionExpiry, THROTTLE } from "./auth.ts";
import { ValidationError } from "./errors.ts";
import { createScryptHasher } from "./password.ts";

const fields = (fn: () => unknown) => {
  try { fn(); } catch (e) { if (e instanceof ValidationError) return e.issues.map((i) => i.field); throw e; }
  return [];
};
const good = { name: "Justin Tan", email: "justin@example.com", password: "a long enough one" };

test("emails are compared lowercased and trimmed", () => {
  assert.equal(emailKey("  Justin@Example.COM "), "justin@example.com");
});

test("a sign-up needs a name, a plausible email and a password of 10+ characters", () => {
  assert.deepEqual(parseSignup({ ...good, name: "  Justin   Tan ", email: " justin@example.com " }), { name: "Justin Tan", email: "justin@example.com", password: "a long enough one" });
  assert.deepEqual(fields(() => parseSignup({})), ["email", "name", "password"]);
  assert.deepEqual(fields(() => parseSignup({ ...good, email: "nope" })), ["email"]);
  assert.deepEqual(fields(() => parseSignup({ ...good, email: "a b@c.com" })), ["email"]);
  assert.deepEqual(fields(() => parseSignup({ ...good, email: `${"a".repeat(250)}@x.com` })), ["email"]);
  assert.deepEqual(fields(() => parseSignup({ ...good, name: "x".repeat(101) })), ["name"]);
  assert.deepEqual(fields(() => parseSignup({ ...good, name: "   " })), ["name"]);
  assert.deepEqual(fields(() => parseSignup([])), ["(body)"]);
  assert.deepEqual(fields(() => parseSignup({ ...good, password: 12345678901 })), ["password"]);
});

test("password rules: length bounds (inclusive), common passwords, repeated characters, and the email itself", () => {
  assert.deepEqual(fields(() => parseSignup({ ...good, password: "123456789" })), ["password"]);      // 9
  assert.deepEqual(fields(() => parseSignup({ ...good, password: "x9!kq2m7zp" })), []);               // exactly 10
  assert.deepEqual(fields(() => parseSignup({ ...good, password: "x".repeat(200) })), ["password"]);   // repeated, but allowed length
  assert.deepEqual(fields(() => parseSignup({ ...good, password: "ab1".repeat(66) })), []);             // 198 chars fine
  assert.deepEqual(fields(() => parseSignup({ ...good, password: `${"ab1".repeat(66)}abc` })), ["password"]); // 201: too long
  assert.deepEqual(fields(() => parseSignup({ ...good, password: "ab1".repeat(66) + "ab" })), []);      // exactly 200
  assert.deepEqual(fields(() => parseSignup({ ...good, password: "Password123" })), ["password"]);      // common, case-insensitively
  assert.deepEqual(fields(() => parseSignup({ ...good, password: "aaaaaaaaaaaa" })), ["password"]);
  assert.deepEqual(fields(() => parseSignup({ ...good, email: "longusername@example.com", password: "longusername" })), ["password"]);
  assert.deepEqual(fields(() => parseSignup({ ...good, email: "someone@example.com", password: "SOMEONE@example.com" })), ["password"]);
});

test("sign-in only needs both fields, and never explains which one was wrong", () => {
  assert.deepEqual(parseLogin({ email: " a@b.co ", password: "x" }), { email: "a@b.co", password: "x" });
  for (const bad of [{}, { email: "a@b.co" }, { password: "x" }, { email: "", password: "x" }, { email: "a@b.co", password: "" }, { email: "a@b.co", password: "x".repeat(201) }, { email: 5, password: "x" }]) {
    assert.deepEqual(fields(() => parseLogin(bad)), ["(body)"]);
  }
  assert.deepEqual(fields(() => parseLogin(null)), ["(body)"]);
});

test("changing a password needs the current one and a good new one", () => {
  assert.deepEqual(parsePasswordChange({ current: "old", next: "a brand new one" }, "x@y.co"), { current: "old", next: "a brand new one" });
  assert.deepEqual(fields(() => parsePasswordChange({}, null)), ["current", "next"]);
  assert.deepEqual(fields(() => parsePasswordChange({ current: "old", next: "short" }, null)), ["next"]);
  assert.deepEqual(fields(() => parsePasswordChange({ current: "old", next: "x@y.co" }, "x@y.co")), ["next"]);
  assert.deepEqual(fields(() => parsePasswordConfirmation({})), ["password"]);
  assert.deepEqual(parsePasswordConfirmation({ password: "p" }), { password: "p" });
  assert.deepEqual(fields(() => parseNameChange("  ")), ["name"]);
  assert.equal(parseNameChange(" A   B "), "A B");
});

test("session tokens are random, long, and only their hash is kept", () => {
  const a = newSessionToken(), b = newSessionToken();
  assert.notEqual(a.token, b.token);
  assert.ok(a.token.length >= 43);
  assert.equal(a.hash, hashToken(a.token));
  assert.notEqual(a.hash, a.token);
  assert.match(a.hash, /^[0-9a-f]{64}$/);
});

test("a session ends 30 days after you were last seen, but never later than 90 days after it began", () => {
  const day = 86_400_000;
  const start = new Date("2026-01-01T00:00:00Z");
  assert.equal(sessionExpiry(start, start).getTime(), start.getTime() + 30 * day);
  const seen = new Date(start.getTime() + 20 * day);
  assert.equal(sessionExpiry(start, seen).getTime(), start.getTime() + 50 * day);
  const late = new Date(start.getTime() + 80 * day);
  assert.equal(sessionExpiry(start, late).getTime(), start.getTime() + 90 * day);
});

test("five wrong passwords lock an email for 15 minutes from the last one; a success clears it; keys are independent", () => {
  const th = createLoginThrottle();
  for (let i = 0; i < THROTTLE.maxFailures - 1; i++) th.failed("a", 1000 + i);
  assert.equal(th.wait("a", 2000), 0);                      // four failures: still allowed
  th.failed("a", 5000);
  assert.equal(th.wait("a", 5000), 15 * 60);                // the fifth locks it
  assert.equal(th.wait("a", 5000 + 60_000), 14 * 60);
  assert.equal(th.wait("b", 5000), 0);
  assert.equal(th.wait("a", 5000 + THROTTLE.windowMs - 1) > 0, true);
  assert.equal(th.wait("a", 5000 + THROTTLE.windowMs), 0);  // unlocked exactly when the window has passed
  th.failed("a", 5000 + THROTTLE.windowMs);
  assert.equal(th.wait("a", 5000 + THROTTLE.windowMs), 0);  // and the count started again from one

  const t2 = createLoginThrottle();
  for (let i = 0; i < 5; i++) t2.failed("x", 0);
  t2.succeeded("x");
  assert.equal(t2.wait("x", 1), 0);
});

test("failures older than the window don't add up", () => {
  const th = createLoginThrottle();
  for (let i = 0; i < 4; i++) th.failed("a", 0);
  th.failed("a", THROTTLE.windowMs + 1); // the earlier four have expired, so this is failure number one
  assert.equal(th.wait("a", THROTTLE.windowMs + 2), 0);
});

test("the throttle's memory is bounded: a flood of made-up emails cannot grow it without limit, and live lockouts are never evicted", () => {
  const th = createLoginThrottle();
  for (let i = 0; i < 5; i++) th.failed("victim", 0);
  for (let i = 0; i < THROTTLE.maxKeys + 500; i++) th.failed(`k${i}`, 1);
  assert.equal(th.wait("victim", 2) > 0, true);
  // once the window passes, old entries are pruned and new ones are accepted again
  const later = THROTTLE.windowMs * 2;
  th.failed("fresh", later);
  for (let i = 0; i < 5; i++) th.failed("fresh", later);
  assert.equal(th.wait("fresh", later) > 0, true);
});

test("scrypt: hashes verify, are salted, reject wrong passwords and junk, and the decoy costs the same path", () => {
  const h = createScryptHasher({ N: 1024, r: 8, p: 1 });
  const a = h.hash("correct horse battery"), b = h.hash("correct horse battery");
  assert.notEqual(a, b);
  assert.equal(h.verify("correct horse battery", a), true);
  assert.equal(h.verify("correct horse batterY", a), false);
  assert.equal(h.verify("", a), false);
  assert.match(a, /^scrypt\$1024\$8\$1\$/);
  assert.ok(!a.includes("correct"));
  for (const junk of ["", "plain", "scrypt$1$2$3$4", "bcrypt$1024$8$1$AAAA$AAAA", "scrypt$1000$8$1$AAAA$AAAA", "scrypt$x$8$1$AAAA$AAAA", `scrypt$${2 ** 21}$8$1$AAAA$AAAA`, "scrypt$1024$8$1$AAAA$AAAA"]) {
    assert.equal(h.verify("x", junk), false, junk);
  }
  assert.doesNotThrow(() => h.burn("anything"));
  // composed and decomposed forms of the same text are the same password
  assert.equal(h.verify("éclair-and-more", h.hash("éclair-and-more")), true);
  // a hash made with other cost settings still verifies (so the cost can be raised later)
  assert.equal(createScryptHasher({ N: 2048, r: 8, p: 1 }).verify("correct horse battery", a), true);
});
