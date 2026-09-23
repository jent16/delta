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

const US_STATE_ABBR = new Set(
  "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(" ")
);
const US_STATE_NAMES = new Set(
  [
    "Alabama","Alaska","Arizona","Arkansas","California","Colorado","Connecticut","Delaware",
    "Florida","Georgia","Hawaii","Idaho","Illinois","Indiana","Iowa","Kansas","Kentucky",
    "Louisiana","Maine","Maryland","Massachusetts","Michigan","Minnesota","Mississippi",
    "Missouri","Montana","Nebraska","Nevada","New Hampshire","New Jersey","New Mexico",
    "New York","North Carolina","North Dakota","Ohio","Oklahoma","Oregon","Pennsylvania",
    "Rhode Island","South Carolina","South Dakota","Tennessee","Texas","Utah","Vermont",
    "Virginia","Washington","West Virginia","Wisconsin","Wyoming",
  ]
);
// bare tokens (no state/country suffix) that are unambiguously US in practice
const US_BARE_TOKENS = new Set(["NYC", "SF", "South SF", "DC", "San Francisco", "United States"]);

// One location string can plausibly match more than one region (rare); we
// only need "does this posting have at least one location in region X".
function locationMatchesRegion(loc, region) {
  if (region === "canada") return /canada/i.test(loc);
  if (region === "us") {
    if (/canada/i.test(loc)) return false;
    if (/remote in (the )?us(a)?$/i.test(loc)) return true;
    const stateSuffix = loc.match(/,\s*([A-Z]{2})$/);
    if (stateSuffix && US_STATE_ABBR.has(stateSuffix[1])) return true;
    if (US_STATE_NAMES.has(loc.trim())) return true;
    if (US_STATE_ABBR.has(loc.trim())) return true; // bare "LA", "FL", etc.
    if (US_BARE_TOKENS.has(loc.trim())) return true;
    return false;
  }
  if (region === "intl") {
    return !locationMatchesRegion(loc, "us") && !locationMatchesRegion(loc, "canada");
  }
  return true; // region === "all"
}

function categoryGroup(rawCategory) {
  for (const [group, values] of Object.entries(CATEGORY_GROUPS)) {
    if (values.includes(rawCategory)) return group;
  }
  return "other";
}

// opts: { type: 'intern'|'newgrad', term?, region?, category?, limit? }
async function findOpenings(opts) {
  const type = opts.type === "newgrad" ? "newgrad" : "intern";
  const region = opts.region || "all";
  const category = opts.category || "all";
  const limit = Math.min(opts.limit || 100, 500);

  const all = await fetchListings(type);
  const active = all.filter((d) => d.active && d.is_visible);

  const availableTerms = type === "intern"
    ? [...new Set(active.flatMap((d) => d.terms || []))].filter((t) => t !== "N/A").sort()
    : [];

  let filtered = active;
  if (opts.term && type === "intern") {
    filtered = filtered.filter((d) => (d.terms || []).includes(opts.term));
  }
  if (region !== "all") {
    filtered = filtered.filter((d) => (d.locations || []).some((l) => locationMatchesRegion(l, region)));
  }
  if (category !== "all") {
    filtered = filtered.filter((d) => categoryGroup(d.category) === category);
  }

  filtered = [...filtered].sort((a, b) => (b.date_posted || 0) - (a.date_posted || 0));

  const listings = filtered.slice(0, limit).map((d) => ({
    company: d.company_name,
    title: d.title,
    category: d.category,
    terms: d.terms || [],
    locations: d.locations || [],
    sponsorship: d.sponsorship,
    url: d.url,
    datePosted: d.date_posted ? new Date(d.date_posted * 1000).toISOString() : null,
  }));

  return { total: filtered.length, returned: listings.length, availableTerms, listings };
}

module.exports = { findOpenings, CATEGORY_GROUPS };
