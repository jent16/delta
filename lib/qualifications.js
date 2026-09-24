// Some roles aren't well modeled by "extract required/preferred technical
// skills from postings" — Product Manager postings ask for judgment and
// experience, not a tool/language list, and in practice Adzuna's snippet
// rarely even reaches a PM posting's requirements section (see README).
// For roles listed here, a resume is scored directly against a fixed
// qualification checklist instead of posting-derived skills. Same idea as
// lib/tracks.js/lib/industries.js: a closed list Claude judges against,
// not free text, so results stay comparable across resumes.
//
// Add a role by adding a key here (lowercased title). Keep lists short —
// these are meant to be a handful of broad, checkable competencies, not a
// skills vocabulary.

const QUALIFICATIONS_BY_ROLE = {
  "product manager intern": [
    "Product Sense",
    "Data-Driven Decision Making",
    "Cross-Functional Collaboration",
    "Communication & Storytelling",
    "Strategic & Business Acumen",
    "Execution & Ownership",
  ],
};

function qualificationsForRole(roleTitle) {
  const key = String(roleTitle || "").trim().toLowerCase();
  return QUALIFICATIONS_BY_ROLE[key] || null; // null = score with posting-derived skills instead
}

module.exports = { qualificationsForRole };
