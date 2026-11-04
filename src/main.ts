// The web server's entry point. All wiring lives in compose.ts.

import { join } from "node:path";
import { createApp } from "./api/app.ts";
import { composeTracker } from "./compose.ts";

const { applications, lists, imports, migrationsApplied } = composeTracker({ dataDir: process.env.DELTA_DATA_DIR ?? join(process.cwd(), "var") });
if (migrationsApplied.length) console.log(`applied migrations: ${migrationsApplied.join(", ")}`);

const app = createApp({ applications, lists, imports, currentUserId: () => 1 });
const port = Number(process.env.TRACKER_PORT) || 3001;
app.listen(port, () => console.log(`Tracker API on http://localhost:${port}`));
