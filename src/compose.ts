// Composition: builds every object the tracker needs and hands each its
// dependencies. Both entry points (the web server in main.ts and the import
// command line tool) call this, so they can never be wired differently.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createBackup } from "./db/backup.ts";
import type { BackupInfo } from "./db/backup.ts";
import { openDatabase } from "./db/connection.ts";
import { migrate } from "./db/migrate.ts";
import { createSimplifyDirectory } from "./importers/simplify.ts";
import { createNotionSource } from "./importers/notion.ts";
import { createApplicationRepository } from "./repositories/applications.ts";
import { createCompanyRepository } from "./repositories/companies.ts";
import { createContactRepository } from "./repositories/contacts.ts";
import { createSettingsRepository } from "./repositories/settings.ts";
import { createContactImportLedger, createImportLedger } from "./repositories/import-ledger.ts";
import { createListRepository } from "./repositories/lists.ts";
import { createApplicationService } from "./services/applications.ts";
import { createCompanyService } from "./services/companies.ts";
import { createContactService, createSettingsService } from "./services/contacts.ts";
import { createExportService } from "./services/export.ts";
import { createInsightsService } from "./services/insights.ts";
import { createImportService } from "./services/import.ts";
import { createLinkedInImportService } from "./services/linkedin-import.ts";
import { createListService } from "./services/lists.ts";

export function composeTracker(opts: { dataDir: string; env?: NodeJS.ProcessEnv }) {
  const env = opts.env ?? process.env;
  // User data lives in its own file, apart from the rebuildable delta.db:
  // you can delete delta.db any time; never delete this one.
  mkdirSync(opts.dataDir, { recursive: true });
  const dbFile = join(opts.dataDir, "tracker.db");
  // Backups default to var/backups. Point DELTA_BACKUP_DIR at a synced folder
  // (iCloud Drive, Dropbox) to also survive losing this disk.
  const backupDir = env.DELTA_BACKUP_DIR ?? join(opts.dataDir, "backups");
  const db = openDatabase(dbFile);
  // A migration rewrites your tables, so an existing database is backed up first.
  let preMigrationBackup: BackupInfo | null = null;
  const migrationsApplied = migrate(db, undefined, {
    beforeApply: (pending) => {
      preMigrationBackup = createBackup(db, backupDir, { label: `pre-migration-${pending[0]}` });
    },
  });

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
  const listRepo = createListRepository(db);
  const companyRepo = createCompanyRepository(db);
  const contactRepo = createContactRepository(db);
  const settings = createSettingsService({ settings: createSettingsRepository(db) });
  const contacts = createContactService({ contacts: contactRepo, applications: applicationRepo, settings, clock });
  // importing writes many rows, so an automatic backup is taken just before (labelled, so pruning never deletes it)
  const linkedin = createLinkedInImportService({ companies: companyRepo, contacts: contactRepo, contactService: contacts, ledger: createContactImportLedger(db), clock, beforeCommit: () => { createBackup(db, backupDir, { label: "pre-import" }); } });
  const exports = createExportService({ applications: applicationRepo, lists: listRepo, companies: companyRepo, contacts: contactRepo, clock });
  const companies = createCompanyService({
    companies: companyRepo,
    clock,
    directory: createSimplifyDirectory({ cacheFile: join(opts.dataDir, "cache", "companies.json") }),
  });
  const insights = createInsightsService({ applications: applicationRepo, lists: listRepo, contacts: contactRepo, clock });
  return { db, dbFile, backupDir, applications, lists, imports, exports, companies, contacts, settings, linkedin, insights, migrationsApplied, preMigrationBackup: preMigrationBackup as BackupInfo | null };
}
