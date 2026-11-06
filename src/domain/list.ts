// A "list" is a saved filter, not a container. An application is never
// "in" the SWE list; it simply matches the SWE filter — so one application can
// show up in SWE and Fintech-adjacent at once, and nothing is ever copied or
// moved between lists.
//
// Free-text search (`q`) is deliberately NOT part of a saved filter: a list
// describes a category you keep returning to, while a search is a momentary
// question you ask *within* a list (see narrowQuery).

import type { ApplicationQuery } from "./application.ts";
import { ValidationError } from "./errors.ts";
import type { ValidationIssue } from "./errors.ts";
import { STATUSES } from "./status.ts";
import { ROLE_FUNCTIONS, SECTORS } from "./vocab.ts";

export type ListFilter = Pick<ApplicationQuery, "statuses" | "roleFunctions" | "sectors" | "includeArchived">;

export interface SavedList {
  id: number;
  userId: number;
  name: string;
  filter: ListFilter;
  createdAt: string;
  updatedAt: string;
}

export interface NewList {
  name: string;
  filter: ListFilter;
}

export interface ListPatch {
  name?: string;
  filter?: ListFilter;
}

const MAX_NAME = 60;
const FILTER_KEYS = ["statuses", "roleFunctions", "sectors", "includeArchived"];

function parseName(v: unknown, issues: ValidationIssue[]): string | undefined {
  if (typeof v !== "string" || !v.trim()) {
    issues.push({ field: "name", message: "is required" });
    return undefined;
  }
  const name = v.trim();
  if (name.length > MAX_NAME) issues.push({ field: "name", message: `must be at most ${MAX_NAME} characters` });
  return name;
}

export function parseFilter(raw: unknown, issues: ValidationIssue[]): ListFilter | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    issues.push({ field: "filter", message: "must be an object" });
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!FILTER_KEYS.includes(key)) issues.push({ field: `filter.${key}`, message: `unknown field (allowed: ${FILTER_KEYS.join(", ")})` });
  }
  const filter: ListFilter = {};
  const oneOf = <T extends string>(key: "statuses" | "roleFunctions" | "sectors", allowed: readonly T[]) => {
    const v = obj[key];
    if (v === undefined) return;
    if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== "string")) {
      issues.push({ field: `filter.${key}`, message: "must be a non-empty array of strings (leave it out to match everything)" });
      return;
    }
    const bad = v.filter((x) => !(allowed as readonly string[]).includes(x));
    if (bad.length) {
      issues.push({ field: `filter.${key}`, message: `unknown value(s): ${bad.join(", ")}` });
      return;
    }
    (filter as Record<string, unknown>)[key] = [...new Set(v)];
  };
  oneOf("statuses", STATUSES);
  oneOf("roleFunctions", ROLE_FUNCTIONS);
  oneOf("sectors", SECTORS);
  if (obj.includeArchived !== undefined) {
    if (typeof obj.includeArchived !== "boolean") issues.push({ field: "filter.includeArchived", message: "must be true or false" });
    else if (obj.includeArchived) filter.includeArchived = true;
  }
  return filter;
}

export function parseNewList(raw: unknown): NewList {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ValidationError([{ field: "(body)", message: "must be a JSON object" }]);
  }
  const body = raw as Record<string, unknown>;
  const issues: ValidationIssue[] = [];
  for (const key of Object.keys(body)) {
    if (key !== "name" && key !== "filter") issues.push({ field: key, message: "unknown field" });
  }
  const name = parseName(body.name, issues);
  // a list with no filter is allowed — it's simply "everything"
  const filter = body.filter === undefined ? {} : parseFilter(body.filter, issues);
  if (issues.length) throw new ValidationError(issues);
  return { name: name as string, filter: filter as ListFilter };
}

export function parseListPatch(raw: unknown): ListPatch {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ValidationError([{ field: "(body)", message: "must be a JSON object" }]);
  }
  const body = raw as Record<string, unknown>;
  const issues: ValidationIssue[] = [];
  for (const key of Object.keys(body)) {
    if (key !== "name" && key !== "filter") issues.push({ field: key, message: "unknown field" });
  }
  const patch: ListPatch = {};
  if ("name" in body) patch.name = parseName(body.name, issues);
  if ("filter" in body) patch.filter = parseFilter(body.filter, issues);
  if (!issues.length && Object.keys(patch).length === 0) issues.push({ field: "(body)", message: "nothing to change" });
  if (issues.length) throw new ValidationError(issues);
  return patch;
}

// Intersection of two optional "any of" lists.
//   undefined = "no constraint";  [] = "nothing can match".
function intersect<T>(a: readonly T[] | undefined, b: readonly T[] | undefined): T[] | undefined {
  if (!a) return b ? [...b] : undefined;
  if (!b) return [...a];
  return a.filter((x) => b.includes(x));
}

/**
 * Narrows a saved filter with an ad-hoc query ("show me only the applied ones
 * in my SWE list, matching 'stripe'"). Narrowing can only ever REMOVE rows:
 * lists intersect, and a search term is added on top. Returns null when the
 * combination is unsatisfiable — the caller must then return no rows, because
 * the repository treats an empty list as "no constraint" and would otherwise
 * widen the result to everything.
 */
export function narrowQuery(base: ListFilter, extra: ApplicationQuery): ApplicationQuery | null {
  const query: ApplicationQuery = {};
  for (const key of ["statuses", "roleFunctions", "sectors"] as const) {
    const merged = intersect<string>(base[key], extra[key]);
    if (merged && merged.length === 0) return null;
    if (merged) (query as Record<string, unknown>)[key] = merged;
  }
  if (extra.q) query.q = extra.q;
  if (extra.missing) query.missing = extra.missing; // narrows, like q
  // an ad-hoc query may not reveal archived rows the list itself hides
  if (base.includeArchived) query.includeArchived = true;
  return query;
}
