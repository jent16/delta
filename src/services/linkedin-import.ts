// Importing your LinkedIn connections. The same shape as the Notion import: preview changes nothing, commit writes,
// and both come from ONE plan, so what you previewed is what you get.
//
// Policy: only people at companies you already have (see domain/linkedin.ts). Everyone else is counted, not kept;
// the biggest untracked employers are listed in the preview so a misspelt company of yours is easy to spot.

import { ValidationError } from "../domain/errors.ts";
import { parseConnections, planConnections } from "../domain/linkedin.ts";
import type { PlanAction, PlanRow } from "../domain/linkedin.ts";
import type { CompanyRepository, ContactImportLedger, ContactRepository } from "../domain/ports.ts";
import type { Clock } from "./applications.ts";
import type { ContactService } from "./contacts.ts";

export const SOURCE = "linkedin";
const MAX_CSV = 8_000_000;
const MAX_INVALID_SHOWN = 50;
const TOP_UNTRACKED = 15;

export interface LinkedInSummary {
  /** People read from the file. */
  total: number;
  create: number;
  needsConfirmation: number;
  alreadyImported: number;
  alreadyInPeople: number;
  duplicateInFile: number;
  untracked: number;
  noCompany: number;
  invalid: number;
  /** Lines that couldn't be read at all. */
  unreadable: number;
}

export interface LinkedInResult {
  summary: LinkedInSummary;
  /** Everything except the (many) people at companies you don't have. */
  items: (PlanRow & { contactId?: number })[];
  /** The employers you don't have that most of your connections work at, so a company you DO have under another spelling stands out. */
  untrackedTop: { company: string; count: number }[];
  /** Commit only: how many people were added. */
  created?: number;
}

export interface LinkedInImportService {
  preview(userId: number, raw: unknown): LinkedInResult;
  commit(userId: number, raw: unknown): LinkedInResult;
}

function parseRequest(raw: unknown): { csv: string; accept: Record<string, number> } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ValidationError([{ field: "(body)", message: "must be a JSON object with the file's text as `csv`" }]);
  const body = raw as Record<string, unknown>;
  const issues = Object.keys(body).filter((k) => k !== "csv" && k !== "accept").map((k) => ({ field: k, message: "unknown field" }));
  const csv = body.csv;
  if (typeof csv !== "string" || !csv.trim()) issues.push({ field: "csv", message: "is required: the text of LinkedIn's Connections.csv" });
  else if (csv.length > MAX_CSV) issues.push({ field: "csv", message: "is too large" });
  const accept: Record<string, number> = {};
  if (body.accept !== undefined) {
    if (typeof body.accept !== "object" || body.accept === null || Array.isArray(body.accept)) issues.push({ field: "accept", message: "must be an object of person key -> company id" });
    else {
      const entries = Object.entries(body.accept as Record<string, unknown>);
      if (entries.length > 5000) issues.push({ field: "accept", message: "too many choices" });
      for (const [k, v] of entries) {
        if (!Number.isInteger(v) || (v as number) < 1) issues.push({ field: `accept.${k}`, message: "must be a company id" });
        else accept[k] = v as number;
      }
    }
  }
  if (issues.length) throw new ValidationError(issues);
  return { csv: csv as string, accept };
}

export function createLinkedInImportService(deps: {
  companies: CompanyRepository;
  contacts: ContactRepository;
  contactService: ContactService;
  ledger: ContactImportLedger;
  clock: Clock;
  /** Called once, just before anything is written (the composition root takes a backup here). */
  beforeCommit?: () => void;
}): LinkedInImportService {
  const { companies, contacts, contactService, ledger, clock, beforeCommit } = deps;

  function plan(userId: number, rawRequest: unknown) {
    const { csv, accept } = parseRequest(rawRequest);
    const parsed = parseConnections(csv);
    if (!parsed.headerFound) throw new ValidationError([{ field: "csv", message: "doesn't look like LinkedIn's Connections file: no 'First Name' and 'Last Name' columns were found" }]);
    const rows = planConnections(parsed.rows, {
      companies: companies.all(userId).map((c) => ({ id: c.id, name: c.name })),
      known: ledger.known(userId, SOURCE),
      existing: contacts.list(userId, {}).map((c) => ({ name: c.name, company: c.company, linkedinUrl: c.linkedinUrl })),
      accept,
    });
    return { rows, unreadable: parsed.unreadable.length };
  }

  function result(rows: (PlanRow & { contactId?: number })[], unreadable: number, created?: number): LinkedInResult {
    const n = (a: PlanAction) => rows.filter((r) => r.action === a).length;
    const untracked = new Map<string, number>();
    for (const r of rows) if (r.action === "untracked" && r.company) untracked.set(r.company, (untracked.get(r.company) ?? 0) + 1);
    let invalidShown = 0;
    return {
      summary: { total: rows.length, create: n("create"), needsConfirmation: n("needs_confirmation"), alreadyImported: n("already_imported"), alreadyInPeople: n("already_in_people"),
        duplicateInFile: n("duplicate_in_file"), untracked: n("untracked"), noCompany: n("no_company"), invalid: n("invalid"), unreadable },
      items: rows.filter((r) => r.action !== "untracked" && r.action !== "no_company" && (r.action !== "invalid" || invalidShown++ < MAX_INVALID_SHOWN)),
      untrackedTop: [...untracked].map(([company, count]) => ({ company, count })).sort((a, b) => b.count - a.count || a.company.localeCompare(b.company)).slice(0, TOP_UNTRACKED),
      ...(created !== undefined ? { created } : {}),
    };
  }

  return {
    preview(userId, raw) {
      const { rows, unreadable } = plan(userId, raw);
      return result(rows, unreadable);
    },

    commit(userId, raw) {
      const { rows, unreadable } = plan(userId, raw);
      const toCreate = rows.filter((r) => r.action === "create" && r.addTo);
      if (toCreate.length) beforeCommit?.();
      const out: (PlanRow & { contactId?: number })[] = rows;
      let created = 0;
      for (const r of toCreate) {
        try {
          const contact = contactService.add(userId, {
            name: r.name, company: r.addTo!.name, title: r.position, email: r.email, linkedinUrl: r.linkedinUrl, relationship: r.relationship,
            notes: `Imported from LinkedIn${r.connectedOn ? `. Connected ${r.connectedOn}` : ""}.`,
          });
          ledger.record(userId, SOURCE, r.key, contact.id, clock().toISOString());
          (r as PlanRow & { contactId?: number }).contactId = contact.id;
          created++;
        } catch (e) {
          // anything that slipped past the plan is reported on its row; one bad row never aborts the rest, and
          // because a failed row is not recorded, importing again retries exactly those
          if (!(e instanceof ValidationError)) throw e;
          r.action = "invalid";
          r.reason = e.issues.map((i) => `${i.field} ${i.message}`).join("; ");
        }
      }
      return result(out, unreadable, created);
    },
  };
}
