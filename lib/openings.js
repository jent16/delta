// Curated listings pulled straight from Simplify's public, no-auth-required
// datasets — not scraped, just fetched and filtered. Zero Claude calls: this
// is plain data, separate from the ingestion/scoring pipeline entirely.
//
// Position type ("intern" vs "newgrad") is which of Simplify's two repos you
// read from, not a field within one dataset.

const SOURCES = {
  intern: "https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json",
  newgrad: "https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json",
};

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour — Simplify updates daily, no need to refetch every request
const cache = new Map(); // type -> { data, fetchedAt }

async function fetchListings(type) {
  const cached = cache.get(type);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.data;

  const url = SOURCES[type];
  if (!url) throw new Error(`unknown listings type: ${type}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetching ${type} listings failed: ${res.status}`);
  const data = await res.json();
  cache.set(type, { data, fetchedAt: Date.now() });
  return data;
}

// Raw `category` values are inconsistently named across entries
// ("Software" vs "Software Engineering"); group them for filtering.
const CATEGORY_GROUPS = {
  software: ["Software", "Software Engineering"],
  product: ["Product", "Product Management"],
  hardware: ["Hardware", "Hardware Engineering"],
  data: ["AI/ML/Data", "Data Science, AI & Machine Learning"],
  quant: ["Quant", "Quantitative Finance"],
};

function categoryGroup(rawCategory) {
  for (const [group, values] of Object.entries(CATEGORY_GROUPS)) {
    if (values.includes(rawCategory)) return group;
  }
  return "other";
}

// ---------- term window ----------
// A "Summer 2016" or "Fall 2029" internship term isn't useful to show —
// only the term we're currently in, through one year out. Terms are
// "Winter"/"Spring"/"Summer"/"Fall" + year; each season gets a fixed
// anchor month so terms compare as plain integers (year*12 + anchor).

const SEASON_ANCHOR = { Winter: 0, Spring: 3, Summer: 6, Fall: 9 };
// which season `now` falls in, by calendar month (Dec counts as next year's Winter)
const CURRENT_SEASON_BY_MONTH = [
  "Winter", "Winter", "Spring", "Spring", "Spring", "Summer",
  "Summer", "Summer", "Fall", "Fall", "Fall", "Winter",
];

function termValue(season, year) {
  return year * 12 + SEASON_ANCHOR[season];
}

function parseTerm(term) {
  const m = String(term || "").trim().match(/^(Winter|Spring|Summer|Fall)\s+(\d{4})$/);
  if (!m) return null;
  return termValue(m[1], Number(m[2]));
}

// [current term, current term + 1 year] inclusive
function termWindow(now = new Date()) {
  const month = now.getMonth();
  const season = CURRENT_SEASON_BY_MONTH[month];
  const year = now.getFullYear() + (month === 11 ? 1 : 0); // Dec -> next year's Winter
  const lo = termValue(season, year);
  return { lo, hi: lo + 12 };
}

function isTermRelevant(term, window) {
  const v = parseTerm(term);
  return v !== null && v >= window.lo && v <= window.hi;
}

// ---------- location parsing ----------
// Locations are free-text strings ("San Jose, CA", "Toronto, ON, Canada",
// "Remote in UK", bare "London", bare "NYC"...). One posting can have many.
// parseLocation extracts as much structure as the string actually contains;
// region is always known, subdivision/city are null when we can't tell.

const US_STATE_ABBR = new Set(
  "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(" ")
);
const US_STATE_NAMES = {
  Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA", Colorado: "CO",
  Connecticut: "CT", Delaware: "DE", Florida: "FL", Georgia: "GA", Hawaii: "HI", Idaho: "ID",
  Illinois: "IL", Indiana: "IN", Iowa: "IA", Kansas: "KS", Kentucky: "KY", Louisiana: "LA",
  Maine: "ME", Maryland: "MD", Massachusetts: "MA", Michigan: "MI", Minnesota: "MN",
  Mississippi: "MS", Missouri: "MO", Montana: "MT", Nebraska: "NE", Nevada: "NV",
  "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY",
  "North Carolina": "NC", "North Dakota": "ND", Ohio: "OH", Oklahoma: "OK", Oregon: "OR",
  Pennsylvania: "PA", "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD",
  Tennessee: "TN", Texas: "TX", Utah: "UT", Vermont: "VT", Virginia: "VA", Washington: "WA",
  "West Virginia": "WV", Wisconsin: "WI", Wyoming: "WY",
};
// bare tokens (no state suffix) common enough in practice to hardcode
const US_BARE_CITY_STATE = { NYC: "NY", SF: "CA", "South SF": "CA", "San Francisco": "CA" };
const US_BARE_UNKNOWN = new Set(["United States", "DC"]); // US, but no derivable state

const CA_PROVINCES = new Set(["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"]);

function parseLocation(rawLoc) {
  const loc = String(rawLoc || "").trim();

  if (/canada/i.test(loc)) {
    const m = loc.match(/^(.+),\s*([A-Z]{2}),\s*Canada$/);
    if (m && CA_PROVINCES.has(m[2])) return { region: "canada", subdivision: m[2], city: m[1].trim() };
    return { region: "canada", subdivision: null, city: null };
  }

  if (/remote in (the )?us(a)?$/i.test(loc)) return { region: "us", subdivision: null, city: null };
  const stateSuffix = loc.match(/^(.+),\s*([A-Z]{2})$/);
  if (stateSuffix && US_STATE_ABBR.has(stateSuffix[2])) {
    return { region: "us", subdivision: stateSuffix[2], city: stateSuffix[1].trim() };
  }
  if (US_STATE_ABBR.has(loc)) return { region: "us", subdivision: loc, city: null };
  if (US_STATE_NAMES[loc]) return { region: "us", subdivision: US_STATE_NAMES[loc], city: null };
  if (US_BARE_CITY_STATE[loc]) return { region: "us", subdivision: US_BARE_CITY_STATE[loc], city: loc };
  if (US_BARE_UNKNOWN.has(loc)) return { region: "us", subdivision: null, city: null };

  return { region: "intl", subdivision: null, city: null };
}

// A posting can list many locations; a filter matches if ANY of them do.
function anyLocation(locations, predicate) {
  return (locations || []).some((l) => predicate(parseLocation(l)));
}

// ---------- degree level ----------
// Simplify's `degrees` is the list of degrees a posting accepts (e.g.
// ["Bachelor's", "Master's"]); an empty list means unspecified. Filtering
// to "Bachelor's" should still show unspecified postings — only exclude
// ones that explicitly require something the candidate doesn't have.
function degreeMatches(postingDegrees, level) {
  if (level === "all") return true;
  if (!postingDegrees || postingDegrees.length === 0) return true;
  return postingDegrees.includes(level);
}

// opts: { type, term?, region?, state?, city?, category?, degree?, limit? }
async function findOpenings(opts) {
  const type = opts.type === "newgrad" ? "newgrad" : "intern";
  const region = opts.region || "all";
  const state = opts.state || null; // only meaningful when region is 'us' or 'canada'
  const city = opts.city || null;
  const category = opts.category || "all";
  const degree = opts.degree || "all";
  const limit = Math.min(opts.limit || 100, 500);

  const all = await fetchListings(type);
  let active = all.filter((d) => d.active && d.is_visible);

  // internships only: drop postings whose terms are all in the past or more
  // than a year out — "Summer 2016" or "Fall 2029" isn't useful to see.
  // A posting with any term inside the window still counts, but the term
  // dropdown itself should only ever offer terms that are themselves
  // in-window, not every term of a posting that merely has one.
  const window = termWindow();
  if (type === "intern") {
    active = active.filter((d) => (d.terms || []).some((t) => isTermRelevant(t, window)));
  }

  const availableTerms = type === "intern"
    ? [...new Set(active.flatMap((d) => d.terms || []).filter((t) => isTermRelevant(t, window)))].sort()
    : [];

  let filtered = active;
  if (opts.term && type === "intern") {
    filtered = filtered.filter((d) => (d.terms || []).includes(opts.term));
  }
  if (region !== "all") {
    filtered = filtered.filter((d) => anyLocation(d.locations, (p) => p.region === region));
  }
  // available states/cities are computed from the filters applied so far,
  // so each dropdown only ever offers options that actually cascade —
  // same principle as the term dropdown and the role/industry dropdowns
  const availableStates = region === "us" || region === "canada"
    ? [...new Set(filtered.flatMap((d) => (d.locations || []).map((l) => parseLocation(l)).filter((p) => p.region === region && p.subdivision).map((p) => p.subdivision)))].sort()
    : [];
  if (state) {
    filtered = filtered.filter((d) => anyLocation(d.locations, (p) => p.region === region && p.subdivision === state));
  }
  const availableCities = state
    ? [...new Set(filtered.flatMap((d) => (d.locations || []).map((l) => parseLocation(l)).filter((p) => p.region === region && p.subdivision === state && p.city).map((p) => p.city)))].sort()
    : [];
  if (city) {
    filtered = filtered.filter((d) => anyLocation(d.locations, (p) => p.region === region && p.subdivision === state && p.city === city));
  }
  if (category !== "all") {
    filtered = filtered.filter((d) => categoryGroup(d.category) === category);
  }
  if (degree !== "all") {
    filtered = filtered.filter((d) => degreeMatches(d.degrees, degree));
  }

  filtered = [...filtered].sort((a, b) => (b.date_posted || 0) - (a.date_posted || 0));

  const listings = filtered.slice(0, limit).map((d) => ({
    company: d.company_name,
    title: d.title,
    category: d.category,
    terms: d.terms || [],
    locations: d.locations || [],
    degrees: d.degrees || [],
    sponsorship: d.sponsorship,
    url: d.url,
    datePosted: d.date_posted ? new Date(d.date_posted * 1000).toISOString() : null,
  }));

  return {
    total: filtered.length,
    returned: listings.length,
    availableTerms,
    availableStates,
    availableCities,
    listings,
  };
}

module.exports = { findOpenings, CATEGORY_GROUPS, parseLocation, degreeMatches, parseTerm, termWindow, isTermRelevant };
