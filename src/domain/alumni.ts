// "Find alumni": builds SEARCH LINKS you open in your own browser, nothing more.
//
// Deliberately not scraping, not automation, and not a call to any LinkedIn interface: it only assembles a
// normal search address (school + company) so you can look at the results yourself, logged in as you.
// Pure, so the addresses are tested exactly.

export const DEFAULT_SCHOOL = "Simon Fraser University";

export interface AlumniLink {
  id: "linkedin-alumni" | "google-alumni" | "linkedin-recruiters";
  label: string;
  url: string;
}

// quotes in a name would break out of an exact-phrase search, and control characters have no business in one
const clean = (s: string) => s.replace(/["\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();

export function alumniLinks(school: string, company: string): AlumniLink[] {
  const sch = clean(school) || DEFAULT_SCHOOL;
  const co = clean(company);
  if (!co) return [];
  const linkedin = (keywords: string) => `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords)}`;
  return [
    { id: "linkedin-alumni", label: `${sch} alumni at ${co} on LinkedIn`, url: linkedin(`${sch} ${co}`) },
    { id: "google-alumni", label: `${sch} alumni at ${co} on Google`, url: `https://www.google.com/search?q=${encodeURIComponent(`site:linkedin.com/in "${sch}" "${co}"`)}` },
    { id: "linkedin-recruiters", label: `Recruiters at ${co} on LinkedIn`, url: linkedin(`${co} university recruiter`) },
  ];
}
