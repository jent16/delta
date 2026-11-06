// Company names from Simplify's public internship and new-grad listings, for
// the company search box. Only names are used, and closed postings are kept on
// purpose: a company you applied to last cycle should still be findable.
//
// The list is cached on disk so search is instant and works offline after the
// first fetch. If a refresh fails, the stale cache is used rather than nothing.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CompanyDirectory } from "../domain/ports.ts";

const SOURCES = [
  "https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json",
  "https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json",
];

interface Cache {
  fetchedAt: number;
  names: string[];
}

export function createSimplifyDirectory(opts: { cacheFile: string; maxAgeHours?: number; fetchImpl?: typeof fetch; now?: () => number; sources?: string[] }): CompanyDirectory {
  const maxAgeMs = (opts.maxAgeHours ?? 24 * 7) * 3_600_000;
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const sources = opts.sources ?? SOURCES;
  let memory: Cache | null = null;

  const readCache = (): Cache | null => {
    if (memory) return memory;
    try {
      const c = JSON.parse(readFileSync(opts.cacheFile, "utf8")) as Cache;
      if (typeof c.fetchedAt === "number" && Array.isArray(c.names)) return (memory = c);
    } catch {
      /* no cache yet, or unreadable: treated as none */
    }
    return null;
  };

  const refresh = async (): Promise<Cache> => {
    const seen = new Map<string, string>(); // lowercase -> first spelling
    const lists = await Promise.all(
      sources.map(async (url) => {
        const res = await doFetch(url);
        if (!res.ok) throw new Error(`${res.status} from ${new URL(url).pathname.split("/")[2]}`);
        return (await res.json()) as { company_name?: unknown }[];
      }),
    );
    for (const list of lists) {
      for (const item of list) {
        const name = typeof item.company_name === "string" ? item.company_name.trim() : "";
        if (name && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
      }
    }
    const cache: Cache = { fetchedAt: now(), names: [...seen.values()].sort((a, b) => a.localeCompare(b)) };
    mkdirSync(dirname(opts.cacheFile), { recursive: true });
    const temp = `${opts.cacheFile}.tmp`;
    writeFileSync(temp, JSON.stringify(cache));
    renameSync(temp, opts.cacheFile); // never leave a half-written cache
    return (memory = cache);
  };

  return {
    async names() {
      const cached = readCache();
      if (cached && now() - cached.fetchedAt < maxAgeMs) return { names: cached.names, available: true };
      try {
        return { names: (await refresh()).names, available: true };
      } catch (e) {
        const why = e instanceof Error ? e.message : "unknown error";
        if (cached) return { names: cached.names, available: true, note: `couldn't refresh the company list (${why}); using the copy from ${new Date(cached.fetchedAt).toISOString().slice(0, 10)}` };
        return { names: [], available: false, note: `couldn't load the company list (${why}); only companies already in your tracker are suggested` };
      }
    },
  };
}
