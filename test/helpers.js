// Shared fixtures. The fixture DB is built by the real build_db.py from tiny
// CSVs, so every test that uses it also exercises the real schema + loader.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");

// Backend Engineer Intern: 6 postings chosen to sit exactly on the tier
// boundaries (MIN_SHARE 0.5, PREF_SHARE 0.2), 5 of them with skills:
//   Python  required in 5/6 -> minimum
//   SQL     required in 3/6 -> minimum (exactly 50% — boundary is inclusive)
//   Git     required in 2/6, mentioned 2/6 -> preferred (not minimum)
//   Docker  preferred in 2/6 -> preferred
//   Rust    preferred in 1/6 (16.7%) -> below both thresholds, rolled up nowhere
// p6 has no skills at all. Product Manager Intern has 2 skill-less postings.
const FILES = {
  "skills.csv": `name,category
Python,language
SQL,language
Git,tool
Docker,tool
Rust,language
`,
  "roles.csv": `title
Backend Engineer Intern
Product Manager Intern
`,
  "job_postings.csv": [
    "role_title,source,external_id,company,title,url,track,industry,description,fetched_at",
    ...[1, 2, 3, 4, 5, 6].map(
      (i) => `Backend Engineer Intern,adzuna,b${i},Co${i},Backend Intern,,Backend,${i % 2 ? "Fintech" : "Consumer Tech"},desc,2026-09-01T00:00:00Z`
    ),
    "Product Manager Intern,adzuna,pm1,PmCo1,PM Intern,,General,Fintech,desc,2026-09-01T00:00:00Z",
    "Product Manager Intern,adzuna,pm2,PmCo2,PM Intern,,General,,desc,2026-09-01T00:00:00Z",
  ].join("\n") + "\n",
  "posting_skills.csv": `source,external_id,skill_name,level
adzuna,b1,Python,required
adzuna,b1,SQL,required
adzuna,b1,Git,required
adzuna,b2,Python,required
adzuna,b2,SQL,required
adzuna,b2,Git,required
adzuna,b3,Python,required
adzuna,b3,SQL,required
adzuna,b3,Docker,preferred
adzuna,b4,Python,required
adzuna,b4,Docker,preferred
adzuna,b5,Python,required
adzuna,b5,Rust,preferred
`,
};

// returns { dir, dbPath } — a temp dir holding schema.sql, build_db.py, data/
// and a built delta.db. Call rebuild(dir) to re-run build_db.py in place.
function makeFixtureDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delta-test-"));
  fs.copyFileSync(path.join(ROOT, "schema.sql"), path.join(dir, "schema.sql"));
  fs.copyFileSync(path.join(ROOT, "build_db.py"), path.join(dir, "build_db.py"));
  fs.mkdirSync(path.join(dir, "data"));
  for (const [name, body] of Object.entries(FILES)) fs.writeFileSync(path.join(dir, "data", name), body);
  rebuild(dir);
  return { dir, dbPath: path.join(dir, "delta.db") };
}

function rebuild(dir) {
  execFileSync("python3", ["build_db.py"], { cwd: dir, stdio: "pipe" });
}

// a minimal but valid one-page PDF containing `line` as text
function tinyPdf(line) {
  const stream = `BT /F1 12 Tf 72 720 Td (${line.replace(/[()\\]/g, "")}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

module.exports = { ROOT, FILES, makeFixtureDb, rebuild, tinyPdf };
