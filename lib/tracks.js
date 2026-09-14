// Specialization "tracks" within a broad role title. Claude picks exactly one
// of these per posting at ingest time, so postings group cleanly instead of
// under free-form labels like "ML" / "Machine Learning" / "AI".
//
// Add a track by adding a string. Roles not listed here get the generic list.

const GENERAL = "General";

const TRACKS_BY_ROLE = {
  "software engineer intern": [
    "Backend",
    "Frontend",
    "Full-stack",
    "ML/AI",
    "Embedded/Systems",
    "Mobile",
    "Data",
    "DevOps/Infrastructure",
    GENERAL,
  ],
  "backend engineer intern": ["Backend", "DevOps/Infrastructure", GENERAL],
  "full stack engineer intern": ["Full-stack", "Frontend", "Backend", GENERAL],
  "product manager intern": [
    "Technical PM",
    "Growth",
    "Platform",
    "Consumer",
    "Data/Analytics",
    GENERAL,
  ],
};

const GENERIC_TRACKS = ["Technical", "Business", GENERAL];

function tracksForRole(roleTitle) {
  const key = String(roleTitle || "").trim().toLowerCase();
  return TRACKS_BY_ROLE[key] || GENERIC_TRACKS;
}

module.exports = { tracksForRole, GENERAL };
