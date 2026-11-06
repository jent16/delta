// Test wiring: a real in-memory database, real migrations, real repository and
// service — only the clock is fake. Nothing is mocked that could hide a bug in
// the SQL, which is exactly what a mocked repository would do.

import { createApp } from "../api/app.ts";
import { openDatabase } from "../db/connection.ts";
import { migrate } from "../db/migrate.ts";
import { createApplicationRepository } from "../repositories/applications.ts";
import { createImportLedger } from "../repositories/import-ledger.ts";
import { createListRepository } from "../repositories/lists.ts";
import { createApplicationService } from "../services/applications.ts";
import { createExportService } from "../services/export.ts";
import { createImportService } from "../services/import.ts";
import type { SourceFactory } from "../services/import.ts";
import { createListService } from "../services/lists.ts";

export function makeTracker(startAt = new Date(2026, 8, 15, 12, 0, 0), sources?: SourceFactory) {
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
  const exports = createExportService({ applications: applicationRepo, lists: listRepo, clock });
  return {
    db,
    service,
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

export async function startApi(userId = 1, sources?: SourceFactory) {
  const t = makeTracker(undefined, sources);
  const app = createApp({ applications: t.service, lists: t.lists, imports: t.imports, exports: t.exports, currentUserId: () => userId });
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
