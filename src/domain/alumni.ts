// "Find people": builds SEARCH LINKS you open in your own browser, nothing more.
//
// Deliberately not scraping, not automation, and not a call to any LinkedIn interface: it only assembles a
// normal search address so you can look at the results yourself, logged in as you.
//
// With a school set, the searches look for that school's alumni at the company. With none set (the default:
// most people will not share a school with anyone you search for), they look for anyone who works at the
// company, and recruiters there. Pure, so the addresses are tested exactly.

export interface AlumniLink {
  id: "linkedin-alumni" | "google-alumni" | "linkedin-people" | "google-people" | "linkedin-recruiters";
  label: string;
  url: string;
}

// quotes in a name would break out of an exact-phrase search, and control characters have no business in one
const clean = (s: string) => s.replace(/["\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();

export function alumniLinks(school: string, company: string): AlumniLink[] {
  const sch = clean(school);
  const co = clean(company);
  if (!co) return [];
  const linkedin = (keywords: string) => `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords)}`;
  const google = (q: string) => `https://www.google.com/search?q=${encodeURIComponent(q)}`;
  const recruiters = { id: "linkedin-recruiters" as const, label: `Recruiters at ${co} on LinkedIn`, url: linkedin(`${co} university recruiter`) };
  if (!sch) {
    return [
      { id: "linkedin-people", label: `People at ${co} on LinkedIn`, url: linkedin(co) },
      { id: "google-people", label: `People at ${co} on Google`, url: google(`site:linkedin.com/in "${co}"`) },
      recruiters,
    ];
  }
  return [
    { id: "linkedin-alumni", label: `${sch} alumni at ${co} on LinkedIn`, url: linkedin(`${sch} ${co}`) },
    { id: "google-alumni", label: `${sch} alumni at ${co} on Google`, url: google(`site:linkedin.com/in "${sch}" "${co}"`) },
    recruiters,
  ];
}

/** True when the links are school-based (so a person found through them is probably an alum). */
export const linksAreSchoolBased = (links: readonly AlumniLink[]) => links.some((l) => l.id === "linkedin-alumni");
