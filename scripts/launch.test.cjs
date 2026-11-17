"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { atLeast, parseVersion } = require("./launch.cjs");

test("versions are read from the forms people write them in", () => {
  assert.deepEqual(parseVersion(">=22.18"), [22, 18, 0]);
  assert.deepEqual(parseVersion("v24.9.0"), [24, 9, 0]);
  assert.equal(parseVersion("nonsense"), null);
});

test("atLeast compares numbers, not text (22.9 is older than 22.18)", () => {
  assert.equal(atLeast("22.18.0", ">=22.18"), true);
  assert.equal(atLeast("24.9.0", ">=22.18"), true);
  assert.equal(atLeast("22.9.0", ">=22.18"), false);
  assert.equal(atLeast("20.19.4", ">=22.18"), false);
  assert.equal(atLeast("22.18.1", ">=22.18.2"), false);
});

test("an unreadable version is refused rather than waved through", () => {
  assert.equal(atLeast("garbage", ">=22.18"), false);
});
