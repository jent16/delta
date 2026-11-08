// A user's preferences and profile: the school the alumni helper searches for, and what they are
// looking for (program, graduation year, target roles and terms). All optional except that the school
// has a default.

import { DEFAULT_SCHOOL } from "./alumni.ts";
import { ValidationError } from "./errors.ts";
import type { ValidationIssue } from "./errors.ts";
import { ROLE_FUNCTIONS } from "./vocab.ts";

export interface Settings {
  school: string;
  program: string;
  gradYear: number | null;
  targetRoles: string[];
  targetTerms: string[];
}

export const DEFAULT_SETTINGS: Settings = { school: DEFAULT_SCHOOL, program: "", gradYear: null, targetRoles: [], targetTerms: [] };

export const SETTING_KEYS = ["school", "program", "gradYear", "targetRoles", "targetTerms"] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];
export const MAX_TERMS = 8;

/** What is saved for each key: text, or null to remove it (so the default applies again). Arrays and numbers are saved as text. */
export type SettingsPatch = Partial<Record<SettingKey, string | null>>;

const oneLine = (v: string) => v.replace(/\s+/g, " ").trim();

function readText(body: Record<string, unknown>, key: "school" | "program", out: SettingsPatch, issues: ValidationIssue[]) {
  if (!(key in body)) return;
  const v = body[key];
  if (v === null || (typeof v === "string" && v.trim() === "")) out[key] = null;
  else if (typeof v !== "string") issues.push({ field: key, message: "must be text" });
  else if (v.trim().length > 100) issues.push({ field: key, message: "is too long (max 100)" });
  else out[key] = oneLine(v);
}

/** `null` or an empty value puts the default back. `name` is accepted by the profile, not here. */
export function parseSettingsPatch(raw: unknown, accepted: readonly SettingKey[] = SETTING_KEYS): SettingsPatch {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new ValidationError([{ field: "(body)", message: "must be a JSON object" }]);
  const body = raw as Record<string, unknown>;
  const issues: ValidationIssue[] = Object.keys(body).filter((k) => !(accepted as readonly string[]).includes(k)).map((k) => ({ field: k, message: "unknown setting" }));
  const out: SettingsPatch = {};
  readText(body, "school", out, issues);
  readText(body, "program", out, issues);

  if ("gradYear" in body) {
    const v = body.gradYear;
    if (v === null || v === "") out.gradYear = null;
    else if (typeof v !== "number" || !Number.isInteger(v) || v < 2000 || v > 2100) issues.push({ field: "gradYear", message: "must be a year between 2000 and 2100" });
    else out.gradYear = String(v);
  }

  if ("targetRoles" in body) {
    const v = body.targetRoles;
    if (!Array.isArray(v) || v.some((r) => typeof r !== "string" || !(ROLE_FUNCTIONS as readonly string[]).includes(r))) issues.push({ field: "targetRoles", message: `must be a list drawn from: ${ROLE_FUNCTIONS.join(", ")}` });
    else out.targetRoles = v.length ? JSON.stringify([...new Set(v as string[])]) : null;
  }

  if ("targetTerms" in body) {
    const v = body.targetTerms;
    if (!Array.isArray(v) || v.some((t) => typeof t !== "string")) issues.push({ field: "targetTerms", message: "must be a list of text" });
    else {
      const terms = [...new Set((v as string[]).map(oneLine).filter(Boolean))];
      if (terms.length > MAX_TERMS) issues.push({ field: "targetTerms", message: `at most ${MAX_TERMS} terms` });
      else if (terms.some((t) => t.length > 30)) issues.push({ field: "targetTerms", message: "each term must be 30 characters or fewer" });
      else out.targetTerms = terms.length ? JSON.stringify(terms) : null;
    }
  }

  if (!issues.length && Object.keys(out).length === 0) issues.push({ field: "(body)", message: "nothing to change" });
  if (issues.length) throw new ValidationError(issues);
  return out;
}

const readList = (stored: string | undefined): string[] => {
  if (!stored) return [];
  try {
    const v: unknown = JSON.parse(stored);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
};

/** Settings as stored (text by key) -> the typed object. A corrupt value falls back to the default instead of breaking the page. */
export function settingsFromStored(stored: Record<string, string>): Settings {
  const year = Number(stored.gradYear);
  return {
    school: stored.school ?? DEFAULT_SETTINGS.school,
    program: stored.program ?? "",
    gradYear: stored.gradYear && Number.isInteger(year) ? year : null,
    targetRoles: readList(stored.targetRoles).filter((r) => (ROLE_FUNCTIONS as readonly string[]).includes(r)),
    targetTerms: readList(stored.targetTerms),
  };
}

// ---- resume versions ----

export interface ResumeVersion {
  id: number;
  name: string;
  note: string | null;
  /** How many of your applications use this name. */
  uses: number;
  createdAt: string;
}

export function parseNewResumeVersion(raw: unknown): { name: string; note: string | null } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new ValidationError([{ field: "(body)", message: "must be a JSON object" }]);
  const body = raw as Record<string, unknown>;
  const issues: ValidationIssue[] = [];
  const name = readVersionName(body.name, issues);
  const note = readVersionNote(body.note, issues);
  if (issues.length) throw new ValidationError(issues);
  return { name, note: note ?? null };
}

export function parseResumeVersionPatch(raw: unknown): { name?: string; note?: string | null } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new ValidationError([{ field: "(body)", message: "must be a JSON object" }]);
  const body = raw as Record<string, unknown>;
  const issues: ValidationIssue[] = Object.keys(body).filter((k) => k !== "name" && k !== "note").map((k) => ({ field: k, message: "unknown field" }));
  const out: { name?: string; note?: string | null } = {};
  if ("name" in body) out.name = readVersionName(body.name, issues);
  if ("note" in body) out.note = readVersionNote(body.note, issues) ?? null;
  if (!issues.length && Object.keys(out).length === 0) issues.push({ field: "(body)", message: "nothing to change" });
  if (issues.length) throw new ValidationError(issues);
  return out;
}

function readVersionName(v: unknown, issues: ValidationIssue[]): string {
  if (typeof v !== "string" || !v.trim()) { issues.push({ field: "name", message: "is required" }); return ""; }
  const name = oneLine(v);
  if (name.length > 100) issues.push({ field: "name", message: "is too long (max 100)" }); // the same limit as an application's resume version
  return name;
}

function readVersionNote(v: unknown, issues: ValidationIssue[]): string | null | undefined {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") { issues.push({ field: "note", message: "must be text" }); return null; }
  const note = v.trim();
  if (note.length > 300) issues.push({ field: "note", message: "is too long (max 300)" });
  return note === "" ? null : note;
}
