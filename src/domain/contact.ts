// People: the recruiters, alumni and referrers who matter to your applications.
//
// A contact belongs to at most one company (where they work NOW; people change jobs, and you can
// edit it), may be linked to any number of applications with a role ("referrer", "recruiter"...), and
// has a dated log of what you have done with them (messaged, replied, call...), like an application's
// status history. This is personal data about OTHER people, so it stays in your own database and is
// never sent anywhere; the alumni helper only builds search links that open in your own browser.

import { isIsoDate } from "./dates.ts";
import { ValidationError } from "./errors.ts";
import type { ValidationIssue } from "./errors.ts";

export const RELATIONSHIPS = ["alumni", "recruiter", "referral", "friend", "professor", "other"] as const;
export type Relationship = (typeof RELATIONSHIPS)[number];

/** What this person is to ONE application. */
export const LINK_ROLES = ["referrer", "recruiter", "interviewer", "hiring-manager", "other"] as const;
export type LinkRole = (typeof LINK_ROLES)[number];

export const EVENT_KINDS = ["messaged", "replied", "call", "met", "referral-asked", "referred", "note"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface ContactFields {
  name: string;
  /** The company's NAME (the company record is found or created); null = not tied to one. */
  company: string | null;
  title: string | null;
  email: string | null;
  linkedinUrl: string | null;
  relationship: Relationship;
  notes: string;
  followUpOn: string | null;
}

export interface Contact extends ContactFields {
  id: number;
  userId: number;
  companyId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContactSummary extends Contact {
  /** Date of the newest entry in the log, or null. */
  lastEventOn: string | null;
  /** How many applications this person is linked to. */
  applications: number;
}

export interface ContactEvent {
  id: number;
  contactId: number;
  kind: EventKind;
  occurredOn: string;
  note: string | null;
  createdAt: string;
}

export interface NewContactEvent {
  kind: EventKind;
  on: string;
  note: string | null;
}

export type ContactPatch = Partial<ContactFields>;

export interface ContactQuery {
  q?: string;
  companyId?: number;
  relationship?: Relationship;
  /** Only people whose follow-up date is on or before this day. */
  dueBy?: string;
}

/** A person linked to an application, with their role for it. */
export interface LinkedContact {
  contact: Contact;
  role: LinkRole;
}

/** An application a person is linked to, with their role for it. */
export interface LinkedApplication {
  applicationId: number;
  company: string;
  roleTitle: string;
  role: LinkRole;
}

// ---- validation -------------------------------------------------------------------------------

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
type Raw = Record<string, unknown>;

/** A stored profile link must be https on linkedin.com, so it can never become a `javascript:` or look-alike link. */
export function isLinkedInUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && (u.hostname === "linkedin.com" || u.hostname.endsWith(".linkedin.com")) && !u.username && !u.password;
  } catch {
    return false;
  }
}

function object(raw: unknown): Raw {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new ValidationError([{ field: "(body)", message: "must be a JSON object" }]);
  return raw as Raw;
}

const FIELDS = ["name", "company", "title", "email", "linkedinUrl", "relationship", "notes", "followUpOn"] as const;

function readFields(raw: Raw, issues: ValidationIssue[]): Partial<Record<(typeof FIELDS)[number], string | null>> {
  for (const key of Object.keys(raw)) if (!(FIELDS as readonly string[]).includes(key)) issues.push({ field: key, message: "unknown field" });
  const out: Partial<Record<(typeof FIELDS)[number], string | null>> = {};
  const text = (key: (typeof FIELDS)[number], max: number, required = false) => {
    if (!(key in raw)) return;
    const v = raw[key];
    const blank = v === null || (typeof v === "string" && v.trim() === "");
    if (blank) { if (required) issues.push({ field: key, message: "is required" }); else out[key] = null; return; }
    if (typeof v !== "string") { issues.push({ field: key, message: "must be text" }); return; }
    const s = v.replace(/[ \t]+/g, " ").trim();
    if (s.length > max) issues.push({ field: key, message: `is too long (max ${max})` });
    else out[key] = s;
  };
  text("name", 200, true);
  text("company", 200);
  text("title", 200);
  text("notes", 5000);
  if ("notes" in raw && raw.notes === null) out.notes = ""; // notes are never null in storage
  text("email", 254);
  if (typeof out.email === "string" && !EMAIL.test(out.email)) { issues.push({ field: "email", message: "doesn't look like an email address" }); delete out.email; }
  text("linkedinUrl", 500);
  if (typeof out.linkedinUrl === "string" && !isLinkedInUrl(out.linkedinUrl)) { issues.push({ field: "linkedinUrl", message: "must be an https://…linkedin.com link" }); delete out.linkedinUrl; }
  if ("followUpOn" in raw) {
    const v = raw.followUpOn;
    if (v === null || v === "") out.followUpOn = null;
    else if (typeof v !== "string" || !isIsoDate(v.trim())) issues.push({ field: "followUpOn", message: "must be a real date as YYYY-MM-DD" });
    else out.followUpOn = v.trim();
  }
  if ("relationship" in raw) {
    const v = raw.relationship;
    if (typeof v !== "string" || !(RELATIONSHIPS as readonly string[]).includes(v)) issues.push({ field: "relationship", message: `must be one of: ${RELATIONSHIPS.join(", ")}` });
    else out.relationship = v;
  }
  return out;
}

export function parseNewContact(rawInput: unknown): ContactFields {
  const issues: ValidationIssue[] = [];
  const raw = object(rawInput);
  const f = readFields(raw, issues);
  if (!("name" in raw)) issues.push({ field: "name", message: "is required" });
  if (issues.length) throw new ValidationError(issues);
  return {
    name: f.name ?? "",
    company: f.company ?? null,
    title: f.title ?? null,
    email: f.email ?? null,
    linkedinUrl: f.linkedinUrl ?? null,
    relationship: (f.relationship ?? "other") as Relationship,
    notes: f.notes ?? "",
    followUpOn: f.followUpOn ?? null,
  };
}

export function parseContactPatch(rawInput: unknown): ContactPatch {
  const issues: ValidationIssue[] = [];
  const raw = object(rawInput);
  const f = readFields(raw, issues);
  if (!issues.length && Object.keys(f).length === 0) issues.push({ field: "(body)", message: "nothing to change" });
  if (issues.length) throw new ValidationError(issues);
  const patch: ContactPatch = {};
  if ("name" in f) patch.name = f.name ?? "";
  if ("company" in f) patch.company = f.company ?? null;
  if ("title" in f) patch.title = f.title ?? null;
  if ("email" in f) patch.email = f.email ?? null;
  if ("linkedinUrl" in f) patch.linkedinUrl = f.linkedinUrl ?? null;
  if ("relationship" in f) patch.relationship = f.relationship as Relationship;
  if ("notes" in f) patch.notes = f.notes ?? "";
  if ("followUpOn" in f) patch.followUpOn = f.followUpOn ?? null;
  return patch;
}

/** `?due=1` means "follow-up date today or earlier", so it needs to know what today is. */
export function parseContactQuery(raw: Record<string, unknown>, today: string): ContactQuery {
  const issues: ValidationIssue[] = [];
  const q: ContactQuery = {};
  if (typeof raw.q === "string" && raw.q.trim()) q.q = raw.q.trim();
  if (raw.company !== undefined && raw.company !== "") {
    const n = Number(raw.company);
    if (!Number.isInteger(n) || n < 1) issues.push({ field: "company", message: "must be a company id" });
    else q.companyId = n;
  }
  if (raw.relationship !== undefined && raw.relationship !== "") {
    if (typeof raw.relationship === "string" && (RELATIONSHIPS as readonly string[]).includes(raw.relationship)) q.relationship = raw.relationship as Relationship;
    else issues.push({ field: "relationship", message: `must be one of: ${RELATIONSHIPS.join(", ")}` });
  }
  if (raw.due === "1" || raw.due === "true") q.dueBy = today;
  if (issues.length) throw new ValidationError(issues);
  return q;
}

export function parseLink(rawInput: unknown): { applicationId: number; role: LinkRole } {
  const raw = object(rawInput);
  const issues: ValidationIssue[] = [];
  for (const key of Object.keys(raw)) if (key !== "applicationId" && key !== "role") issues.push({ field: key, message: "unknown field" });
  const id = raw.applicationId;
  if (!Number.isInteger(id) || (id as number) < 1) issues.push({ field: "applicationId", message: "must be an application id" });
  const role = raw.role === undefined ? "other" : raw.role;
  if (typeof role !== "string" || !(LINK_ROLES as readonly string[]).includes(role)) issues.push({ field: "role", message: `must be one of: ${LINK_ROLES.join(", ")}` });
  if (issues.length) throw new ValidationError(issues);
  return { applicationId: id as number, role: role as LinkRole };
}

export function parseEvent(rawInput: unknown, today: string): NewContactEvent {
  const raw = object(rawInput);
  const issues: ValidationIssue[] = [];
  for (const key of Object.keys(raw)) if (key !== "kind" && key !== "on" && key !== "note") issues.push({ field: key, message: "unknown field" });
  const kind = raw.kind;
  if (typeof kind !== "string" || !(EVENT_KINDS as readonly string[]).includes(kind)) issues.push({ field: "kind", message: `must be one of: ${EVENT_KINDS.join(", ")}` });
  let on = today;
  if (raw.on !== undefined && raw.on !== null && raw.on !== "") {
    if (typeof raw.on !== "string" || !isIsoDate(raw.on.trim())) issues.push({ field: "on", message: "must be a real date as YYYY-MM-DD" });
    else on = raw.on.trim();
  }
  let note: string | null = null;
  if (raw.note !== undefined && raw.note !== null && raw.note !== "") {
    if (typeof raw.note !== "string") issues.push({ field: "note", message: "must be text" });
    else if (raw.note.trim().length > 1000) issues.push({ field: "note", message: "is too long (max 1000)" });
    else note = raw.note.trim();
  }
  if (issues.length) throw new ValidationError(issues);
  return { kind: kind as EventKind, on, note };
}

/** `{ url, applicationId?, name?, relationship?, role? }`: add the person behind a pasted profile link. */
export function parseFromProfile(rawInput: unknown): { url: string; applicationId: number | null; name: string | null; relationship: Relationship | null; role: LinkRole } {
  const raw = object(rawInput);
  const issues: ValidationIssue[] = [];
  for (const key of Object.keys(raw)) if (!["url", "applicationId", "name", "relationship", "role"].includes(key)) issues.push({ field: key, message: "unknown field" });
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  if (!url) issues.push({ field: "url", message: "is required: paste a LinkedIn profile link" });
  let applicationId: number | null = null;
  if (raw.applicationId !== undefined && raw.applicationId !== null) {
    if (!Number.isInteger(raw.applicationId) || (raw.applicationId as number) < 1) issues.push({ field: "applicationId", message: "must be an application id" });
    else applicationId = raw.applicationId as number;
  }
  let name: string | null = null;
  if (raw.name !== undefined && raw.name !== null && raw.name !== "") {
    if (typeof raw.name !== "string") issues.push({ field: "name", message: "must be text" });
    else if (raw.name.trim().length > 200) issues.push({ field: "name", message: "is too long (max 200)" });
    else name = raw.name.replace(/\s+/g, " ").trim();
  }
  // not given = null: the service decides (an alum if you have set a school, otherwise just "other")
  const relationship = raw.relationship === undefined ? null : raw.relationship;
  if (relationship !== null && (typeof relationship !== "string" || !(RELATIONSHIPS as readonly string[]).includes(relationship))) issues.push({ field: "relationship", message: `must be one of: ${RELATIONSHIPS.join(", ")}` });
  const role = raw.role === undefined ? "other" : raw.role;
  if (typeof role !== "string" || !(LINK_ROLES as readonly string[]).includes(role)) issues.push({ field: "role", message: `must be one of: ${LINK_ROLES.join(", ")}` });
  if (issues.length) throw new ValidationError(issues);
  return { url, applicationId, name, relationship: relationship as Relationship | null, role: role as LinkRole };
}
