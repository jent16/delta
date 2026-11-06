// Command-line importer:
//   npm run import:notion -- <database link or id> --function SWE [--sector Fintech] [--commit]
//
// Without --commit it only PREVIEWS: nothing is written. Safe to run as often as you like.

import { join } from "node:path";
import { composeTracker } from "./compose.ts";
import { createBackup } from "./db/backup.ts";
import { ValidationError } from "./domain/errors.ts";
import type { PlanItem } from "./services/import.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const commit = args.includes("--commit");
const database = args.find((a, i) => !a.startsWith("--") && !(args[i - 1]?.startsWith("--") && args[i - 1] !== "--commit"));

if (!database) {
  console.error("usage: npm run import:notion -- <database link or id> --function SWE|PM|Data|Quant|Design|Other [--sector <sector>] [--commit]");
  process.exit(2);
}

const { imports, db, backupDir } = composeTracker({ dataDir: process.env.DELTA_DATA_DIR ?? join(process.cwd(), "var") });
const request = { database, roleFunction: flag("function"), sector: flag("sector") };

const SYMBOL: Record<string, string> = { create: "+", already_imported: "=", duplicate: "~", invalid: "!" };
const line = (i: PlanItem): string => {
  const name = `${i.company || "(no company)"} — ${i.roleTitle || "(no role)"}`;
  const bits = [i.status, i.appliedOn && `applied ${i.appliedOn}`, i.sector && `${i.sector}${i.sectorGuessed ? " (guessed)" : ""}`].filter(Boolean).join(", ");
  const base = `  ${SYMBOL[i.action]} ${name}${bits ? `  [${bits}]` : ""}`;
  return [base, i.reason && `      ${i.reason}`, ...i.warnings.map((w) => `      note: ${w}`)].filter(Boolean).join("\n");
};

try {
  if (commit) {
    const b = createBackup(db, backupDir, { label: "pre-import" });
    console.log(`backed up first: ${b.file} (${b.applications} applications)`);
  }
  const result = commit ? await imports.commit(1, request) : await imports.preview(1, request);
  for (const action of ["create", "invalid", "duplicate", "already_imported"] as const) {
    const items = result.items.filter((i) => i.action === action);
    if (items.length) console.log(`\n${{ create: commit ? "Created" : "Would create", invalid: "Cannot import (fix in Notion, then re-run)", duplicate: "Skipped as duplicates", already_imported: "Already imported" }[action]} (${items.length})`);
    for (const i of items) console.log(line(i));
  }
  const s = result.summary;
  console.log(`\n${s.total} rows: ${s.create} ${commit ? "created" : "to create"}, ${s.duplicate} duplicate, ${s.invalid} invalid, ${s.alreadyImported} already imported.`);
  if (s.withoutSector) console.log(`${s.withoutSector} ${commit ? "were" : "would be"} created with no sector, so they won't appear in sector-based lists like Fintech-adjacent until you set one.`);
  if (!commit && s.create) console.log("\nNothing was written. Re-run with --commit to import.");
} catch (e) {
  if (e instanceof ValidationError) console.error(e.issues.map((i) => `${i.field}: ${i.message}`).join("\n"));
  else console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  db.close(); // closing the last connection removes the -wal/-shm files; leaving them looks like "server running" to restore
}
