import test from "node:test";
import assert from "node:assert/strict";
import { ValidationError } from "../domain/errors.ts";
import type { CompanyDirectory } from "../domain/ports.ts";
import { makeTracker } from "../testing/harness.ts";

const directory = (names: string[], extra: { available?: boolean; note?: string } = {}): CompanyDirectory => ({
  names: async () => ({ names, available: extra.available ?? true, ...(extra.note ? { note: extra.note } : {}) }),
});
const tracker = (names: string[], extra?: { available?: boolean; note?: string }) => makeTracker(undefined, undefined, directory(names, extra));

test("suggestions combine your own companies (with counts) and the directory, yours first, with a sector hint", async () => {
  const t = tracker(["Jane Street Capital", "Janet Co", "Unrelated Inc"]);
  t.service.add(1, { company: "Jane Street", roleTitle: "SWE" });
  t.service.add(1, { company: "jane street", roleTitle: "Quant" });
  const r = await t.companies.search(1, { q: "jane" });
  assert.equal(r.directoryAvailable, true);
  assert.deepEqual(r.suggestions.map((s) => [s.name, s.source, s.applications ?? null, s.sectorHint]), [
    ["Jane Street", "yours", 2, "Finance"],
    ["Janet Co", "directory", null, null], // directory prefix matches: shorter name first
    ["Jane Street Capital", "directory", null, null],
  ]);
});

test("a company whose applications are all archived is still suggested (you have history with it), with a count of 0", async () => {
  const t = tracker([]);
  const a = t.service.add(1, { company: "Gone Co", roleTitle: "SWE" });
  t.service.archive(1, a.id);
  const s = (await t.companies.search(1, { q: "gone" })).suggestions;
  assert.deepEqual(s.map((x) => [x.name, x.source, x.applications]), [["Gone Co", "yours", 0]]);
});

test("only your own companies are suggested for you", async () => {
  const t = tracker([]);
  t.db.prepare("INSERT INTO users (id, name, created_at) VALUES (2, 'Other', 'now')").run();
  t.service.add(2, { company: "Secret Startup", roleTitle: "SWE" });
  assert.deepEqual((await t.companies.search(1, { q: "secret" })).suggestions, []);
  assert.equal((await t.companies.search(2, { q: "secret" })).suggestions.length, 1);
});

test("when the directory is unavailable, search still works from your tracker and says so", async () => {
  const t = tracker([], { available: false, note: "offline" });
  t.service.add(1, { company: "Stripe", roleTitle: "SWE" });
  const r = await t.companies.search(1, { q: "strip" });
  assert.deepEqual([r.directoryAvailable, r.note, r.suggestions.map((s) => s.name)], [false, "offline", ["Stripe"]]);
});

test("a query is required and the limit is bounded", async () => {
  const t = tracker(["A1", "A2", "A3"]);
  await assert.rejects(t.companies.search(1, {}), ValidationError);
  await assert.rejects(t.companies.search(1, { q: "  " }), ValidationError);
  await assert.rejects(t.companies.search(1, { q: "a", limit: "0" }), ValidationError);
  await assert.rejects(t.companies.search(1, { q: "a", limit: "21" }), ValidationError);
  assert.equal((await t.companies.search(1, { q: "a", limit: "2" })).suggestions.length, 2);
});
