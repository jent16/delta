// Composition: builds every object the tracker needs and hands each its
// dependencies. Both entry points (the web server in main.ts and the import
// command line tool) call this, so they can never be wired differently.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "./db/connection.ts";
import { migrate } from "./db/migrate.ts";
import { createNotionSource } from "./importers/notion.ts";
import { createApplicationRepository } from "./repositories/applications.ts";
import { createImportLedger } from "./repositories/import-ledger.ts";
import { createListRepository } from "./repositories/lists.ts";
import { createApplicationService } from "./services/applications.ts";
import { createImportService } from "./services/import.ts";
import { createListService } from "./services/lists.ts";

export function composeTracker(opts: { dataDir: string; env?: NodeJS.ProcessEnv }) {
  const env = opts.env ?? process.env;
  // User data lives in its own file, apart from the rebuildable delta.db:
  // you can delete delta.db any time; never delete this one.
  mkdirSync(opts.dataDir, { recursive: true });
  const db = openDatabase(join(opts.dataDir, "tracker.db"));
  const migrationsApplied = migrate(db);

  const clock = () => new Date();
  const applicationRepo = createApplicationRepository(db);
  const applications = createApplicationService({ repo: applicationRepo, clock });
  const lists = createListService({ lists: createListRepository(db), applications: applicationRepo, clock });
  const imports = createImportService({
    sources: { notion: (database) => createNotionSource({ token: env.NOTION_TOKEN, database, baseUrl: env.NOTION_BASE_URL }) },
    applications,
    repo: applicationRepo,
    ledger: createImportLedger(db),
    clock,
  });
  return { db, applications, lists, imports, migrationsApplied };
}
