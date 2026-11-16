// The body of a "delete these" request: { ids: [1, 2, 3] } and nothing else. One place, so the same rules
// (non-empty, whole positive numbers, a sane cap, no stray fields) apply to applications, companies and interests.

import { ValidationError } from "./errors.ts";
import type { ValidationIssue } from "./errors.ts";

export const MAX_DELETE = 500;

export function parseIdList(rawInput: unknown, noun: string): number[] {
  if (typeof rawInput !== "object" || rawInput === null || Array.isArray(rawInput)) {
    throw new ValidationError([{ field: "(body)", message: "must be a JSON object" }]);
  }
  const body = rawInput as Record<string, unknown>;
  const issues: ValidationIssue[] = [];
  for (const key of Object.keys(body)) if (key !== "ids") issues.push({ field: key, message: "unknown field" });
  const ids = body.ids;
  if (!Array.isArray(ids) || ids.length === 0) issues.push({ field: "ids", message: `must be a non-empty list of ${noun} ids` });
  else if (ids.length > MAX_DELETE) issues.push({ field: "ids", message: `at most ${MAX_DELETE} at a time` });
  else if (ids.some((x) => !Number.isInteger(x) || (x as number) < 1)) issues.push({ field: "ids", message: "every id must be a positive integer" });
  if (issues.length) throw new ValidationError(issues);
  return [...new Set(ids as number[])];
}
