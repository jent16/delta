// Look after your data:
//   npm run backup                       take a verified backup now
//   npm run backups                      list backups
//   npm run restore -- <name|path> [--yes]   put a backup back (previews without --yes)
//   npm run export -- [--format json|csv] [--out file]   a readable copy of your applications
//
// Stop `npm run tracker` before restoring.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { composeTracker } from "./compose.ts";
import { createBackup, inspectDatabase, listBackups, pruneBackups, restoreBackup } from "./db/backup.ts";

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const dataDir = process.env.DELTA_DATA_DIR ?? join(process.cwd(), "var");
const kb = (n: number) => (n < 1_048_576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1_048_576).toFixed(1)} MB`);
const ago = (d: Date) => {
  const h = (Date.now() - d.getTime()) / 3_600_000;
  return h < 1 ? `${Math.round(h * 60)} min ago` : h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} days ago`;
};

function usage(): never {
  console.error("usage: npm run backup | backups | restore -- <name|path> [--yes] | export -- [--format json|csv] [--out file]");
  process.exit(2);
}

try {
  switch (command) {
    case "backup": {
      const t = composeTracker({ dataDir });
      const b = createBackup(t.db, t.backupDir, { label: flag("label") });
      pruneBackups(t.backupDir, 30);
      console.log(`Backed up ${b.applications} applications and ${b.statusEvents} status events (${kb(b.bytes)}), verified.\n  ${b.file}`);
      console.log("\nThis is on the same disk as your data. To survive losing the disk, set DELTA_BACKUP_DIR to a synced folder (iCloud Drive, Dropbox) or copy the file somewhere else now and then.");
      break;
    }
    case "backups": {
      const dir = composeTracker({ dataDir }).backupDir;
      const all = listBackups(dir);
      if (!all.length) console.log(`No backups in ${dir}. Run: npm run backup`);
      for (const b of all) console.log(`  ${b.name.padEnd(48)} ${kb(b.bytes).padStart(8)}   ${ago(b.createdAt)}${b.labelled ? "   (kept)" : ""}`);
      if (all.length) console.log(`\n${all.length} backup(s) in ${dir}`);
      break;
    }
    case "restore": {
      const arg = rest.find((a, i) => !a.startsWith("--") && !(rest[i - 1]?.startsWith("--") && rest[i - 1] !== "--yes"));
      if (!arg) usage();
      const t = composeTracker({ dataDir });
      const file = isAbsolute(arg) || arg.includes("/") ? resolve(arg) : join(t.backupDir, arg);
      const info = inspectDatabase(file);
      if (!info.ok) throw new Error(`cannot restore: ${info.problem}`);
      const now = t.db.prepare("SELECT (SELECT COUNT(*) FROM applications) AS a, (SELECT COUNT(*) FROM status_events) AS e").get() as { a: number; e: number };
      console.log(`Current database : ${now.a} applications, ${now.e} status events`);
      console.log(`Backup           : ${info.applications} applications, ${info.statusEvents} status events  (${file})`);
      if (!rest.includes("--yes")) {
        console.log("\nNothing changed. To restore, stop `npm run tracker`, then re-run with --yes. Your current database is saved first.");
        break;
      }
      t.db.close(); // release our own handle; a leftover -wal file would otherwise look like a running server
      const r = restoreBackup({ backupFile: file, targetFile: t.dbFile, safetyDir: t.backupDir });
      console.log(`\nRestored. ${r.safetyCopy ? `Your previous database was saved as ${r.safetyCopy}` : ""}`);
      break;
    }
    case "export": {
      const t = composeTracker({ dataDir });
      const format = flag("format") ?? "json";
      if (format !== "json" && format !== "csv") usage();
      const { filename, body } = format === "csv" ? t.exports.csv(1) : t.exports.json(1);
      const out = flag("out") ?? join(dataDir, "exports", filename);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, format === "csv" ? (body as string) : JSON.stringify(body, null, 2) + "\n");
      console.log(`Exported to ${out}`);
      break;
    }
    default:
      usage();
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
