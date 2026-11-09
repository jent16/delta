// "Interested": a job you might apply to. Lighter than an application on purpose: a company, maybe the role,
// the link to the posting, and a note. Starting one turns it into a real application.

import { ValidationError } from "./errors.ts";
import type { ValidationIssue } from "./errors.ts";

export interface Interest {
  id: number;
  company: string;
  roleTitle: string | null;
  url: string | null;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface InterestFields { company: string; roleTitle: string | null; url: string | null; note: string }
export type InterestPatch = Partial<InterestFields>;

export const INTEREST_LIMITS = { company: 200, roleTitle: 200, note: 5000 } as const; // the same limits an application has
export const START_STATUSES = ["saved", "drafting"] as const;
export type StartStatus = (typeof START_STATUSES)[number];

const KEYS = ["company", "roleTitle", "url", "note"];

function asObject(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new ValidationError([{ field: "(body)", message: "expected an object" }]);
  return raw as Record<string, unknown>;
}

/** undefined = not provided; null = blank (cleared); otherwise the trimmed text. */
function text(raw: Record<string, unknown>, key: string, max: number, issues: ValidationIssue[]): string | null | undefined {
  if (!(key in raw)) return undefined;
  const v = raw[key];
  if (v === null || (typeof v === "string" && v.trim() === "")) return null;
  if (typeof v !== "string") { issues.push({ field: key, message: "must be text" }); return undefined; }
  const s = v.trim();
  if (s.length > max) issues.push({ field: key, message: `is too long (max ${max})` });
  return s;
}

function link(raw: Record<string, unknown>, issues: ValidationIssue[]): string | null | undefined {
  const s = text(raw, "url", 2000, issues);
  if (typeof s !== "string") return s;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
  } catch { issues.push({ field: "url", message: "must be an http(s) link" }); }
  return s;
}

function readAll(raw: Record<string, unknown>, issues: ValidationIssue[]) {
  for (const k of Object.keys(raw)) if (!KEYS.includes(k)) issues.push({ field: k, message: "unknown field" });
  return {
    company: text(raw, "company", INTEREST_LIMITS.company, issues),
    roleTitle: text(raw, "roleTitle", INTEREST_LIMITS.roleTitle, issues),
    url: link(raw, issues),
    note: text(raw, "note", INTEREST_LIMITS.note, issues),
  };
}

export function parseNewInterest(rawInput: unknown): InterestFields {
  const issues: ValidationIssue[] = [];
  const f = readAll(asObject(rawInput), issues);
  if (!f.company && !issues.some((i) => i.field === "company")) issues.push({ field: "company", message: "is required" });
  if (issues.length) throw new ValidationError(issues);
  return { company: f.company as string, roleTitle: f.roleTitle ?? null, url: f.url ?? null, note: f.note ?? "" };
}

export function parseInterestPatch(rawInput: unknown): InterestPatch {
  const issues: ValidationIssue[] = [];
  const f = readAll(asObject(rawInput), issues);
  if (f.company === null) issues.push({ field: "company", message: "is required" }); // it can be changed but not removed
  if (!Object.values(f).some((v) => v !== undefined) && !issues.length) issues.push({ field: "(body)", message: "nothing to change" });
  if (issues.length) throw new ValidationError(issues);
  const patch: InterestPatch = {};
  if (f.company !== undefined) patch.company = f.company as string;
  if (f.roleTitle !== undefined) patch.roleTitle = f.roleTitle;
  if (f.url !== undefined) patch.url = f.url;
  if (f.note !== undefined) patch.note = f.note ?? "";
  return patch;
}

/** Starting an application from an interest: which stage it begins in, and the role if the interest had none. */
export function parseStart(rawInput: unknown): { status: StartStatus; roleTitle: string | null } {
  const raw = rawInput === undefined || rawInput === null ? {} : asObject(rawInput);
  const issues: ValidationIssue[] = [];
  for (const k of Object.keys(raw)) if (k !== "status" && k !== "roleTitle") issues.push({ field: k, message: "unknown field" });
  let status: StartStatus = "saved";
  if ("status" in raw && raw.status !== undefined) {
    if ((START_STATUSES as readonly unknown[]).includes(raw.status)) status = raw.status as StartStatus;
    else issues.push({ field: "status", message: `must be one of: ${START_STATUSES.join(", ")}` });
  }
  const roleTitle = text(raw, "roleTitle", INTEREST_LIMITS.roleTitle, issues) ?? null;
  if (issues.length) throw new ValidationError(issues);
  return { status, roleTitle };
}
