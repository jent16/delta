// The dependency rule, enforced. Architecture advice that lives only in a
// document erodes the first time someone is in a hurry; a failing test doesn't.
//
// Allowed imports (anything else fails):
//   domain        -> domain only                       (pure rules; knows nothing outside itself)
//   db            -> db only
//   repositories  -> domain, db                        (SQL; implements domain ports)
//   services      -> domain                            (use-cases; talk to storage via a PORT, never SQL)
//   importers     -> domain                            (adapters to outside systems, e.g. Notion)
//   api           -> services, domain                  (HTTP translation)
//   files at the top of src/, and testing/  -> anything (entry points, composition, test wiring)

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname, sep } from "node:path";

const SRC = new URL(".", import.meta.url).pathname;

const ALLOWED: Record<string, string[]> = {
  domain: ["domain"],
  db: ["db"],
  repositories: ["domain", "db", "repositories"],
  importers: ["domain", "importers"],
  services: ["domain", "services"],
  api: ["services", "domain", "api"],
  web: ["web"], // the browser UI is plain JS; only .d.ts files (types for its pure helpers) are TypeScript, and they import nothing
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

// three ways a file can depend on another: `import x from "..."` / `export ... from "..."`,
// a bare side-effect `import "..."`, and a dynamic `import("...")`
const IMPORT = /(?:(?:import|export)\s[^;]*?from\s+|\bimport\s*\(?\s*)["'](\.[^"']+)["']/g;

test("every layer imports only from the layers it is allowed to", () => {
  const violations: string[] = [];
  for (const file of walk(SRC)) {
    const rel = relative(SRC, file);
    const layer = rel.split(sep)[0]!;
    const allowed = ALLOWED[layer];
    if (!rel.includes(sep) || layer === "testing") continue; // entry points at the top of src/, and test wiring, are free
    if (!allowed) {
      // a new directory must be given a place in the rules, not silently exempted
      violations.push(`${rel}: "${layer}/" is not a known layer — add it to ALLOWED`);
      continue;
    }
    if (rel.endsWith(".test.ts") && layer === "services") continue; // service tests use the harness to wire a real DB
    if (rel.endsWith(".test.ts") && layer === "api") continue;
    if (rel.endsWith(".test.ts") && layer === "db") continue;
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(IMPORT)) {
      const target = relative(SRC, resolve(dirname(file), m[1]!));
      const targetLayer = target.split(sep)[0]!;
      if (!allowed.includes(targetLayer)) violations.push(`${rel} imports ${target} (${layer} may not depend on ${targetLayer})`);
    }
  }
  assert.deepEqual(violations, []);
});

test("the import scanner recognises every import form", () => {
  const found = (src: string) => [...src.matchAll(IMPORT)].map((m) => m[1]);
  assert.deepEqual(found(`import { a } from "./a.ts";`), ["./a.ts"]);
  assert.deepEqual(found(`import type { A } from "../x/a.ts";`), ["../x/a.ts"]);
  assert.deepEqual(found(`export * from "./b.ts";`), ["./b.ts"]);
  assert.deepEqual(found(`import "./side-effect.ts";`), ["./side-effect.ts"]);
  assert.deepEqual(found(`const m = await import("./lazy.ts");`), ["./lazy.ts"]);
  assert.deepEqual(found(`import express from "express";`), []); // packages aren't layers
});

test("the rule has teeth: it knows the layers that exist", () => {
  const layers = readdirSync(SRC).filter((n) => statSync(join(SRC, n)).isDirectory());
  for (const l of Object.keys(ALLOWED)) assert.ok(layers.includes(l), `${l}/ exists`);
});
