// The composition root: the ONE file that knows about every layer and wires
// them together. Everything else receives its dependencies as arguments.
// That's what "dependency injection" means here — no framework, just a file
// where the objects get built and handed to each other.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "./api/app.ts";
import { openDatabase } from "./db/connection.ts";
import { migrate } from "./db/migrate.ts";
import { createApplicationRepository } from "./repositories/applications.ts";
import { createListRepository } from "./repositories/lists.ts";
import { createApplicationService } from "./services/applications.ts";
import { createListService } from "./services/lists.ts";

// User data lives in its own file, apart from the rebuildable delta.db:
// you can delete delta.db any time; never delete this one.
const dataDir = process.env.DELTA_DATA_DIR ?? join(process.cwd(), "var");
mkdirSync(dataDir, { recursive: true });
const db = openDatabase(join(dataDir, "tracker.db"));
const applied = migrate(db);
if (applied.length) console.log(`applied migrations: ${applied.join(", ")}`);

const clock = () => new Date();
const applicationRepo = createApplicationRepository(db);
const applications = createApplicationService({ repo: applicationRepo, clock });
const lists = createListService({ lists: createListRepository(db), applications: applicationRepo, clock });
const app = createApp({ applications, lists, currentUserId: () => 1 });

const port = Number(process.env.TRACKER_PORT) || 3001;
app.listen(port, () => console.log(`Tracker API on http://localhost:${port}`));
