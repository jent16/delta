import { searchCompanies } from "../domain/company.ts";
import type { CompanyCandidate, CompanySuggestion } from "../domain/company.ts";
import { guessSector } from "../domain/company-hints.ts";
import { ValidationError } from "../domain/errors.ts";
import type { ApplicationRepository, CompanyDirectory } from "../domain/ports.ts";
import type { Sector } from "../domain/vocab.ts";

export interface CompanySearchResult {
  query: string;
  suggestions: (CompanySuggestion & { sectorHint: Sector | null })[];
  /** False when the outside list couldn't be loaded; suggestions are then only from your own tracker. */
  directoryAvailable: boolean;
  note?: string;
}

export interface CompanyService {
  search(userId: number, raw: Record<string, unknown>): Promise<CompanySearchResult>;
}

export function createCompanyService(deps: { repo: ApplicationRepository; directory: CompanyDirectory }): CompanyService {
  const { repo, directory } = deps;
  return {
    async search(userId, raw) {
      const q = typeof raw.q === "string" ? raw.q.trim() : "";
      if (!q) throw new ValidationError([{ field: "q", message: "is required" }]);
      const limit = raw.limit === undefined ? 8 : Number(raw.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new ValidationError([{ field: "limit", message: "must be a whole number from 1 to 20" }]);

      const yours: CompanyCandidate[] = repo.companyNames(userId).map((c) => ({ name: c.name, source: "yours", applications: c.count }));
      const dir = await directory.names(); // never throws: a failure comes back as available:false
      const outside: CompanyCandidate[] = dir.names.map((name) => ({ name, source: "directory" }));
      return {
        query: q,
        suggestions: searchCompanies(q, [...yours, ...outside], limit).map((s) => ({ ...s, sectorHint: guessSector(s.name) })),
        directoryAvailable: dir.available,
        ...(dir.note ? { note: dir.note } : {}),
      };
    },
  };
}
