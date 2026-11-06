import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSimplifyDirectory } from "./simplify.ts";

const sources = ["https://x/Summer2027-Internships/a.json", "https://x/New-Grad-Positions/b.json"];
function fake(responses: Record<string, unknown> | "fail") {
  let calls = 0;
  const fetchImpl = (async (url: string) => {
    calls++;
    if (responses === "fail") throw new Error("offline");
    const body = responses[url];
    return body === undefined ? { ok: false, status: 404, json: async () => ({}) } : { ok: true, status: 200, json: async () => body };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}
function sandbox(run: (cacheFile: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "simplify-"));
  return run(join(dir, "cache", "companies.json")).finally(() => rmSync(dir, { recursive: true, force: true }));
}
const DATA = {
  [sources[0]!]: [{ company_name: "Stripe", active: true }, { company_name: "  Figma ", active: false }, { company_name: "" }, { nope: 1 }, { company_name: 42 }],
  [sources[1]!]: [{ company_name: "stripe" }, { company_name: "Airbnb" }],
};

test("collects names from both lists, including closed postings; dedupes ignoring case; ignores junk; sorted", async () => {
  await sandbox(async (cacheFile) => {
    const { fetchImpl } = fake(DATA);
    const r = await createSimplifyDirectory({ cacheFile, fetchImpl, sources }).names();
    assert.deepEqual(r, { names: ["Airbnb", "Figma", "Stripe"], available: true });
    assert.deepEqual(JSON.parse(readFileSync(cacheFile, "utf8")).names, ["Airbnb", "Figma", "Stripe"]);
    assert.ok(!existsSync(`${cacheFile}.tmp`)); // written atomically, no temp file left
  });
});

test("a fresh cache is used without touching the network; a stale one is refreshed", async () => {
  await sandbox(async (cacheFile) => {
    let clock = 1_000_000;
    const first = fake(DATA);
    await createSimplifyDirectory({ cacheFile, fetchImpl: first.fetchImpl, sources, now: () => clock, maxAgeHours: 24 }).names();
    assert.equal(first.calls(), 2);

    clock += 23 * 3_600_000;
    const second = fake(DATA); // a NEW directory object: proves it reads the file, not memory
    assert.equal((await createSimplifyDirectory({ cacheFile, fetchImpl: second.fetchImpl, sources, now: () => clock, maxAgeHours: 24 }).names()).names.length, 3);
    assert.equal(second.calls(), 0);

    clock += 2 * 3_600_000; // now 25h old
    const third = fake({ ...DATA, [sources[1]!]: [{ company_name: "Brand New Co" }] });
    const r = await createSimplifyDirectory({ cacheFile, fetchImpl: third.fetchImpl, sources, now: () => clock, maxAgeHours: 24 }).names();
    assert.equal(third.calls(), 2);
    assert.ok(r.names.includes("Brand New Co"));
  });
});

test("when a refresh fails the stale copy is used and the caller is told; with no copy it degrades instead of throwing", async () => {
  await sandbox(async (cacheFile) => {
    const dirObj = (fetchImpl: typeof fetch, now: number) => createSimplifyDirectory({ cacheFile, fetchImpl, sources, now: () => now, maxAgeHours: 1 });
    await assert.doesNotReject(async () => {
      const none = await dirObj(fake("fail").fetchImpl, 0).names();
      assert.deepEqual([none.names, none.available], [[], false]);
      assert.match(none.note!, /only companies already in your tracker/);
    });
    await dirObj(fake(DATA).fetchImpl, 0).names(); // populate the cache at t=0
    const stale = await dirObj(fake("fail").fetchImpl, 10 * 3_600_000).names();
    assert.deepEqual([stale.names.length, stale.available], [3, true]);
    assert.match(stale.note!, /using the copy from/);
    const http404 = await dirObj(fake({}).fetchImpl, 10 * 3_600_000).names();
    assert.match(http404.note!, /404/);
  });
});
