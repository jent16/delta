import test from "node:test";
import assert from "node:assert/strict";
import { ValidationError } from "./errors.ts";
import { MAX_DELETE, parseIdList } from "./ids.ts";

const issues = (raw: unknown) => {
  try { parseIdList(raw, "application"); } catch (e) { if (e instanceof ValidationError) return e.issues.map((i) => `${i.field}: ${i.message}`); throw e; }
  return [];
};

test("a delete request is { ids: [...] }: whole positive numbers, no repeats, nothing else", () => {
  assert.deepEqual(parseIdList({ ids: [3, 1, 3, 2] }, "application"), [3, 1, 2]);
  assert.deepEqual(issues({ ids: [] }), ["ids: must be a non-empty list of application ids"]);
  assert.deepEqual(issues({}), ["ids: must be a non-empty list of application ids"]);
  assert.deepEqual(issues({ ids: "1" }), ["ids: must be a non-empty list of application ids"]);
  assert.deepEqual(issues({ ids: [1, 0] }), ["ids: every id must be a positive integer"]);
  assert.deepEqual(issues({ ids: [1.5] }), ["ids: every id must be a positive integer"]);
  assert.deepEqual(issues({ ids: ["1"] }), ["ids: every id must be a positive integer"]);
  assert.deepEqual(issues({ ids: [1], all: true }), ["all: unknown field"]);
  assert.deepEqual(issues([1, 2]), ["(body): must be a JSON object"]);
  assert.deepEqual(issues(null), ["(body): must be a JSON object"]);
});

test("there is a cap on how many can go in one request", () => {
  assert.equal(parseIdList({ ids: Array.from({ length: MAX_DELETE }, (_, i) => i + 1) }, "company").length, MAX_DELETE);
  assert.deepEqual(issues({ ids: Array.from({ length: MAX_DELETE + 1 }, (_, i) => i + 1) }), [`ids: at most ${MAX_DELETE} at a time`]);
});
