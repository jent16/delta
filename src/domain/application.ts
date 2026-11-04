import { isIsoDate } from "./dates.ts";
import { ValidationError, type ValidationIssue } from "./errors.ts";
import { isStatus, STATUSES, type Status } from "./status.ts";
import { ROLE_FUNCTIONS, SECTORS, type RoleFunction, type Sector } from "./vocab.ts";

// ---- types ----------------------------------------------------------------

/** What a person fills in. Everything except company/role is optional. */
export interface ApplicationFields {
  company: string;
  roleTitle: string;
  roleFunction: RoleFunction;
  sector: Sector | null;
  location: string | null;
  term: string | null;
  url: string | null;
  source: string | null;
  appliedOn: string | null;
  deadlineOn: string | null;
  followUpOn: string | null;
  resumeVersion: string | null;
  compensation: string | null;
  notes: string;
}

/** An application as stored: the fields plus identity, status and bookkeeping. */
export interface Application extends ApplicationFields {
  id: number;
  userId: number;
  status: Status;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ApplicationPatch = Partial<ApplicationFields>;

export interface NewApplication {
  fields: ApplicationFields;
  status: Status;
  statusOn: string; // the date of the first status event
}

export interface StatusEvent {
  id: number;
  applicationId: number;
  status: Status;
  occurredOn: string;
  note: string | null;
  createdAt: string;
}

export interface StatusChange {
  status: Status;
  on: string;
  note: string | null;
}

/** A filter over applications. A saved "list" is exactly one of these. */
export interface ApplicationQuery {
  statuses?: Status[];
  roleFunctions?: RoleFunction[];
  sectors?: Sector[];
  q?: string;
  includeArchived?: boolean;
}

// ---- validation: the boundary between untrusted input and the domain ------

type Spec =
  | { kind: "text"; max: number; required?: boolean }
  | { kind: "date" }
  | { kind: "url" }
  | { kind: "enum"; values: readonly string[]; nullable: boolean };

const SPECS: Record<keyof ApplicationFields, Spec> = {
  company: { kind: "text", max: 200, required: true },
  roleTitle: { kind: "text", max: 200, required: true },
  roleFunction: { kind: "enum", values: ROLE_FUNCTIONS, nullable: false },
  sector: { kind: "enum", values: SECTORS, nullable: true },
  location: { kind: "text", max: 200 },
  term: { kind: "text", max: 50 },
  url: { kind: "url" },
  source: { kind: "text", max: 100 },
  appliedOn: { kind: "date" },
  deadlineOn: { kind: "date" },
  followUpOn: { kind: "date" },
  resumeVersion: { kind: "text", max: 100 },
  compensation: { kind: "text", max: 200 },
  notes: { kind: "text", max: 5000 },
};
const FIELD_NAMES = Object.keys(SPECS) as (keyof ApplicationFields)[];

type Raw = Record<string, unknown>;

function asObject(raw: unknown, issues: ValidationIssue[]): Raw {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    issues.push({ field: "(body)", message: "expected an object" });
    return {};
  }
  return raw as Raw;
}

/** Reads one field. Returns undefined when it wasn't provided at all. */
function readField(key: keyof ApplicationFields, spec: Spec, raw: Raw, issues: ValidationIssue[]): string | null | undefined {
  if (!(key in raw)) return undefined;
  const v = raw[key];
  const blank = v === null || (typeof v === "string" && v.trim() === "");
  if (blank) {
    if ((spec.kind === "text" && spec.required) || (spec.kind === "enum" && !spec.nullable)) {
      issues.push({ field: key, message: "is required" });
      return undefined;
    }
    return null;
  }
  if (typeof v !== "string") {
    issues.push({ field: key, message: "must be text" });
    return undefined;
  }
  const s = v.trim();
  switch (spec.kind) {
    case "text":
      if (s.length > spec.max) issues.push({ field: key, message: `is too long (max ${spec.max})` });
      return s;
    case "date":
      if (!isIsoDate(s)) issues.push({ field: key, message: "must be a real date as YYYY-MM-DD" });
      return s;
    case "url":
      try {
        const u = new URL(s);
        if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
      } catch {
        issues.push({ field: key, message: "must be an http(s) link" });
      }
      return s;
    case "enum":
      if (!spec.values.includes(s)) issues.push({ field: key, message: `must be one of: ${spec.values.join(", ")}` });
      return s;
  }
}

function parseFields(raw: Raw, issues: ValidationIssue[], extraKeys: readonly string[]): Partial<Record<keyof ApplicationFields, string | null>> {
  for (const key of Object.keys(raw)) {
    // rejecting unknown keys turns a typo like "compny" into an error instead of silently dropped data
    if (!(key in SPECS) && !extraKeys.includes(key)) issues.push({ field: key, message: "unknown field" });
  }
  const out: Partial<Record<keyof ApplicationFields, string | null>> = {};
  for (const key of FIELD_NAMES) {
    const value = readField(key, SPECS[key], raw, issues);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function complete(parsed: Partial<Record<keyof ApplicationFields, string | null>>): ApplicationFields {
  return {
    company: parsed.company ?? "",
    roleTitle: parsed.roleTitle ?? "",
    roleFunction: (parsed.roleFunction ?? "Other") as RoleFunction,
    sector: (parsed.sector ?? null) as Sector | null,
    location: parsed.location ?? null,
    term: parsed.term ?? null,
    url: parsed.url ?? null,
    source: parsed.source ?? null,
    appliedOn: parsed.appliedOn ?? null,
    deadlineOn: parsed.deadlineOn ?? null,
    followUpOn: parsed.followUpOn ?? null,
    resumeVersion: parsed.resumeVersion ?? null,
    compensation: parsed.compensation ?? null,
    notes: parsed.notes ?? "",
  };
}

/** A new application. `status` is optional; it defaults from whether you've applied. */
export function parseNewApplication(rawInput: unknown, today: string): NewApplication {
  const issues: ValidationIssue[] = [];
  const raw = asObject(rawInput, issues);
  const parsed = parseFields(raw, issues, ["status"]);
  for (const key of FIELD_NAMES) {
    const spec = SPECS[key];
    if (spec.kind === "text" && spec.required && !(key in raw)) issues.push({ field: key, message: "is required" });
  }
  let status: Status | undefined;
  if ("status" in raw && raw.status !== undefined && raw.status !== null) {
    if (isStatus(raw.status)) status = raw.status;
    else issues.push({ field: "status", message: `must be one of: ${STATUSES.join(", ")}` });
  }
  if (issues.length) throw new ValidationError(issues);

  const fields = complete(parsed);
  const resolved = status ?? (fields.appliedOn ? "applied" : "saved");
  // saved/drafting have no meaningful date of their own; everything else happened on appliedOn if given
  return { fields, status: resolved, statusOn: resolved === "saved" || resolved === "drafting" ? today : (fields.appliedOn ?? today) };
}

/** An edit: any subset of fields. Status is changed through its own operation. */
export function parseApplicationPatch(rawInput: unknown): ApplicationPatch {
  const issues: ValidationIssue[] = [];
  const raw = asObject(rawInput, issues);
  const parsed = parseFields(raw, issues, []);
  if (!issues.length && Object.keys(parsed).length === 0) issues.push({ field: "(body)", message: "no fields to change" });
  if (issues.length) throw new ValidationError(issues);
  const patch: ApplicationPatch = {};
  if (parsed.company !== undefined) patch.company = parsed.company ?? "";
  if (parsed.roleTitle !== undefined) patch.roleTitle = parsed.roleTitle ?? "";
  if (parsed.roleFunction !== undefined) patch.roleFunction = parsed.roleFunction as RoleFunction;
  if (parsed.sector !== undefined) patch.sector = parsed.sector as Sector | null;
  if (parsed.location !== undefined) patch.location = parsed.location;
  if (parsed.term !== undefined) patch.term = parsed.term;
  if (parsed.url !== undefined) patch.url = parsed.url;
  if (parsed.source !== undefined) patch.source = parsed.source;
  if (parsed.appliedOn !== undefined) patch.appliedOn = parsed.appliedOn;
  if (parsed.deadlineOn !== undefined) patch.deadlineOn = parsed.deadlineOn;
  if (parsed.followUpOn !== undefined) patch.followUpOn = parsed.followUpOn;
  if (parsed.resumeVersion !== undefined) patch.resumeVersion = parsed.resumeVersion;
  if (parsed.compensation !== undefined) patch.compensation = parsed.compensation;
  if (parsed.notes !== undefined) patch.notes = parsed.notes ?? "";
  return patch;
}

export function parseStatusChange(rawInput: unknown, today: string): StatusChange {
  const issues: ValidationIssue[] = [];
  const raw = asObject(rawInput, issues);
  for (const key of Object.keys(raw)) {
    if (!["status", "on", "note"].includes(key)) issues.push({ field: key, message: "unknown field" });
  }
  if (!isStatus(raw.status)) issues.push({ field: "status", message: `must be one of: ${STATUSES.join(", ")}` });
  let on = today;
  if (raw.on !== undefined && raw.on !== null) {
    if (typeof raw.on === "string" && isIsoDate(raw.on)) on = raw.on;
    else issues.push({ field: "on", message: "must be a real date as YYYY-MM-DD" });
  }
  let note: string | null = null;
  if (typeof raw.note === "string" && raw.note.trim()) {
    note = raw.note.trim();
    if (note.length > 500) issues.push({ field: "note", message: "is too long (max 500)" });
  }
  if (issues.length) throw new ValidationError(issues);
  return { status: raw.status as Status, on, note };
}

/** Parses a query string (e.g. ?status=applied,interview&function=SWE&q=stripe). */
export function parseApplicationQuery(raw: Record<string, unknown>): ApplicationQuery {
  const issues: ValidationIssue[] = [];
  const list = (key: string): string[] | undefined => {
    const v = raw[key];
    if (v === undefined || v === "") return undefined;
    const parts = (Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(",")).map((s) => s.trim()).filter(Boolean);
    return parts.length ? parts : undefined;
  };
  const checked = <T extends string>(key: string, allowed: readonly T[]): T[] | undefined => {
    const values = list(key);
    if (!values) return undefined;
    const bad = values.filter((x) => !(allowed as readonly string[]).includes(x));
    if (bad.length) issues.push({ field: key, message: `unknown value(s): ${bad.join(", ")}` });
    return values as T[];
  };
  const query: ApplicationQuery = {};
  const statuses = checked("status", STATUSES);
  const roleFunctions = checked("function", ROLE_FUNCTIONS);
  const sectors = checked("sector", SECTORS);
  if (statuses) query.statuses = statuses;
  if (roleFunctions) query.roleFunctions = roleFunctions;
  if (sectors) query.sectors = sectors;
  if (typeof raw.q === "string" && raw.q.trim()) query.q = raw.q.trim();
  if (raw.includeArchived === "1" || raw.includeArchived === "true") query.includeArchived = true;
  if (issues.length) throw new ValidationError(issues);
  return query;
}

// ---- duplicate detection --------------------------------------------------

const norm = (s: string | null) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Two applications with the same company, role and term are almost certainly
 * the same one. The same company with a different role is not.
 */
export function dedupeKey(f: Pick<ApplicationFields, "company" | "roleTitle" | "term">): string {
  return [norm(f.company), norm(f.roleTitle), norm(f.term)].join("|");
}
