// Closed list of employer sectors. Claude picks one per posting at ingest
// time, from the company name and posting content — same reasoning as
// lib/tracks.js: a free-form string would fragment into "Fintech" /
// "Financial Technology" / "Banking" for what's really one bucket.
//
// Unlike tracks, this list isn't per-role: a Backend Engineer Intern
// posting could be at a fintech, a hospital system, a game studio, etc. —
// industry is a property of the employer, not the job function.
const INDUSTRIES = [
  "Fintech",
  "Healthcare",
  "E-commerce/Retail",
  "Enterprise Software",
  "Consumer Tech",
  "Gaming/Entertainment",
  "Automotive/Transportation",
  "Aerospace/Defense",
  "Telecom",
  "Energy",
  "Government/Public Sector",
  "Consulting",
  "Education",
  "Media",
  "General Technology",
];

module.exports = { INDUSTRIES };
