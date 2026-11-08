// A company is stored once, with the one fact that belongs to the COMPANY rather than to any job there:
// its sector. Applications point at it. So "Stripe is Fintech" is written in one place, setting it
// once classifies every Stripe application, and fixing a spelling fixes it everywhere.

import { identityKey } from "./keys.ts";
import { ValidationError } from "./errors.ts";
import type { ValidationIssue } from "./errors.ts";
import { SECTORS } from "./vocab.ts";
import type { Sector } from "./vocab.ts";

export interface Company {
  id: number;
  userId: number;
  name: string;
  sector: Sector | null;
  createdAt: string;
  updatedAt: string;
}

/** A company plus how many applications point at it. */
export interface CompanySummary extends Company {
  /** Applications that are not archived. */
  applications: number;
  /** Including archived ones: a company with none at all is removed, since nothing refers to it. */
  totalApplications: number;
}

export interface CompanyPatch {
  name?: string;
  sector?: Sector | null;
}

const MAX_NAME = 200;

export function parseCompanyPatch(raw: unknown): CompanyPatch {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ValidationError([{ field: "(body)", message: "must be a JSON object" }]);
  const body = raw as Record<string, unknown>;
  const issues: ValidationIssue[] = [];
  const patch: CompanyPatch = {};
  for (const key of Object.keys(body)) if (key !== "name" && key !== "sector") issues.push({ field: key, message: "unknown field (a company has a name and a sector)" });
  if ("name" in body) {
    const name = typeof body.name === "string" ? body.name.replace(/\s+/g, " ").trim() : "";
    if (!name) issues.push({ field: "name", message: "is required" });
    else if (name.length > MAX_NAME) issues.push({ field: "name", message: `must be at most ${MAX_NAME} characters` });
    else patch.name = name;
  }
  if ("sector" in body) {
    const s = body.sector;
    if (s === null || s === "") patch.sector = null;
    else if (typeof s === "string" && (SECTORS as readonly string[]).includes(s)) patch.sector = s as Sector;
    else issues.push({ field: "sector", message: `must be one of: ${SECTORS.join(", ")}` });
  }
  if (!issues.length && !("name" in patch) && !("sector" in patch)) issues.push({ field: "(body)", message: "nothing to change: give a name or a sector" });
  if (issues.length) throw new ValidationError(issues);
  return patch;
}

export function parseMerge(raw: unknown): { into: number } {
  const into = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).into : undefined;
  if (!Number.isInteger(into) || (into as number) < 1) throw new ValidationError([{ field: "into", message: "must be the id of the company to merge into" }]);
  return { into: into as number };
}

/** Two names are the same company when their keys match. */
export const sameCompany = (a: string, b: string): boolean => identityKey(a) === identityKey(b);
