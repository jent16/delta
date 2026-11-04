// The importer's use-cases. Both preview and commit run the SAME plan, so what
// the preview promises is what the commit does. Rows are written through the
// ordinary application service, so an imported row gets exactly the validation,
// duplicate check and status history a typed one does.
//
// Delta is the source of truth after import: a row already in the ledger is
// never read again, so edits and archiving done in Delta are not overwritten
// or resurrected by running the import twice.

import { dedupeKey, parseNewApplication } from "../domain/application.ts";
import { toIsoDate } from "../domain/dates.ts";
import { DuplicateError, ValidationError } from "../domain/errors.ts";
import { describeRow, mapRow, parseImportRequest, TRACKER_COLUMNS } from "../domain/import.ts";
import type { MappedRow, RowSource } from "../domain/import.ts";
import type { ApplicationRepository, ImportLedger } from "../domain/ports.ts";
import type { ApplicationService, Clock } from "./applications.ts";

export type PlanAction = "create" | "already_imported" | "duplicate" | "invalid";

export interface PlanItem {
  externalId: string;
  company: string;
  roleTitle: string;
  action: PlanAction;
  /** Why it isn't being created (a duplicate of what, or what's wrong). */
  reason?: string;
  status?: string;
  appliedOn?: string | null;
  sector?: string | null;
  sectorGuessed?: boolean;
  warnings: string[];
  /** The application this row is, once it exists. */
  applicationId?: number;
}

export interface ImportSummary {
  total: number;
  create: number;
  alreadyImported: number;
  duplicate: number;
  invalid: number;
  /** Rows that will be/were created with no sector, so they won't appear in sector-based lists. */
  withoutSector: number;
}

export interface ImportResult {
  source: string;
  summary: ImportSummary;
  items: PlanItem[];
}

export interface ImportService {
  preview(userId: number, rawRequest: unknown): Promise<ImportResult>;
  commit(userId: number, rawRequest: unknown): Promise<ImportResult>;
}

export interface SourceFactory {
  notion(database: string): RowSource;
}

export function createImportService(deps: {
  sources: SourceFactory;
  applications: ApplicationService;
  repo: ApplicationRepository;
  ledger: ImportLedger;
  clock: Clock;
}): ImportService {
  const { sources, applications, repo, ledger, clock } = deps;

  type Planned = { item: PlanItem; mapped?: MappedRow; raw?: Record<string, unknown> };

  async function plan(userId: number, rawRequest: unknown): Promise<{ source: string; planned: Planned[] }> {
    const request = parseImportRequest(rawRequest);
    const source = sources.notion(request.database);
    const rows = await source.fetchRows();
    const imported = ledger.known(userId, source.id);
    const today = toIsoDate(clock());

    // Oldest rows first, so when two rows are the same application the original wins.
    const ordered = [...rows].sort((a, b) => (a.createdOn ?? "").localeCompare(b.createdOn ?? "") || a.externalId.localeCompare(b.externalId));
    const seen = new Map<string, string>(); // dedupeKey -> label of the row that claimed it
    const planned: Planned[] = [];

    for (const row of ordered) {
      const base: PlanItem = { externalId: row.externalId, ...describeRow(row, TRACKER_COLUMNS), action: "create", warnings: [] };

      const known = imported.get(row.externalId);
      if (known !== undefined) {
        planned.push({ item: { ...base, action: "already_imported", applicationId: known, reason: `already imported as application #${known}` } });
        continue;
      }

      let mapped: MappedRow;
      let parsed: ReturnType<typeof parseNewApplication>;
      try {
        mapped = mapRow(row, TRACKER_COLUMNS, request.defaults);
        parsed = parseNewApplication(mapped.raw, today);
      } catch (e) {
        if (!(e instanceof ValidationError)) throw e;
        planned.push({ item: { ...base, action: "invalid", reason: e.issues.map((i) => `${i.field} ${i.message}`).join("; ") } });
        continue;
      }

      const f = parsed.fields;
      const filled: PlanItem = {
        ...base, company: f.company, roleTitle: f.roleTitle, status: mapped.followUp?.status ?? parsed.status,
        appliedOn: f.appliedOn, sector: f.sector, sectorGuessed: mapped.sectorGuessed, warnings: mapped.warnings,
      };
      const key = dedupeKey(f);
      const existing = repo.findByDedupeKey(userId, key);
      if (existing) {
        planned.push({ item: { ...filled, action: "duplicate", reason: `you already have this in Delta (application #${existing.id})` } });
        continue;
      }
      const earlier = seen.get(key);
      if (earlier) {
        planned.push({ item: { ...filled, action: "duplicate", reason: `same company, role and term as another row (${earlier}); only the older one is imported` } });
        continue;
      }
      seen.set(key, `${f.company} — ${f.roleTitle}`);
      planned.push({ item: filled, mapped, raw: mapped.raw });
    }
    return { source: source.id, planned };
  }

  const summarize = (items: PlanItem[]): ImportSummary => ({
    total: items.length,
    create: items.filter((i) => i.action === "create").length,
    alreadyImported: items.filter((i) => i.action === "already_imported").length,
    duplicate: items.filter((i) => i.action === "duplicate").length,
    invalid: items.filter((i) => i.action === "invalid").length,
    withoutSector: items.filter((i) => i.action === "create" && !i.sector).length,
  });

  return {
    async preview(userId, rawRequest) {
      const { source, planned } = await plan(userId, rawRequest);
      const items = planned.map((p) => p.item);
      return { source, summary: summarize(items), items };
    },

    async commit(userId, rawRequest) {
      const { source, planned } = await plan(userId, rawRequest);
      for (const p of planned) {
        if (p.item.action !== "create" || !p.raw || !p.mapped) continue;
        try {
          const app = applications.add(userId, p.raw);
          if (p.mapped.followUp) applications.changeStatus(userId, app.id, p.mapped.followUp);
          ledger.record(userId, source, p.item.externalId, app.id, clock().toISOString());
          p.item.applicationId = app.id;
        } catch (e) {
          // Anything that slipped past the plan is reported per row; one bad row never aborts the rest,
          // and because nothing failed is recorded, running the import again retries exactly those.
          p.item.action = e instanceof DuplicateError ? "duplicate" : "invalid";
          p.item.reason = e instanceof Error ? e.message : "failed";
        }
      }
      const items = planned.map((p) => p.item);
      return { source, summary: summarize(items), items };
    },
  };
}
