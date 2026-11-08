// Companies: a name and a sector stored once, shared by every application there.
// This service also answers the quick-add search box (your own companies first, then the directory).

import { searchCompanies } from "../domain/company.ts";
import type { CompanyCandidate, CompanySuggestion } from "../domain/company.ts";
import { guessSector } from "../domain/company-hints.ts";
import { parseCompanyPatch, parseMerge } from "../domain/company-record.ts";
import type { CompanySummary } from "../domain/company-record.ts";
import { CompanyExistsError, NotFoundError, ValidationError } from "../domain/errors.ts";
import type { CompanyDirectory, CompanyRepository } from "../domain/ports.ts";
import type { Sector } from "../domain/vocab.ts";
import type { Clock } from "./applications.ts";

export interface CompanySearchResult {
  query: string;
  suggestions: (CompanySuggestion & { sectorHint: Sector | null })[];
  /** False when the outside list couldn't be loaded; suggestions are then only from your own tracker. */
  directoryAvailable: boolean;
  note?: string;
}

export interface CompanyService {
  search(userId: number, raw: Record<string, unknown>): Promise<CompanySearchResult>;
  list(userId: number): CompanySummary[];
  /** Rename and/or set the sector. Renaming to a name another company already has is refused (offer to merge). */
  edit(userId: number, id: number, raw: unknown): CompanySummary;
  /** Move every application of company `id` into `{ into }` and remove `id`. Refused if it would create duplicates. */
  merge(userId: number, id: number, raw: unknown): { company: CompanySummary; moved: number };
}

export function createCompanyService(deps: { companies: CompanyRepository; directory: CompanyDirectory; clock: Clock }): CompanyService {
  const { companies, directory, clock } = deps;
  const now = () => clock().toISOString();
  const mustFind = (userId: number, id: number): CompanySummary => {
    const c = companies.findById(userId, id);
    if (!c) throw new NotFoundError("company");
    return c;
  };

  return {
    async search(userId, raw) {
      const q = typeof raw.q === "string" ? raw.q.trim() : "";
      if (!q) throw new ValidationError([{ field: "q", message: "is required" }]);
      const limit = raw.limit === undefined ? 8 : Number(raw.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new ValidationError([{ field: "limit", message: "must be a whole number from 1 to 20" }]);

      const yours: CompanyCandidate[] = companies.all(userId).map((c) => ({ name: c.name, source: "yours", applications: c.applications, id: c.id, sector: c.sector }));
      const dir = await directory.names(); // never throws: a failure comes back as available:false
      const outside: CompanyCandidate[] = dir.names.map((name) => ({ name, source: "directory" }));
      return {
        query: q,
        // a sector you already set on the company beats a built-in guess by name
        suggestions: searchCompanies(q, [...yours, ...outside], limit).map((s) => ({ ...s, sectorHint: (s.sector as Sector | null | undefined) ?? guessSector(s.name) })),
        directoryAvailable: dir.available,
        ...(dir.note ? { note: dir.note } : {}),
      };
    },

    list(userId) {
      return companies.all(userId);
    },

    edit(userId, id, raw) {
      const patch = parseCompanyPatch(raw);
      const current = mustFind(userId, id);
      let result = current;
      if (patch.name !== undefined && patch.name !== current.name) {
        const clash = companies.findByName(userId, patch.name);
        if (clash && clash.id !== id) throw new CompanyExistsError(clash.id, clash.name);
        // changing only capitalisation or spacing keeps the same key, so it is allowed and simply updates the display name
        result = companies.rename(userId, id, patch.name, now()) as CompanySummary;
      }
      if ("sector" in patch) result = companies.setSector(userId, id, patch.sector ?? null, now()) as CompanySummary;
      return result;
    },

    merge(userId, id, raw) {
      const { into } = parseMerge(raw);
      if (into === id) throw new ValidationError([{ field: "into", message: "can't merge a company into itself" }]);
      const from = mustFind(userId, id);
      const target = mustFind(userId, into);
      const conflicts = companies.mergeConflicts(userId, id, into);
      if (conflicts.length) {
        throw new ValidationError([{ field: "into", message: `${target.name} already has: ${conflicts.join(", ")}. Archive or rename those first, then merge ${from.name}` }]);
      }
      return companies.merge(userId, id, into, now()) as { company: CompanySummary; moved: number };
    },
  };
}

