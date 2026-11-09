import test from "node:test";
import assert from "node:assert/strict";
import { passwordWeakness, WARNING } from "./web/lib/password-strength.js";

// The page warns about easy-to-guess passwords but never blocks them (the server accepts anything non-empty).

test("nothing is said about an empty box", () => {
  assert.equal(passwordWeakness(""), null);
});

test("short, common, one repeated character, only digits, and your own email all get a reason", () => {
  assert.equal(passwordWeakness("hello"), "it is short");
  assert.equal(passwordWeakness("Password123"), "it is one of the most common passwords"); // case-insensitive
  assert.equal(passwordWeakness("zzzzzzzzzzzzzz"), "it is one character repeated");
  assert.equal(passwordWeakness("48151623"), "it is only digits");
  assert.equal(passwordWeakness("Justin@Example.com", "justin@example.com"), "it is your email");
  assert.equal(passwordWeakness("justin", "justin@example.com"), "it is your email");
});

test("a longer or more varied password gets no warning", () => {
  assert.equal(passwordWeakness("x9!kq2m7zp"), null);                       // exactly 10
  assert.equal(passwordWeakness("correct horse battery staple"), null);
  assert.equal(passwordWeakness("1234567890123456"), null);                  // 16 digits is long enough to stop saying so
  assert.equal(passwordWeakness("nine char"), "it is short");                // 9
});

test("the warning says why it matters and that the choice is theirs", () => {
  assert.match(WARNING, /easy to guess/);
  assert.match(WARNING, /more likely to be broken into/);
  assert.match(WARNING, /You can still use it/);
});
