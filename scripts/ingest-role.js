// Pulls real job postings for a role from Adzuna, extracts required/preferred
// skills from each posting with Claude, and merges the result into
// data/roles.csv, data/skills.csv, data/role_skills.csv, data/job_postings.csv.
//
// Usage:
//   node scripts/ingest-role.js --query "software engineer intern" \
//     [--title "Software Engineer Intern"] [--industry Technology] \
//     [--limit 15] [--country ca]
//
// After it finishes, rebuild the database with: python3 build_db.py
//
// Requires ADZUNA_APP_ID / ADZUNA_APP_KEY / ANTHROPIC_API_KEY in .env
// (see .env.example).
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { norm, extractRoleSkills } = require("../lib/extract-skills");

const DATA_DIR = path.join(__dirname, "..", "data");

// ---------- minimal RFC4180 CSV read/write (no external dep) ----------

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const s = text.replace(/\r\n/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const header = rows.shift();
  if (!header) return [];
  return rows
    .filter((r) => !(r.length === 1 && r[0] === ""))
    .map((r) => Object.fromEntries(header.map((h, idx) => [h, r[idx] ?? ""])));
}

function toCSVField(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function readCSV(name) {
  const p = path.join(DATA_DIR, name);
  if (!fs.existsSync(p)) return [];
  return parseCSV(fs.readFileSync(p, "utf8"));
}

function writeCSV(name, header, rows) {
  const lines = [header.join(","), ...rows.map((r) => r.map(toCSVField).join(","))];
  fs.writeFileSync(path.join(DATA_DIR, name), lines.join("\n") + "\n");
}

// ---------- Adzuna ----------

async function fetchPostings(query, country, limit) {
  const url = new URL(`https://api.adzuna.com/v1/api/jobs/${country}/search/1`);
  url.searchParams.set("app_id", process.env.ADZUNA_APP_ID);
  url.searchParams.set("app_key", process.env.ADZUNA_APP_KEY);
  url.searchParams.set("results_per_page", String(limit));
  url.searchParams.set("what", query);
  url.searchParams.set("content-type", "application/json");

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Adzuna request failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return (data.results || []).map((r) => ({
    externalId: String(r.id ?? ""),
    company: r.company?.display_name || "",
    title: r.title || "",
    url: r.redirect_url || "",
    description: r.description || "",
  }));
}

// ---------- pipeline ----------

async function ingestRole({ query, roleTitle, industry, limit, country }) {
  const skills = readCSV("skills.csv");
  const roles = readCSV("roles.csv");
  const roleSkills = readCSV("role_skills.csv");
  const jobPostings = readCSV("job_postings.csv");

  const skillByKey = new Map(skills.map((s) => [norm(s.name), s]));

  console.log(`Fetching postings for "${query}" from Adzuna (${country})...`);
  const postings = await fetchPostings(query, country, limit);
  if (postings.length === 0) {
    console.error("No postings found — try a broader query.");
    process.exit(1);
  }
  console.log(`Got ${postings.length} postings. Extracting skills with Claude...`);

  const counts = new Map(); // normalized name -> { name, category, required, preferred }
  for (const posting of postings) {
    let extracted = [];
    try {
      extracted = await extractRoleSkills(posting, skills.map((s) => s.name));
    } catch (err) {
      console.warn(`  skip "${posting.title}" @ ${posting.company}: ${err.message}`);
      continue;
    }
    for (const s of extracted) {
      const key = norm(s.name);
      const canonical = skillByKey.get(key)?.name || s.name.trim();
      if (!counts.has(key)) {
        counts.set(key, {
          name: canonical,
          category: skillByKey.get(key)?.category || s.category,
          required: 0,
          preferred: 0,
        });
      }
      const c = counts.get(key);
      if (s.level === "required") c.required++;
      else c.preferred++;
    }
  }

  const total = postings.length;
  const weighted = [...counts.values()]
    .map((c) => ({
      ...c,
      weight: Math.min(1, +(((c.required + 0.5 * c.preferred) / total).toFixed(2))),
    }))
    .sort((a, b) => b.weight - a.weight);

  // --- roles.csv: add if new ---
  const roleKey = norm(roleTitle);
  if (!roles.some((r) => norm(r.title) === roleKey)) {
    roles.push({ title: roleTitle, industry });
    writeCSV("roles.csv", ["title", "industry"], roles.map((r) => [r.title, r.industry]));
    console.log(`+ role: ${roleTitle}`);
  }

  // --- skills.csv: append genuinely new skills ---
  let addedSkills = 0;
  for (const c of weighted) {
    const key = norm(c.name);
    if (!skillByKey.has(key)) {
      skills.push({ name: c.name, category: c.category });
      skillByKey.set(key, { name: c.name, category: c.category });
      addedSkills++;
    }
  }
  if (addedSkills) {
    writeCSV("skills.csv", ["name", "category"], skills.map((s) => [s.name, s.category]));
    console.log(`+ ${addedSkills} new skill(s)`);
  }

  // --- role_skills.csv: replace this role's prior rows with fresh weights ---
  const kept = roleSkills.filter((rs) => norm(rs.role_title) !== roleKey);
  const fresh = weighted.map((c) => ({ role_title: roleTitle, skill_name: c.name, weight: c.weight }));
  writeCSV(
    "role_skills.csv",
    ["role_title", "skill_name", "weight"],
    [...kept, ...fresh].map((rs) => [rs.role_title, rs.skill_name, rs.weight])
  );

  // --- job_postings.csv: append for traceability ---
  const fetchedAt = new Date().toISOString();
  const newRows = postings.map((p) => ({
    role_title: roleTitle,
    source: "adzuna",
    external_id: p.externalId,
    company: p.company,
    title: p.title,
    url: p.url,
    fetched_at: fetchedAt,
  }));
  writeCSV(
    "job_postings.csv",
    ["role_title", "source", "external_id", "company", "title", "url", "fetched_at"],
    [...jobPostings, ...newRows].map((p) => [
      p.role_title,
      p.source,
      p.external_id,
      p.company,
      p.title,
      p.url,
      p.fetched_at,
    ])
  );

  console.log(`\n${roleTitle}: ${weighted.length} skills derived from ${total} postings`);
  for (const c of weighted) {
    console.log(
      `  ${c.name.padEnd(20)} weight=${c.weight}  (required in ${c.required}, preferred in ${c.preferred})`
    );
  }
  console.log(`\nRun "python3 build_db.py" to rebuild delta.db with this data.`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.query) {
  console.error(
    'Usage: node scripts/ingest-role.js --query "software engineer intern" [--title "Software Engineer Intern"] [--industry Technology] [--limit 15] [--country ca]'
  );
  process.exit(1);
}
if (!process.env.ADZUNA_APP_ID || !process.env.ADZUNA_APP_KEY) {
  console.error(
    "Missing ADZUNA_APP_ID/ADZUNA_APP_KEY. Copy .env.example to .env and fill in credentials from https://developer.adzuna.com/."
  );
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "Missing ANTHROPIC_API_KEY. Copy .env.example to .env and fill in a key from https://console.anthropic.com/."
  );
  process.exit(1);
}

ingestRole({
  query: args.query,
  roleTitle: args.title || args.query.replace(/\b\w/g, (c) => c.toUpperCase()),
  industry: args.industry || "Technology",
  limit: parseInt(args.limit || "15", 10),
  country: args.country || "ca",
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
