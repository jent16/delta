// The web server's entry point. All wiring lives in compose.ts.

import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createApp } from "./api/app.ts";
import { composeTracker } from "./compose.ts";
import { backupIfStale } from "./db/backup.ts";

const { db, backupDir, applications, lists, imports, exports, companies, contacts, settings, linkedin, insights, auth, profile, interests, migrationsApplied, preMigrationBackup } = composeTracker({
  dataDir: process.env.DELTA_DATA_DIR ?? join(process.cwd(), "var"),
});
if (preMigrationBackup) console.log(`backed up before migrating: ${preMigrationBackup.file}`);
if (migrationsApplied.length) console.log(`applied migrations: ${migrationsApplied.join(", ")}`);

// Automatic safety net: a fresh backup at startup and then every few hours while the server runs,
// whenever the newest one is more than 12 hours old. The newest 30 are kept.
const autoBackup = () => {
  try {
    const made = backupIfStale(db, backupDir, { maxAgeHours: 12, keep: 30 });
    if (made) console.log(`backup: ${made.file} (${made.applications} applications)`);
  } catch (e) {
    console.error("automatic backup FAILED:", e instanceof Error ? e.message : e); // loud, but never takes the server down
  }
};
autoBackup();
setInterval(autoBackup, 6 * 3_600_000).unref();

const app = createApp({ applications, lists, imports, exports, companies, contacts, settings, linkedin, insights, auth, profile, interests, secureCookies: process.env.TRACKER_SECURE_COOKIES === "1", webRoot: fileURLToPath(new URL("./web/", import.meta.url)) });
const port = Number(process.env.TRACKER_PORT) || 3001;
// Listen on this machine only by default. (Without a host, Node accepts connections from the whole network.)
// There is a login now, but it travels in clear text over plain http, so only set TRACKER_HOST behind https
// (and then also TRACKER_SECURE_COOKIES=1). Claim your account here first, then consider TRACKER_ALLOW_SIGNUP=false.
const host = process.env.TRACKER_HOST || "127.0.0.1";
const server = app.listen(port, host, () => console.log(`Tracker on http://${host === "127.0.0.1" ? "localhost" : host}:${port}`));

// Stopping the server (Ctrl+C) closes the database cleanly, which removes its -wal/-shm files.
// Restore treats those files as "the server is running", so leaving them behind would cause false alarms.
const shutdown = () => {
  server.close();
  db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
