// Test wiring: a real in-memory database, real migrations, real repository and
// service — only the clock is fake. Nothing is mocked that could hide a bug in
// the SQL, which is exactly what a mocked repository would do.

import { createApp } from "../api/app.ts";
import { openDatabase } from "../db/connection.ts";
import { migrate } from "../db/migrate.ts";
import { createApplicationRepository } from "../repositories/applications.ts";
import { createCompanyRepository } from "../repositories/companies.ts";
import { createContactRepository } from "../repositories/contacts.ts";
import { createSettingsRepository } from "../repositories/settings.ts";
import { createResumeVersionRepository } from "../repositories/resume-versions.ts";
import { createSessionRepository, createUserRepository } from "../repositories/users.ts";
import { createScryptHasher } from "../domain/password.ts";
import type { LoginThrottle } from "../domain/auth.ts";
import { createContactImportLedger, createImportLedger } from "../repositories/import-ledger.ts";
import { createListRepository } from "../repositories/lists.ts";
import { createAuthService, createProfileService } from "../services/accounts.ts";
import { createApplicationService } from "../services/applications.ts";
import { createCompanyService } from "../services/companies.ts";
import { createContactService, createSettingsService } from "../services/contacts.ts";
import { createExportService } from "../services/export.ts";
import { createInsightsService } from "../services/insights.ts";
import { createImportService } from "../services/import.ts";
import type { CompanyDirectory } from "../domain/ports.ts";
import type { SourceFactory } from "../services/import.ts";
import { createLinkedInImportService } from "../services/linkedin-import.ts";
import { createListService } from "../services/lists.ts";

export function makeTracker(startAt = new Date(2026, 8, 15, 12, 0, 0), sources?: SourceFactory, directory?: CompanyDirectory, accountOptions: { allowSignup?: boolean; throttle?: LoginThrottle } = {}) {
  let current = startAt;
  const clock = () => current;
  const db = openDatabase(":memory:");
  migrate(db);
  const applicationRepo = createApplicationRepository(db);
  const service = createApplicationService({ repo: applicationRepo, clock });
  const lists = createListService({ lists: createListRepository(db), applications: applicationRepo, clock });
  const imports = createImportService({
    sources: sources ?? { notion: () => { throw new Error("no import source wired for this test"); } },
    applications: service,
    repo: applicationRepo,
    ledger: createImportLedger(db),
    clock,
  });
  const listRepo = createListRepository(db);
  const companyRepo = createCompanyRepository(db);
  const contactRepo = createContactRepository(db);
  const settings = createSettingsService({ settings: createSettingsRepository(db) });
  const contacts = createContactService({ contacts: contactRepo, applications: applicationRepo, settings, clock });
  const linkedinBackups: number[] = []; // counts how many times the "back up first" hook ran
  const linkedin = createLinkedInImportService({ companies: companyRepo, contacts: contactRepo, contactService: contacts, ledger: createContactImportLedger(db), clock, beforeCommit: () => { linkedinBackups.push(1); } });
  const exports = createExportService({ applications: applicationRepo, lists: listRepo, companies: companyRepo, contacts: contactRepo, clock });
  const companies = createCompanyService({ companies: companyRepo, clock, directory: directory ?? { names: async () => ({ names: [], available: true }) } });
  const insights = createInsightsService({ applications: applicationRepo, lists: listRepo, contacts: contactRepo, clock });
  const users = createUserRepository(db);
  const sessions = createSessionRepository(db);
  const deletions: number[] = []; // counts how many times the "back up first" hook ran before an account deletion
  // a deliberately cheap hash cost: the tests are about behaviour, not about being slow
  const auth = createAuthService({ users, sessions, hasher: createScryptHasher({ N: 1024, r: 8, p: 1 }), clock, ...accountOptions, beforeDelete: () => { deletions.push(1); } });
  const profile = createProfileService({ users, settings: createSettingsRepository(db), versions: createResumeVersionRepository(db), clock });
  return {
    db,
    users,
    sessions,
    auth,
    profile,
    deletions,
    service,
    companyRepo,
    contactRepo,
    contacts,
    settings,
    linkedin,
    linkedinBackups,
    companies,
    insights,
    lists,
    imports,
    exports,
    clock,
    /** Moves the fake clock forward, so tests can create "history". */
    advance(days: number) {
      current = new Date(current.getTime() + days * 86_400_000);
    },
  };
}

export async function startApi(userId = 1, sources?: SourceFactory, directory?: CompanyDirectory) {
  const t = makeTracker(undefined, sources, directory);
  const app = createApp({ applications: t.service, lists: t.lists, imports: t.imports, exports: t.exports, companies: t.companies, contacts: t.contacts, settings: t.settings, linkedin: t.linkedin, insights: t.insights, profile: t.profile, currentUserId: () => userId });
  const server = await new Promise<import("node:http").Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as import("node:net").AddressInfo;
  const base = `http://localhost:${port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { ...t, base, call, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/**
 * The API the way production runs it: real sign-in, no fixed user. `call` behaves like a browser: it keeps the cookie
 * between requests (use `fresh()` for a second, separate browser).
 */
export async function startAuthApi(accountOptions: { allowSignup?: boolean; throttle?: LoginThrottle } = {}, secureCookies = false) {
  const t = makeTracker(undefined, undefined, undefined, accountOptions);
  const app = createApp({ applications: t.service, lists: t.lists, imports: t.imports, exports: t.exports, companies: t.companies, contacts: t.contacts, settings: t.settings, linkedin: t.linkedin, insights: t.insights, profile: t.profile, auth: t.auth, secureCookies });
  const server = await new Promise<import("node:http").Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as import("node:net").AddressInfo;
  const base = `http://localhost:${port}`;
  const browser = () => {
    let cookie = "";
    const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await fetch(base + path, {
        method,
        headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get("set-cookie");
      if (set) cookie = /^delta_session=;/.test(set) ? "" : set.split(";")[0]!;
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers, setCookie: set };
    };
    return { call, get cookie() { return cookie; }, set cookie(v: string) { cookie = v; } };
  };
  return { ...t, base, browser, close: () => new Promise<void>((r) => server.close(() => r())) };
}
