// Turning rows from somewhere else (a Notion database today, a CSV tomorrow)
// into applications. Everything here is pure: no network, no database. A
// "source" supplies SourceRows; this file decides what each row MEANS; the
// import service decides what to do about it.
//
// The mapping is data (aliases and a status table), not code, so a differently
// named column or an extra status word is a one-line change.

import { guessSector } from "./company-hints.ts";
import { isIsoDate } from "./dates.ts";
import { ValidationError } from "./errors.ts";
import type { ValidationIssue } from "./errors.ts";
import type { Status } from "./status.ts";
import { ROLE_FUNCTIONS, SECTORS } from "./vocab.ts";
import type { RoleFunction, Sector } from "./vocab.ts";

/** One row from a source, flattened to text so the mapping doesn't care where it came from. */
export interface SourceRow {
  /** Stable id in the source (a Notion page id). Re-importing is safe because of this. */
  externalId: string;
  /** column name -> text; "" when the cell is empty. */
  fields: Record<string, string>;
  /** When the row was created / last edited in the source (YYYY-MM-DD), if the source knows. */
  createdOn: string | null;
  editedOn: string | null;
}

/** An outside system the importer can read rows from. */
export interface RowSource {
  /** Identifies the source in the ledger, e.g. "notion:3d49313a…". */
  id: string;
  fetchRows(): Promise<SourceRow[]>;
}

/** Accepted column names per field (lowercase). "(title)" means "the source's title column". */
export interface ColumnAliases {
  company: string[];
  roleTitle: string[];
  location: string[];
  url: string[];
  opens: string[];
  applied: string[];
  notes: string[];
  status: string[];
}

// The layout of the SWE tracker, which PM and Fintech trackers are treated as sharing.
export const TRACKER_COLUMNS: ColumnAliases = {
  company: ["company", "(title)"],
  roleTitle: ["role/program", "role", "program", "position", "title"],
  location: ["location", "city"],
  url: ["link", "url", "posting"],
  opens: ["opens", "opens on", "posted"],
  applied: ["applied", "applied on", "date applied"],
  notes: ["notes", "note"],
  status: ["status", "stage"],
};

// What the words in a Status column mean. "x" is how this tracker marks a rejection.
const STATUS_WORDS: Record<string, Status> = {
  bookmarked: "saved", saved: "saved",
  "in process": "drafting", drafting: "drafting", "in progress": "drafting",
  applied: "applied",
  assessment: "assessment", oa: "assessment",
  interview: "interview", interviewing: "interview",
  offer: "offer",
  x: "rejected", rejected: "rejected",
  withdrawn: "withdrawn",
  ghosted: "ghosted",
};

export interface ImportDefaults {
  roleFunction: RoleFunction;
  sector: Sector | null;
}

export interface ImportRequest {
  /** Where to read from: a Notion database link or id. */
  database: string;
  defaults: ImportDefaults;
}

export interface MappedRow {
  /** Shaped for parseNewApplication, so imported rows get exactly the validation typed ones do. */
  raw: Record<string, unknown>;
  /** A later status change (rejected, offer...) applied after the application is created. */
  followUp: { status: Status; on: string; note: string } | null;
  /** Things that were guessed or dropped, shown in the preview. */
  warnings: string[];
  sectorGuessed: boolean;
}

const CLOSED_AFTER_APPLY = new Set<Status>(["assessment", "interview", "offer", "rejected", "withdrawn", "ghosted"]);

function pick(fields: Record<string, string>, aliases: string[]): string {
  const byName = new Map(Object.entries(fields).map(([k, v]) => [k.trim().toLowerCase(), v]));
  for (const a of aliases) {
    const v = byName.get(a);
    if (v !== undefined && v.trim() !== "") return v.trim();
  }
  return "";
}

const isHttpUrl = (s: string): boolean => {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

/** Company and role as the source spells them, for showing a row that can't be imported. */
export function describeRow(row: SourceRow, columns: ColumnAliases): { company: string; roleTitle: string } {
  return { company: pick(row.fields, columns.company), roleTitle: pick(row.fields, columns.roleTitle) };
}

export function parseImportRequest(raw: unknown): ImportRequest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ValidationError([{ field: "(body)", message: "must be a JSON object" }]);
  }
  const body = raw as Record<string, unknown>;
  const issues: ValidationIssue[] = [];
  for (const key of Object.keys(body)) {
    if (!["database", "roleFunction", "sector"].includes(key)) issues.push({ field: key, message: "unknown field" });
  }
  if (typeof body.database !== "string" || !body.database.trim()) issues.push({ field: "database", message: "is required (a Notion database link or id)" });
  if (typeof body.roleFunction !== "string" || !(ROLE_FUNCTIONS as readonly string[]).includes(body.roleFunction)) {
    issues.push({ field: "roleFunction", message: `is required: one of ${ROLE_FUNCTIONS.join(", ")} (which kind of role this tracker holds)` });
  }
  let sector: Sector | null = null;
  if (body.sector !== undefined && body.sector !== null && body.sector !== "") {
    if (typeof body.sector === "string" && (SECTORS as readonly string[]).includes(body.sector)) sector = body.sector as Sector;
    else issues.push({ field: "sector", message: `must be one of: ${SECTORS.join(", ")}` });
  }
  if (issues.length) throw new ValidationError(issues);
  return { database: (body.database as string).trim(), defaults: { roleFunction: body.roleFunction as RoleFunction, sector } };
}

/**
 * Maps one source row to an application. Throws ValidationError only for what
 * can't be mapped at all (an unknown status word); whether the result is a
 * valid application is decided afterwards by the normal parser.
 */
export function mapRow(row: SourceRow, columns: ColumnAliases, defaults: ImportDefaults): MappedRow {
  const warnings: string[] = [];
  const f = row.fields;
  const company = pick(f, columns.company);
  const appliedCell = pick(f, columns.applied);
  const opens = pick(f, columns.opens);
  const statusWord = pick(f, columns.status).toLowerCase();

  let status: Status;
  const extraNotes: string[] = [];
  if (statusWord === "") {
    status = appliedCell ? "applied" : "saved";
  } else {
    // "oa 2" / "interview 2": a numbered round of a known stage. The number has no field, so it is kept in the notes.
    const known = STATUS_WORDS[statusWord] ?? STATUS_WORDS[statusWord.replace(/\s*\d+$/, "")];
    if (known && STATUS_WORDS[statusWord] === undefined) extraNotes.push(`Notion status: ${pick(f, columns.status)}`);
    if (!known) {
      throw new ValidationError([{ field: "status", message: `unknown status "${pick(f, columns.status)}" (known: ${Object.keys(STATUS_WORDS).join(", ")})` }]);
    }
    status = known;
  }

  // Notes keep everything that has no column of its own, so nothing is lost.
  const notes: string[] = [...extraNotes];
  const noteCell = pick(f, columns.notes);
  if (noteCell) notes.push(noteCell);
  if (opens) notes.push(`Opens: ${opens}`);

  const link = pick(f, columns.url);
  let url: string | null = null;
  if (link) {
    if (isHttpUrl(link)) url = link;
    else {
      notes.push(`Link: ${link}`);
      warnings.push(`link "${link}" is not an http(s) address, so it was kept in the notes`);
    }
  }

  const raw: Record<string, unknown> = {
    company,
    roleTitle: pick(f, columns.roleTitle),
    roleFunction: defaults.roleFunction,
    location: pick(f, columns.location) || null,
    url,
    notes: notes.join("\n"),
  };

  // "SWE Intern (Summer 2027)" carries its term in the title; lift it into the Term field (the title is left as written)
  const term = /\b(summer|fall|winter|spring)\s+(20\d\d)\b/i.exec(`${raw.roleTitle} ${noteCell}`);
  if (term) raw.term = `${term[1]![0]!.toUpperCase()}${term[1]!.slice(1).toLowerCase()} ${term[2]}`;

  let sectorGuessed = false;
  if (defaults.sector) raw.sector = defaults.sector;
  else {
    const guess = company ? guessSector(company) : null;
    if (guess) {
      raw.sector = guess;
      sectorGuessed = true;
    }
  }

  let followUp: MappedRow["followUp"] = null;
  if (status === "saved" || status === "drafting") {
    raw.status = status;
    if (row.createdOn) raw.statusOn = row.createdOn; // "saved on the day it was added to Notion"
    if (appliedCell) raw.appliedOn = appliedCell;
  } else {
    // everything past "saved" started with an application, even when the final state is a rejection
    let appliedOn = appliedCell;
    if (!appliedOn) {
      if (row.createdOn) {
        appliedOn = row.createdOn;
        warnings.push(`no Applied date, so the date the row was created (${row.createdOn}) was used`);
      }
    }
    raw.status = "applied";
    if (appliedOn) raw.appliedOn = appliedOn;
    if (CLOSED_AFTER_APPLY.has(status)) {
      // The source records only the current state, not when it changed. The last edit is the best available guess.
      let on = row.editedOn ?? appliedOn;
      if (on && appliedOn && isIsoDate(on) && isIsoDate(appliedOn) && on < appliedOn) on = appliedOn;
      if (on) {
        followUp = { status, on, note: "Imported from Notion; the date is when the row was last edited, so it is approximate" };
        warnings.push(`"${status}" is dated ${on}, the row's last edit (the exact date wasn't recorded)`);
      }
    }
  }
  return { raw, followUp, warnings, sectorGuessed };
}
