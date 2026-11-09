import { buildCsvExport, buildJsonExport } from "../domain/export.ts";
import type { ApplicationRepository, CompanyRepository, ContactRepository, InterestRepository, ListRepository } from "../domain/ports.ts";
import { toIsoDate } from "../domain/dates.ts";
import type { Clock } from "./applications.ts";

export interface ExportService {
  json(userId: number): { filename: string; body: ReturnType<typeof buildJsonExport> };
  csv(userId: number): { filename: string; body: string };
}

export function createExportService(deps: { applications: ApplicationRepository; lists: ListRepository; companies: CompanyRepository; contacts: ContactRepository; interests?: InterestRepository; clock: Clock }): ExportService {
  const { applications, lists, companies, contacts, interests, clock } = deps;
  return {
    json(userId) {
      return {
        filename: `delta-export-${toIsoDate(clock())}.json`,
        body: buildJsonExport(clock().toISOString(), applications.exportAll(userId), lists.all(userId), companies.all(userId), contacts.exportAll(userId), interests?.all(userId) ?? []),
      };
    },
    csv(userId) {
      return { filename: `delta-export-${toIsoDate(clock())}.csv`, body: buildCsvExport(applications.exportAll(userId)) };
    },
  };
}
