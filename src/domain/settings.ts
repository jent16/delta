// A user's few preferences. Today there is one: the school the alumni helper searches for.

import { DEFAULT_SCHOOL } from "./alumni.ts";
import { ValidationError } from "./errors.ts";

export interface Settings {
  school: string;
}

export const DEFAULT_SETTINGS: Settings = { school: DEFAULT_SCHOOL };

/** `{ school: null }` or an empty string puts the default back. */
export function parseSettingsPatch(raw: unknown): Partial<Record<keyof Settings, string | null>> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new ValidationError([{ field: "(body)", message: "must be a JSON object" }]);
  const body = raw as Record<string, unknown>;
  const issues = Object.keys(body).filter((k) => k !== "school").map((k) => ({ field: k, message: "unknown setting" }));
  const out: Partial<Record<keyof Settings, string | null>> = {};
  if ("school" in body) {
    const v = body.school;
    if (v === null || (typeof v === "string" && v.trim() === "")) out.school = null;
    else if (typeof v !== "string") issues.push({ field: "school", message: "must be text" });
    else if (v.trim().length > 100) issues.push({ field: "school", message: "is too long (max 100)" });
    else out.school = v.replace(/\s+/g, " ").trim();
  }
  if (!issues.length && !("school" in out)) issues.push({ field: "(body)", message: "nothing to change" });
  if (issues.length) throw new ValidationError(issues);
  return out;
}
