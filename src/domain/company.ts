// Matching a typed company name against the names we know. Pure.
//
// Two sources feed it: companies already in your tracker (so the spelling you
// used before comes first) and a directory of companies that post internships.
// Typing "ripling" should still find "Rippling", so near-misses are matched
// too, but ranked below real prefix/substring matches.

export interface CompanyCandidate {
  name: string;
  source: "yours" | "directory";
  /** How many of your applications use this name (only for "yours"). */
  applications?: number;
  /** Your company's id and sector (only for "yours"): so the form can reuse the sector you already set. */
  id?: number;
  sector?: string | null;
}

export type MatchKind = "exact" | "prefix" | "contains" | "similar";

export interface CompanySuggestion extends CompanyCandidate {
  match: MatchKind;
}

/** Lowercase, drop punctuation and legal suffixes: "Stripe, Inc." and "stripe" compare equal. */
export function normalizeCompany(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(inc|llc|ltd|corp|corporation|co|company)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Edit distance where swapping two neighbouring letters counts as ONE edit (the commonest typo). */
export function editDistance(a: string, b: string): number {
  const prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j]!, (prev2[j - 2] ?? Infinity) + 1);
    }
    for (let j = 0; j <= b.length; j++) prev2[j] = prev[j]!;
    prev = cur;
  }
  return prev[b.length]!;
}

const RANK: Record<MatchKind, number> = { exact: 0, prefix: 1, contains: 2, similar: 3 };

/**
 * How many edits away a name is from what was typed, or null when it is not a plausible "did you mean".
 * Only for longer words (a slip is a small part of them), only when the first letter matches (typos rarely
 * change it), and only against the whole name, its first word, or the START of either: the start is what
 * you have typed so far, so "norht" (an unfinished, misspelt word) still finds "northwind".
 * Matching any word made "jane" suggest "Hamilton Lane".
 */
function nearMiss(query: string, name: string): number | null {
  if (query.length < 5) return null;
  const allowed = query.length <= 5 ? 1 : 2;
  const first = name.split(" ")[0]!;
  let best: number | null = null;
  for (const candidate of [name, first, name.slice(0, query.length), first.slice(0, query.length)]) {
    if (candidate[0] !== query[0]) continue;
    const d = editDistance(query, candidate);
    if (d <= allowed && (best === null || d < best)) best = d;
  }
  return best;
}

function classify(query: string, name: string): MatchKind | null {
  if (name === query) return "exact";
  if (name.startsWith(query)) return "prefix";
  if (name.split(" ").some((w) => w.startsWith(query)) || name.includes(query)) return "contains";
  return nearMiss(query, name) === null ? null : "similar";
}

export function searchCompanies(query: string, candidates: CompanyCandidate[], limit = 8): CompanySuggestion[] {
  const q = normalizeCompany(query);
  if (!q) return [];
  // one entry per distinct company; a name you already use beats the directory's spelling of it
  const unique = new Map<string, CompanyCandidate>();
  for (const c of candidates) {
    const key = normalizeCompany(c.name);
    if (!key) continue;
    const have = unique.get(key);
    if (!have || (have.source === "directory" && c.source === "yours")) unique.set(key, c);
  }
  const hits: (CompanySuggestion & { key: string; dist: number })[] = [];
  for (const [key, c] of unique) {
    const match = classify(q, key);
    // closeness, used only to order near-misses: "Rippling" (1 edit from "ripling") before "Relling" (2)
    if (match) hits.push({ ...c, match, key, dist: match === "similar" ? (nearMiss(q, key) ?? 0) : 0 });
  }
  // near-misses are a fallback for when the real matches are few
  const strong = hits.filter((h) => h.match !== "similar").length;
  const shown = strong >= 3 ? hits.filter((h) => h.match !== "similar") : hits;
  shown.sort(
    (a, b) =>
      RANK[a.match] - RANK[b.match] ||
      a.dist - b.dist ||
      Number(b.source === "yours") - Number(a.source === "yours") ||
      a.key.length - b.key.length ||
      a.name.localeCompare(b.name),
  );
  return shown.slice(0, limit).map(({ key: _key, dist: _dist, ...s }) => s);
}
