// Derives "what employers want" for a role from its stored postings, and
// scores a set of skills against those postings. Pure database queries — no
// Claude calls — so re-scoring is free no matter how many postings exist.
//
// The rule (keep in sync with requirements.py):
//   minimum   — required in at least MIN_SHARE of the role's postings
//   preferred — mentioned (any level) in at least PREF_SHARE of postings,
//               but not a minimum
//   per track — same rule applied to the postings in one track, minus
//               anything already in the role-wide minimum
// Everything else is still visible per posting; it just isn't rolled up.

const MIN_SHARE = 0.5;
const PREF_SHARE = 0.2;

function tally(postings) {
  // postings: [{ skills: [{ skill_id, name, level }] }] -> Map skill_id -> stats
  const stats = new Map();
  for (const p of postings) {
    for (const s of p.skills) {
      if (!stats.has(s.skill_id)) {
        stats.set(s.skill_id, { skill_id: s.skill_id, name: s.name, required: 0, any: 0 });
      }
      const st = stats.get(s.skill_id);
      st.any++;
      if (s.level === "required") st.required++;
    }
  }
  return stats;
}

function splitTiers(postings, excludeIds = new Set()) {
  const n = postings.length;
  const minimum = [];
  const preferred = [];
  if (n === 0) return { minimum, preferred };
  const sorted = [...tally(postings).values()].sort(
    (a, b) => b.required - a.required || b.any - a.any || a.name.localeCompare(b.name)
  );
  for (const st of sorted) {
    if (excludeIds.has(st.skill_id)) continue;
    const entry = {
      skillId: st.skill_id,
      name: st.name,
      requiredIn: st.required,
      mentionedIn: st.any,
      of: n,
    };
    if (st.required / n >= MIN_SHARE) minimum.push(entry);
    else if (st.any / n >= PREF_SHARE) preferred.push(entry);
  }
  return { minimum, preferred };
}

function loadPostings(db, roleId) {
  const postings = db
    .prepare(
      `SELECT posting_id, company, title, url, track, industry, fetched_at
       FROM job_postings WHERE role_id = ?
       ORDER BY company, title`
    )
    .all(roleId);
  const skillStmt = db.prepare(
    `SELECT s.skill_id, s.name, ps.level
     FROM posting_skills ps JOIN skills s ON s.skill_id = ps.skill_id
     WHERE ps.posting_id = ?
     ORDER BY ps.level, s.name`
  );
  for (const p of postings) p.skills = skillStmt.all(p.posting_id);
  return postings;
}

// What a role asks for, rolled up from its postings.
function roleRequirements(db, roleId) {
  const postings = loadPostings(db, roleId);
  const { minimum, preferred } = splitTiers(postings);
  const minimumIds = new Set(minimum.map((m) => m.skillId));

  const byTrack = new Map();
  for (const p of postings) {
    const t = p.track || "General";
    if (!byTrack.has(t)) byTrack.set(t, []);
    byTrack.get(t).push(p);
  }
  const tracks = [...byTrack.entries()]
    .map(([track, ps]) => {
      const tiers = splitTiers(ps, minimumIds);
      return { track, postings: ps.length, minimum: tiers.minimum, preferred: tiers.preferred };
    })
    .sort((a, b) => b.postings - a.postings);

  // industry lives per posting, not per role — this is which ones the
  // role's actual postings span, not an operator-asserted label
  const industries = [...new Set(postings.map((p) => p.industry).filter(Boolean))].sort();

  return { postings: postings.length, minimum, preferred, tracks, industries, listings: postings };
}

// Scores one skill set (a Set of skill_ids) against every posting of a role.
function scoreRole(db, role, haveIds) {
  const req = roleRequirements(db, role.role_id);

  const cover = (list) => ({
    have: list.filter((s) => haveIds.has(s.skillId)).length,
    total: list.length,
    missing: list.filter((s) => !haveIds.has(s.skillId)).map((s) => s.name),
  });

  const listings = req.listings
    .map((p) => {
      const required = p.skills.filter((s) => s.level === "required");
      const preferred = p.skills.filter((s) => s.level === "preferred");
      const reqHave = required.filter((s) => haveIds.has(s.skill_id));
      const prefHave = preferred.filter((s) => haveIds.has(s.skill_id));
      return {
        postingId: p.posting_id,
        company: p.company,
        title: p.title,
        url: p.url,
        track: p.track,
        industry: p.industry,
        required: {
          have: reqHave.length,
          total: required.length,
          missing: required.filter((s) => !haveIds.has(s.skill_id)).map((s) => s.name),
        },
        preferred: {
          have: prefHave.length,
          total: preferred.length,
          missing: preferred.filter((s) => !haveIds.has(s.skill_id)).map((s) => s.name),
        },
        // share of required skills covered; used for ranking and the fit score
        requiredShare: required.length ? reqHave.length / required.length : 0,
      };
    })
    .sort((a, b) => b.requiredShare - a.requiredShare || a.company.localeCompare(b.company));

  // A posting with zero required skills has nothing to have covered — it
  // shouldn't count as a 0% match. Only average over postings that actually
  // had at least one required skill; if none did, there's no required-skill
  // signal for this role at all yet.
  const withRequired = listings.filter((l) => l.required.total > 0);
  const fitScore = withRequired.length
    ? withRequired.reduce((sum, l) => sum + l.requiredShare, 0) / withRequired.length
    : 0;

  return {
    roleId: role.role_id,
    role: role.title,
    postings: req.postings,
    minimum: cover(req.minimum),
    preferred: cover(req.preferred),
    tracks: req.tracks.map((t) => ({
      track: t.track,
      postings: t.postings,
      minimum: cover(t.minimum),
      preferred: cover(t.preferred),
    })),
    industries: req.industries,
    listings,
    // average share of required skills covered across the role's postings
    fitScore: Math.round(fitScore * 100),
  };
}

module.exports = { MIN_SHARE, PREF_SHARE, roleRequirements, scoreRole };
