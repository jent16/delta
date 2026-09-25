// Pushes a listing into a Notion database as one new row. One-way only: the
// app writes, Notion owns the status (applied / in progress / closed), and
// nothing is ever read back or deleted.
//
// Rather than forcing a fixed layout, each push reads the target database's
// actual property names/types and fills only the ones it recognizes — so it
// adapts to a tracker you already have. Unrecognized properties (including
// Status) are left untouched for you to fill in.
//
// Needs NOTION_TOKEN in .env, and the database shared with that integration.

const NOTION_BASE_URL = process.env.NOTION_BASE_URL || "https://api.notion.com";
const NOTION_VERSION = "2022-06-28";

// property-name candidates (case-insensitive) for each listing field
const FIELD_NAMES = {
  company: ["company", "employer", "organization"],
  role: ["role/program", "role", "position", "job title", "title", "program"],
  term: ["term", "season", "internship term", "start"],
  posted: ["posted", "date posted", "posting date", "posted date", "listed", "opens", "opened", "date opened", "open date"],
  city: ["city", "location", "locations"],
  url: ["url", "link", "posting", "apply", "application link"],
  degree: ["degree", "degrees", "education"],
  sponsorship: ["sponsorship", "visa", "sponsor"],
  category: ["category", "type", "function"],
};

async function notion(method, path, body) {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error("NOTION_TOKEN is not set — add it to .env");
  const res = await fetch(`${NOTION_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const hint =
      res.status === 404
        ? " (is the database shared with your integration? In Notion: ••• menu → Connections → add it)"
        : "";
    throw new Error(`Notion ${res.status}: ${data.message || "request failed"}${hint}`);
  }
  return data;
}

// accepts a bare id or a full notion.so URL
function parseDatabaseId(input) {
  const m = String(input || "").match(/[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m ? m[0].replace(/-/g, "") : null;
}

const text = (s) => [{ type: "text", text: { content: String(s).slice(0, 1900) } }];

// a fresh row shouldn't claim "Applied" — start it in whichever of the
// user's own status options means "saved but not applied", if they have one
const DEFAULT_STATUS_OPTIONS = ["bookmarked", "saved", "to apply", "not applied", "not started", "interested", "todo", "to do"];

function fieldValues(listing) {
  return {
    company: listing.company,
    role: listing.title,
    term: (listing.terms || []).join(", "),
    posted: listing.datePosted ? listing.datePosted.slice(0, 10) : "",
    city: (listing.locations || []).join(" · "),
    url: listing.url,
    degree: (listing.degrees || []).join("/"),
    sponsorship: listing.sponsorship,
    category: listing.category,
  };
}

// convert a plain string into the shape Notion wants for a property type;
// null = don't set this property (type we can't or shouldn't write)
function encode(type, value) {
  if (value === undefined || value === null || value === "") return null;
  switch (type) {
    case "rich_text": return { rich_text: text(value) };
    case "url": return { url: String(value) };
    case "date": return { date: { start: String(value) } };
    case "select": return { select: { name: String(value).replace(/,/g, "").slice(0, 100) } };
    case "multi_select":
      return { multi_select: String(value).split(/,\s*|\s·\s/).filter(Boolean).map((n) => ({ name: n.replace(/,/g, "").slice(0, 100) })) };
    default: return null; // status, people, formulas, etc. stay yours
  }
}

// returns { properties, filled, skipped } for a listing + schema
function buildProperties(schemaProps, listing) {
  const byLower = new Map(Object.entries(schemaProps).map(([name, p]) => [name.toLowerCase(), { name, ...p }]));
  const titleEntry = Object.entries(schemaProps).find(([, p]) => p.type === "title");
  if (!titleEntry) throw new Error("that Notion database has no title property");
  const [titleName] = titleEntry;
  const lookup = (field) => FIELD_NAMES[field].map((n) => byLower.get(n)).find(Boolean);

  // The title column differs per tracker: some use it for the company (one
  // row per company, job title in another column), others for the role.
  // Follow whatever this database does rather than imposing one layout.
  const titleIsCompany = FIELD_NAMES.company.includes(titleName.toLowerCase());
  const hasRoleColumn = !!lookup("role") && lookup("role").type !== "title";
  const hasCompanyColumn = !!lookup("company") && lookup("company").type !== "title";
  let titleText;
  if (titleIsCompany) titleText = listing.company || listing.title;
  else if (hasCompanyColumn) titleText = listing.title;
  else titleText = `${listing.title}${listing.company ? ` — ${listing.company}` : ""}`;

  const properties = { [titleName]: { title: text(titleText) } };
  const filled = [titleName];
  const values = fieldValues(listing);

  for (const field of Object.keys(FIELD_NAMES)) {
    const match = lookup(field);
    if (!match || match.type === "title") continue;
    if (field === "role" && !hasRoleColumn) continue;
    const encoded = encode(match.type, values[field]);
    if (encoded) {
      properties[match.name] = encoded;
      filled.push(match.name);
    }
  }

  // status: only ever set to one of the user's own existing options
  const status = byLower.get("status");
  if (status && (status.type === "select" || status.type === "status")) {
    const options = (status[status.type]?.options || []).map((o) => o.name);
    const pick = options.find((o) => DEFAULT_STATUS_OPTIONS.includes(o.toLowerCase()));
    if (pick) {
      properties[status.name] = { [status.type]: { name: pick } };
      filled.push(status.name);
    }
  }

  const skipped = Object.keys(schemaProps).filter((n) => !filled.includes(n));
  return { properties, filled, skipped };
}

async function getDatabase(databaseId) {
  return notion("GET", `/v1/databases/${databaseId}`);
}

// returns { pageId, filled, skipped }
async function addListing(databaseId, listing) {
  const db = await getDatabase(databaseId);
  const { properties, filled, skipped } = buildProperties(db.properties, listing);
  const page = await notion("POST", "/v1/pages", { parent: { database_id: databaseId }, properties });
  return { pageId: page.id, filled, skipped };
}

module.exports = { parseDatabaseId, getDatabase, addListing, buildProperties };
