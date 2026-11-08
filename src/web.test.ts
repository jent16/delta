import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

// The web UI is plain files with no build step, so nothing compiles them or type-checks them. These tests
// are the safety net: they read the files as text and enforce the rules the UI's security and structure rest on.
// (How it LOOKS is checked by looking at it; these only guard what must never regress.)

const WEB = new URL("./web/", import.meta.url).pathname;
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
const files = walk(WEB);
const js = files.filter((f) => f.endsWith(".js"));
const read = (f: string) => readFileSync(f, "utf8");
const rel = (f: string) => relative(WEB, f);
const html = read(join(WEB, "index.html"));
const css = read(join(WEB, "styles.css"));

// comments may legitimately mention banned things ("never innerHTML"); strip them before scanning code
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

test("the UI never turns text into HTML: no innerHTML, outerHTML, insertAdjacentHTML, document.write, eval or Function()", () => {
  const banned = /\.(innerHTML|outerHTML)\b|insertAdjacentHTML|document\.write|\beval\s*\(|new\s+Function\s*\(|javascript:/;
  const hits = js.filter((f) => banned.test(code(f))).map(rel);
  assert.deepEqual(hits, []);
});

test("nothing is set through a style attribute (the page policy forbids inline styles); CSS custom properties are set through the CSSOM instead", () => {
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  assert.doesNotMatch(html, /<style[\s>]/i);
  const hits = js.filter((f) => /setAttribute\(\s*["']style["']|\.cssText|\.setAttribute\(\s*["']style/.test(code(f))).map(rel);
  assert.deepEqual(hits, []);
  assert.deepEqual(js.filter((f) => /\bstyle:\s*["'`]/.test(code(f))).map(rel), []); // h("div", { style: "..." }) would become an attribute
});

test("the page loads only its own files: every script has a src, and nothing points at another site", () => {
  for (const m of html.matchAll(/<script\b([^>]*)>/gi)) assert.match(m[1]!, /\bsrc=/, `inline script: <script${m[1]}>`);
  const urlish = /(?:https?:)?\/\/(?!www\.w3\.org\/2000\/svg)[a-z0-9.-]+\.[a-z]{2,}/i;
  assert.doesNotMatch(html.replace(/<!--[\s\S]*?-->/g, ""), urlish);
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ""), urlish);
  assert.deepEqual(js.filter((f) => urlish.test(code(f))).map(rel), []);
  assert.doesNotMatch(css, /@import|@font-face/); // fonts are the system's until they are self-hosted, so no outside request
});

// `import x from "./a.js"`, a bare `import "./a.js"`, and a dynamic `import("./a.js")`
const IMPORT = /(?:from\s+|import\s*\(\s*|import\s+)["'](\.[^"']+)["']/g;

test("every relative import resolves to a real file", () => {
  const missing: string[] = [];
  for (const f of js) for (const m of code(f).matchAll(IMPORT)) if (!existsSync(resolve(dirname(f), m[1]!))) missing.push(`${rel(f)} -> ${m[1]}`);
  assert.deepEqual(missing, []);
  for (const m of html.matchAll(/(?:src|href)="([^"#:]+)"/g)) if (!m[1]!.startsWith("data")) assert.ok(existsSync(join(WEB, m[1]!)), `index.html references ${m[1]}`);
});

test("the UI has layers too: shared pieces never import screens or the app shell, and screens never import the shell", () => {
  const bad: string[] = [];
  for (const f of js) {
    const layer = rel(f).split(sep)[0]!;
    for (const m of code(f).matchAll(IMPORT)) {
      const target = rel(resolve(dirname(f), m[1]!));
      if (layer === "lib" && (target.startsWith("views") || target === "app.js")) bad.push(`${rel(f)} imports ${target}`);
      if (layer === "views" && target === "app.js") bad.push(`${rel(f)} imports ${target}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("every element the code looks up by id exists in the page or is created by the code", () => {
  const all = js.map(code).join("\n");
  const wanted = new Set([...all.matchAll(/\$\(\s*["']#([\w-]+)["']/g)].map((m) => m[1]!));
  const known = new Set([...html.matchAll(/\bid="([\w-]+)"/g)].map((m) => m[1]!));
  for (const m of all.matchAll(/\bid:\s*["']([\w-]+)["']/g)) known.add(m[1]!);
  assert.deepEqual([...wanted].filter((id) => !known.has(id)), []);
});

test("hidden things stay hidden: a class that sets `display` must not defeat the hidden attribute", () => {
  // the 'dead close button' bug: .drawer { display: flex } beat [hidden], so a closed panel stayed on screen and blocked clicks
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
});

test("the stylesheet is well-formed and every design/mode the menu offers has CSS", () => {
  assert.equal((css.match(/\{/g) ?? []).length, (css.match(/\}/g) ?? []).length, "unbalanced braces");
  const theme = read(join(WEB, "lib/theme.js"));
  const init = read(join(WEB, "theme-init.js"));
  const designs = [...theme.matchAll(/\[\s*"(\w+)"\s*,\s*"[^"]+"\s*\]/g)].map((m) => m[1]!).filter((v) => !["system", "light", "dark"].includes(v));
  assert.ok(designs.length >= 2);
  for (const d of designs) {
    assert.ok(d === "soft" || css.includes(`[data-design="${d}"]`), `no CSS for design "${d}"`);
    assert.ok(init.includes(`"${d}"`), `theme-init.js does not know design "${d}", so it would flash the default before applying it`);
  }
  // dark mode must exist for EVERY design, both when forced (data-theme="dark") and when the device asks for it
  assert.match(css, /prefers-color-scheme:\s*dark/);
  for (const d of designs) {
    const forced = d === "soft" ? /:root\[data-theme="dark"\]\s*\{/ : new RegExp(`:root\\[data-theme="dark"\\]\\[data-design="${d}"\\]\\s*\\{`);
    const system = d === "soft" ? /:root:not\(\[data-theme="light"\]\)\s*\{/ : new RegExp(`:root:not\\(\\[data-theme="light"\\]\\)\\[data-design="${d}"\\]\\s*\\{`);
    assert.match(css, forced, `no forced-dark CSS for "${d}"`);
    assert.match(css, system, `no device-dark CSS for "${d}"`);
  }
});

test("the pieces a screen needs exist: the page has the containers app.js draws into", () => {
  for (const id of ["topbar", "view", "scrim", "drawer", "modal", "bulk", "toast"]) assert.match(html, new RegExp(`id="${id}"`), id);
});
