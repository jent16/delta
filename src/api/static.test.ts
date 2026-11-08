import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createApp } from "./app.ts";
import { makeTracker } from "../testing/harness.ts";

// The web UI is plain static files served by the same process. What matters here is not the files
// themselves but the guard rails around them: the security headers, and that the API is untouched.

async function serve(webRoot: string | undefined) {
  const t = makeTracker();
  const app = createApp({ applications: t.service, lists: t.lists, imports: t.imports, exports: t.exports, companies: t.companies, contacts: t.contacts, settings: t.settings, linkedin: t.linkedin, insights: t.insights, currentUserId: () => 1, webRoot });
  const server = await new Promise<import("node:http").Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
}
const siteWith = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "delta-web-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
};

test("pages are served with a policy that allows only this server's own scripts and styles, and no framing", async (t) => {
  const s = await serve(siteWith({ "index.html": "<!doctype html><title>x</title>", "app.js": "1" }));
  t.after(() => s.close());
  for (const path of ["/", "/index.html", "/app.js"]) {
    const res = await fetch(s.base + path);
    assert.equal(res.status, 200, path);
    const csp = res.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'(;|$)/);       // no 'unsafe-inline', no 'unsafe-eval'
    assert.match(csp, /style-src 'self'(;|$)/);
    assert.match(csp, /connect-src 'self'/);           // the page can't send your data elsewhere
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /unsafe-/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  }
});

test("the API still answers when the UI is served, and gets no page headers; unknown paths are 404", async (t) => {
  const s = await serve(siteWith({ "index.html": "<!doctype html>" }));
  t.after(() => s.close());
  const api = await fetch(s.base + "/api/lists");
  assert.equal(api.status, 200);
  assert.equal(api.headers.get("content-security-policy"), null);
  assert.equal((await fetch(s.base + "/nope.html")).status, 404);
  const missing = await fetch(s.base + "/api/nope");
  assert.equal(missing.status, 404);
  // the page rules are for pages, not API replies (Express adds its own strict policy to a plain 404, so look at headers only we set)
  assert.equal(missing.headers.get("referrer-policy"), null);
  assert.doesNotMatch(missing.headers.get("content-security-policy") ?? "", /script-src/);
});

test("without a web root nothing is served at /, so API-only tests and deployments are unchanged", async (t) => {
  const s = await serve(undefined);
  t.after(() => s.close());
  assert.equal((await fetch(s.base + "/")).status, 404);
  assert.equal((await fetch(s.base + "/api/lists")).status, 200);
});

test("files outside the web root cannot be reached with ../", async (t) => {
  const s = await serve(siteWith({ "index.html": "ok" }));
  t.after(() => s.close());
  const res = await fetch(s.base + "/%2e%2e/%2e%2e/etc/hosts");
  assert.notEqual(res.status, 200);
});
