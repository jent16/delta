// Turning LinkedIn's "Connections.csv" into people you could add. Everything here is pure: text in, plans out.
//
// The policy (decision 40): import only the connections who work at a company you ALREADY HAVE (an application
// or another contact there). Most of a network works somewhere you never applied; importing all of them would
// bury the Companies screen in hundreds of companies you don't care about. The rest are counted, not kept.
//
// Company names are matched in tiers, and only the first two ever link automatically:
//   exact       same name ignoring case and spacing
//   normalized  same after dropping "Inc.", "LLC", punctuation ("Stripe, Inc." = "Stripe")
//   similar     a known alias (AWS = Amazon), your company's name as the start of theirs ("Stripe Payments
//               Europe"), or a near-miss spelling: shown as "did you mean...?", linked only if you say so
//   none        not a company you have: skipped
// A wrong automatic link would silently attach a person to the wrong company, so anything uncertain asks.

import { nearMiss, normalizeCompany } from "./company.ts";
import { isLinkedInUrl } from "./contact.ts";
import type { Relationship } from "./contact.ts";
import { isIsoDate } from "./dates.ts";
import { identityKey } from "./keys.ts";

// ---------------------------------------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------------------------------------

/** A forgiving CSV reader: quoted fields, doubled quotes, commas and newlines inside quotes, CRLF or LF, a byte-order mark. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const endRow = () => { row.push(field); rows.push(row); row = []; field = ""; };
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") endRow();
    else if (c === "\r") { if (text[i + 1] === "\n") i++; endRow(); }
    else field += c;
  }
  if (field !== "" || row.length) endRow();
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

export interface ConnectionRow {
  /** The row's line number in the file (for messages). */
  line: number;
  firstName: string;
  lastName: string;
  url: string;
  email: string;
  company: string;
  position: string;
  connectedOn: string;
}

const HEADERS: Record<keyof Omit<ConnectionRow, "line">, string[]> = {
  firstName: ["first name"],
  lastName: ["last name"],
  url: ["url", "profile url", "linkedin url"],
  email: ["email address", "email"],
  company: ["company", "company name", "organization"],
  position: ["position", "title", "job title"],
  connectedOn: ["connected on", "connected"],
};

export interface ParsedConnections {
  rows: ConnectionRow[];
  /** False when no row looked like a header: this is probably not a Connections file. */
  headerFound: boolean;
  /** Rows that couldn't be read at all (shorter than the header, or blank names). */
  unreadable: { line: number; reason: string }[];
}

/**
 * LinkedIn's export has had a few "Notes:" lines above the header at times, so the header is FOUND (the first row
 * that has both "First Name" and "Last Name"), not assumed to be line one. Columns are located by name, so a
 * reordered or extended file still works.
 */
export function parseConnections(text: string): ParsedConnections {
  const all = parseCsv(text);
  const headerAt = all.findIndex((r) => {
    const cells = r.map((c) => c.trim().toLowerCase());
    return cells.includes("first name") && cells.includes("last name");
  });
  if (headerAt < 0) return { rows: [], headerFound: false, unreadable: [] };
  const header = all[headerAt]!.map((c) => c.trim().toLowerCase());
  const col = (field: keyof typeof HEADERS) => header.findIndex((h) => HEADERS[field].includes(h));
  const idx = Object.fromEntries((Object.keys(HEADERS) as (keyof typeof HEADERS)[]).map((f) => [f, col(f)])) as Record<keyof typeof HEADERS, number>;
  const rows: ConnectionRow[] = [];
  const unreadable: ParsedConnections["unreadable"] = [];
  all.slice(headerAt + 1).forEach((r, n) => {
    const line = headerAt + n + 2; // counted from the header's line; blank lines were already dropped, so this is approximate
    const cell = (f: keyof typeof HEADERS) => (idx[f] >= 0 ? (r[idx[f]] ?? "").trim() : "");
    if (r.length < 2) { unreadable.push({ line, reason: "too few columns" }); return; }
    rows.push({ line, firstName: cell("firstName"), lastName: cell("lastName"), url: cell("url"), email: cell("email"), company: cell("company"), position: cell("position"), connectedOn: cell("connectedOn") });
  });
  return { rows, headerFound: true, unreadable };
}

// ---------------------------------------------------------------------------------------------------------
// cleaning
// ---------------------------------------------------------------------------------------------------------

const CREDENTIALS = ["cfa", "cpa", "pmp", "phd", "mba", "md", "p.eng", "peng", "cissp", "frm", "csm", "pe", "ms", "msc", "bsc", "eit"];
const PICTO = /[\p{Extended_Pictographic}‍️]/gu;

/** A display name: pronouns in brackets, emoji and trailing credentials ("Jo Lee, CFA") removed. Unknown suffixes are kept as written. */
export function cleanName(first: string, last: string): string {
  let n = `${first} ${last}`.replace(PICTO, " ").replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  const m = /^(.*?),\s*([A-Za-z.]+)(?:\s*,\s*[A-Za-z.]+)*$/.exec(n); // "Jo Lee, CFA" or "Jo Lee, MBA, CFA"
  if (m && CREDENTIALS.includes(m[2]!.toLowerCase().replace(/\./g, "")) ) n = m[1]!.trim();
  return n.replace(/\s+/g, " ").trim();
}

/** "linkedin.com/in/jane-doe" for any form of the same profile link (case, query string, trailing slash, locale subdomain), or null if it isn't a valid LinkedIn profile link. */
export function normalizeProfileUrl(url: string): string | null {
  if (!isLinkedInUrl(url)) return null;
  const u = new URL(url);
  const m = /^\/in\/([^/]+)\/?/.exec(u.pathname);
  if (!m) return null;
  let slug: string;
  try { slug = decodeURIComponent(m[1]!); } catch { slug = m[1]!; }
  return `linkedin.com/in/${slug.toLowerCase()}`;
}

/** The address to store: the canonical https form of a valid profile link. */
export const canonicalProfileUrl = (url: string): string | null => {
  const k = normalizeProfileUrl(url);
  return k ? `https://www.${k}` : null;
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const cleanEmail = (email: string): string | null => (EMAIL.test(email.trim()) && email.trim().length <= 254 ? email.trim() : null);

const MONTHS: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
/** LinkedIn writes "05 Nov 2026"; ISO dates are accepted too. Anything else is null (it is only a note, so never a reason to refuse a row). */
export function parseConnectedOn(text: string): string | null {
  const t = text.trim();
  if (isIsoDate(t)) return t;
  const m = /^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{4})$/.exec(t);
  if (!m) return null;
  const mm = MONTHS[m[2]!.toLowerCase()];
  const iso = mm ? `${m[3]}-${mm}-${m[1]!.padStart(2, "0")}` : "";
  return iso && isIsoDate(iso) ? iso : null;
}

const RECRUITER = /\b(recruit\w*|talent acquisition|sourcer|university relations|campus|early careers?)\b/i;
/** Only a suggestion, shown as a guess: the export has no school, so "alumni" can't be inferred at all. */
export function guessRelationship(position: string): { relationship: Relationship; guessed: boolean } {
  return RECRUITER.test(position) ? { relationship: "recruiter", guessed: true } : { relationship: "other", guessed: false };
}

/** The key that says "this is the same person" when importing twice: the profile link, else the email, else name and company. */
export function connectionKey(r: { url: string; email: string; name: string; company: string }): string {
  const url = normalizeProfileUrl(r.url);
  if (url) return `url:${url}`;
  const email = cleanEmail(r.email);
  if (email) return `email:${email.toLowerCase()}`;
  return `name:${identityKey(r.name)}|${identityKey(r.company)}`;
}

// ---------------------------------------------------------------------------------------------------------
// matching a company name to the companies you have
// ---------------------------------------------------------------------------------------------------------

export interface OwnCompany {
  id: number;
  name: string;
}

export type MatchTier = "exact" | "normalized" | "similar" | "none";
export interface CompanyMatch {
  tier: MatchTier;
  /** For exact and normalized: the company it links to. */
  company?: OwnCompany;
  /** For similar: who it might be, best first (at most 3). */
  candidates?: OwnCompany[];
}

// Names a company is known by, mapped to the name YOU would have typed. Deliberately short and unambiguous:
// each is only ever offered as a suggestion, and a missing entry just means no suggestion.
const ALIASES: Record<string, string> = {
  "amazon web services": "amazon", "aws": "amazon", "amazon web services aws": "amazon",
  "meta platforms": "meta", "facebook": "meta",
  "jpmorgan chase": "jpmorgan", "jp morgan chase": "jpmorgan", "j p morgan": "jpmorgan",
  "alphabet": "google", "google cloud": "google", "youtube": "google",
};

const norm = (name: string) => normalizeCompany(name.replace(PICTO, " "));

export function matchCompany(raw: string, own: OwnCompany[]): CompanyMatch {
  const cleaned = raw.replace(PICTO, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return { tier: "none" };
  const key = identityKey(cleaned);
  const exact = own.find((c) => identityKey(c.name) === key);
  if (exact) return { tier: "exact", company: exact };

  const q = norm(cleaned);
  if (!q) return { tier: "none" };
  const same = own.filter((c) => norm(c.name) === q);
  if (same.length === 1) return { tier: "normalized", company: same[0]! };
  if (same.length > 1) return { tier: "similar", candidates: same.slice(0, 3) }; // two of your companies normalize alike: don't guess which

  // similar: gather candidates with a reason rank (alias < word-prefix < near-miss), best first
  const ranked: { c: OwnCompany; rank: number; dist: number }[] = [];
  const alias = ALIASES[q];
  for (const c of own) {
    const n = norm(c.name);
    if (!n) continue;
    if (alias !== undefined && alias === n) ranked.push({ c, rank: 0, dist: 0 });
    else if (n.length >= 4 && q.startsWith(`${n} `)) ranked.push({ c, rank: 1, dist: 0 });                                  // "stripe payments europe" -> "stripe"
    else if (q.length >= 4 && n.startsWith(`${q} `)) ranked.push({ c, rank: 2, dist: 0 });                                  // "stripe" -> your "Stripe Payments"
    else { const d = nearMiss(q, n); if (d !== null) ranked.push({ c, rank: 3, dist: d }); }
  }
  if (!ranked.length) return { tier: "none" };
  ranked.sort((a, b) => a.rank - b.rank || a.dist - b.dist || a.c.name.localeCompare(b.c.name));
  return { tier: "similar", candidates: ranked.slice(0, 3).map((r) => r.c) };
}

// ---------------------------------------------------------------------------------------------------------
// the plan
// ---------------------------------------------------------------------------------------------------------

export type PlanAction =
  | "create"              // will be added
  | "needs_confirmation"  // the company is only a "similar" match: waits for you
  | "already_imported"    // imported before (even if you have since deleted them)
  | "already_in_people"   // you already have this person
  | "duplicate_in_file"   // the same person twice in the file; the first one counts
  | "untracked"           // works at a company you don't have
  | "no_company"          // no company on the profile
  | "invalid";            // no name

export interface PlanRow {
  key: string;
  line: number;
  name: string;
  position: string | null;
  /** The company text as LinkedIn has it. */
  company: string | null;
  match: CompanyMatch;
  /** The company it will be added to: your company's name (for "create"). */
  addTo: OwnCompany | null;
  linkedinUrl: string | null;
  email: string | null;
  connectedOn: string | null;
  relationship: Relationship;
  relationshipGuessed: boolean;
  action: PlanAction;
  reason?: string;
}

export interface ExistingContact {
  name: string;
  company: string | null;
  linkedinUrl: string | null;
}

export interface PlanContext {
  companies: OwnCompany[];
  /** Keys imported before (the value is the contact id, or null if that contact was deleted). */
  known: Map<string, number | null>;
  existing: ExistingContact[];
  /** The company id you chose for a "similar" row, by the row's key. */
  accept: Record<string, number>;
}

export function planConnections(rows: ConnectionRow[], ctx: PlanContext): PlanRow[] {
  const existingUrls = new Set(ctx.existing.map((c) => (c.linkedinUrl ? normalizeProfileUrl(c.linkedinUrl) : null)).filter((u): u is string => u !== null));
  const existingNames = new Set(ctx.existing.map((c) => `${identityKey(c.name)}|${identityKey(c.company)}`));
  const seen = new Set<string>();
  const ownById = new Map(ctx.companies.map((c) => [c.id, c]));

  return rows.map((r): PlanRow => {
    const name = cleanName(r.firstName, r.lastName);
    const urlKey = normalizeProfileUrl(r.url);
    const url = urlKey ? `https://www.${urlKey}` : null;
    const company = r.company.replace(PICTO, " ").replace(/\s+/g, " ").trim() || null;
    const key = connectionKey({ url: r.url, email: r.email, name, company: company ?? "" });
    const { relationship, guessed } = guessRelationship(r.position);
    const base: PlanRow = {
      key, line: r.line, name, position: r.position.trim() || null, company, match: { tier: "none" }, addTo: null,
      linkedinUrl: url, email: cleanEmail(r.email), connectedOn: parseConnectedOn(r.connectedOn), relationship, relationshipGuessed: guessed, action: "invalid",
    };
    if (!name) return { ...base, reason: "no name" };

    if (ctx.known.has(key)) return { ...base, action: "already_imported", reason: ctx.known.get(key) === null ? "imported before, then deleted by you" : "imported before" };
    const nameKey = `${identityKey(name)}|${identityKey(company)}`;
    if ((urlKey && existingUrls.has(urlKey)) || existingNames.has(nameKey)) return { ...base, action: "already_in_people", reason: "you already have this person" };
    if (seen.has(key)) return { ...base, action: "duplicate_in_file", reason: "appears more than once in the file" };
    seen.add(key);

    if (!company) return { ...base, action: "no_company", reason: "no company on the profile" };
    const match = matchCompany(company, ctx.companies);
    if (match.tier === "exact" || match.tier === "normalized") return { ...base, match, addTo: match.company!, action: "create" };
    if (match.tier === "similar") {
      const chosen = ctx.accept[key];
      const picked = chosen !== undefined ? match.candidates!.find((c) => c.id === chosen) ?? null : null; // only one of the offered candidates counts
      if (picked && ownById.has(picked.id)) return { ...base, match, addTo: picked, action: "create", reason: "company confirmed by you" };
      return { ...base, match, action: "needs_confirmation", reason: `is "${company}" the same as ${match.candidates!.map((c) => `"${c.name}"`).join(" or ")}?` };
    }
    return { ...base, match, action: "untracked", reason: "works at a company you don't have" };
  });
}
