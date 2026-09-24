// server.js
// Express API over delta.db. Scoring is pure SQL (lib/requirements.js);
// Claude is only called on resume upload (extract skills, explain fit).

const path = require("path");

// `node server.js --mock` points the Anthropic client at scripts/mock-api.js
// so the upload -> extract -> score flow can be exercised without spending
// credits. Must run before ./lib/extract-skills builds its client.
// Force the override: the surrounding shell (and .env) may already define a
// real endpoint and key, and falling back to those would send mock traffic to
// the real API. MOCK_PORT can move the mock server off 4010.
const MOCK = process.argv.includes("--mock");
if (MOCK) {
  process.env.ANTHROPIC_BASE_URL = `http://localhost:${process.env.MOCK_PORT || 4010}`;
  process.env.ANTHROPIC_API_KEY = "mock-key-not-used";
}

const express = require("express");
const Database = require("better-sqlite3");
const multer = require("multer");
const { PDFParse } = require("pdf-parse");
const { extractResumeSkills, explainFit } = require("./lib/extract-skills");
const { roleRequirements, scoreRole } = require("./lib/requirements");
const { findOpenings } = require("./lib/openings");

const app = express();
const db = new Database("delta.db");
db.pragma("foreign_keys = ON");
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

// ---------- helpers ----------

function skillIdSet(rows) {
  return new Set(rows.map((r) => r.skill_id));
}

function getStudentSkillIds(studentId) {
  return skillIdSet(
    db
      .prepare(
        `SELECT DISTINCT cs.skill_id
         FROM student_courses sc
         JOIN course_skills cs ON sc.course_id = cs.course_id
         WHERE sc.student_id = ?`
      )
      .all(studentId)
  );
}

function getProgramSkillIds(programId) {
  return skillIdSet(
    db
      .prepare(
        `SELECT DISTINCT cs.skill_id
         FROM program_courses pc
         JOIN course_skills cs ON pc.course_id = cs.course_id
         WHERE pc.program_id = ?`
      )
      .all(programId)
  );
}

function getResumeSkillIds(resumeId) {
  return skillIdSet(
    db.prepare("SELECT skill_id FROM resume_skills WHERE resume_id = ?").all(resumeId)
  );
}

function allRoles() {
  return db
    .prepare(
      `SELECT r.role_id, r.title, COUNT(jp.posting_id) AS postings
       FROM roles r LEFT JOIN job_postings jp ON jp.role_id = r.role_id
       GROUP BY r.role_id ORDER BY r.title`
    )
    .all();
}

function rolesById(ids) {
  const wanted = new Set(ids.map(Number));
  return allRoles().filter((r) => wanted.has(r.role_id));
}

function getProfile(profileId) {
  const profile = db
    .prepare("SELECT profile_id, name, created_at FROM profiles WHERE profile_id = ?")
    .get(profileId);
  if (!profile) return null;
  profile.targetRoles = db
    .prepare(
      `SELECT r.role_id, r.title
       FROM profile_roles pr JOIN roles r ON r.role_id = pr.role_id
       WHERE pr.profile_id = ? ORDER BY r.title`
    )
    .all(profileId);
  return profile;
}

// Score a skill set against target roles (for the detailed view) and against
// every role (to find the best fit today). Pure SQL, no Claude.
function scoreSkillSet(haveIds, targetRoleIds) {
  const roles = allRoles().filter((r) => r.postings > 0);
  const scoredAll = roles.map((r) => scoreRole(db, r, haveIds));
  const targets = new Set((targetRoleIds || []).map(Number));
  const results = targets.size
    ? scoredAll.filter((r) => targets.has(r.roleId))
    : scoredAll;
  results.sort((a, b) => b.fitScore - a.fitScore);
  const fit = [...scoredAll].sort((a, b) => b.fitScore - a.fitScore)[0] || null;
  return { results, fit, scoredAll };
}

// ---------- roles & requirements ----------

// GET /roles — every role with how many postings back it
app.get("/roles", (req, res) => {
  res.json({ roles: allRoles() });
});

// GET /roles/:roleId/requirements — what employers ask for, rolled up from
// the role's postings, plus every individual listing for traceability
app.get("/roles/:roleId/requirements", (req, res) => {
  const roleId = parseInt(req.params.roleId, 10);
  if (isNaN(roleId)) return res.status(400).json({ error: "roleId must be a number" });
  const role = db.prepare("SELECT role_id, title FROM roles WHERE role_id = ?").get(roleId);
  if (!role) return res.status(404).json({ error: "role not found" });
  res.json({ role: role.title, ...roleRequirements(db, roleId) });
});

// GET /skills — the full skill vocabulary, optionally ?category=language
app.get("/skills", (req, res) => {
  const { category } = req.query;
  const skills = category
    ? db.prepare("SELECT skill_id, name, category FROM skills WHERE category = ?").all(category)
    : db.prepare("SELECT skill_id, name, category FROM skills").all();
  res.json({ skills });
});

// ---------- curated openings (Simplify, no Claude involved) ----------

// GET /openings?type=intern|newgrad&term=Summer 2026&region=us|canada|intl|all
//   &state=CA&city=San Jose&category=software|product|hardware|data|quant|all
//   &degree=Bachelor's|Master's|PhD|all&limit=100
// state/city only apply within region=us or region=canada.
app.get("/openings", async (req, res) => {
  try {
    const result = await findOpenings({
      type: req.query.type,
      term: req.query.term,
      region: req.query.region,
      state: req.query.state,
      city: req.query.city,
      category: req.query.category,
      degree: req.query.degree,
      limit: req.query.limit ? parseInt(req.query.limit, 10) : undefined,
    });
    res.json(result);
  } catch (err) {
    console.error("openings fetch failed:", err);
    res.status(502).json({ error: `could not fetch listings: ${err.message}` });
  }
});

// ---------- course-based readiness (student / program) ----------

// GET /readiness/:studentId — course-derived skills vs every role
app.get("/readiness/:studentId", (req, res) => {
  const studentId = parseInt(req.params.studentId, 10);
  if (isNaN(studentId)) return res.status(400).json({ error: "studentId must be a number" });
  const { results } = scoreSkillSet(getStudentSkillIds(studentId), []);
  res.json({ studentId, results });
});

// GET /program-readiness/:programId — a whole curriculum vs every role
app.get("/program-readiness/:programId", (req, res) => {
  const programId = parseInt(req.params.programId, 10);
  if (isNaN(programId)) return res.status(400).json({ error: "programId must be a number" });
  const program = db
    .prepare("SELECT program_id, name, institution FROM programs WHERE program_id = ?")
    .get(programId);
  if (!program) return res.status(404).json({ error: "program not found" });
  const { results } = scoreSkillSet(getProgramSkillIds(programId), []);
  res.json({ program: program.name, institution: program.institution, results });
});

// ---------- profiles ----------

// GET /profiles — everyone, with their target roles
app.get("/profiles", (req, res) => {
  const ids = db.prepare("SELECT profile_id FROM profiles ORDER BY name").all();
  res.json({ profiles: ids.map((r) => getProfile(r.profile_id)) });
});

// POST /profiles { name, roleIds: [..] }
app.post("/profiles", (req, res) => {
  const name = String(req.body?.name || "").trim();
  const roleIds = Array.isArray(req.body?.roleIds) ? req.body.roleIds.map(Number) : [];
  if (!name) return res.status(400).json({ error: "name is required" });
  if (roleIds.some(isNaN)) return res.status(400).json({ error: "roleIds must be numbers" });
  const known = new Set(allRoles().map((r) => r.role_id));
  const unknown = roleIds.filter((id) => !known.has(id));
  if (unknown.length) return res.status(400).json({ error: `unknown roleIds: ${unknown.join(", ")}` });

  const profileId = db.transaction(() => {
    const id = db
      .prepare("INSERT INTO profiles (name, created_at) VALUES (?, ?)")
      .run(name, new Date().toISOString()).lastInsertRowid;
    const ins = db.prepare("INSERT OR IGNORE INTO profile_roles (profile_id, role_id) VALUES (?, ?)");
    for (const rid of roleIds) ins.run(id, rid);
    return id;
  })();
  res.status(201).json({ profile: getProfile(profileId) });
});

// PUT /profiles/:profileId { name?, roleIds? } — change targets over time
app.put("/profiles/:profileId", (req, res) => {
  const profileId = parseInt(req.params.profileId, 10);
  if (isNaN(profileId)) return res.status(400).json({ error: "profileId must be a number" });
  if (!getProfile(profileId)) return res.status(404).json({ error: "profile not found" });
  const name = req.body?.name !== undefined ? String(req.body.name).trim() : null;
  const roleIds = Array.isArray(req.body?.roleIds) ? req.body.roleIds.map(Number) : null;
  if (roleIds && roleIds.some(isNaN)) return res.status(400).json({ error: "roleIds must be numbers" });

  db.transaction(() => {
    if (name) db.prepare("UPDATE profiles SET name = ? WHERE profile_id = ?").run(name, profileId);
    if (roleIds) {
      db.prepare("DELETE FROM profile_roles WHERE profile_id = ?").run(profileId);
      const ins = db.prepare("INSERT OR IGNORE INTO profile_roles (profile_id, role_id) VALUES (?, ?)");
      for (const rid of roleIds) ins.run(profileId, rid);
    }
  })();
  res.json({ profile: getProfile(profileId) });
});

// ---------- resumes ----------

function resumeResponse(resume, targetRoleIds) {
  const haveIds = getResumeSkillIds(resume.resume_id);
  const { results, fit } = scoreSkillSet(haveIds, targetRoleIds);
  const matched = db
    .prepare(
      `SELECT s.name FROM resume_skills rs JOIN skills s ON s.skill_id = rs.skill_id
       WHERE rs.resume_id = ? ORDER BY s.name`
    )
    .all(resume.resume_id)
    .map((r) => r.name);
  return {
    resumeId: resume.resume_id,
    profileId: resume.profile_id,
    filename: resume.filename,
    matchedSkills: matched,
    unmatchedSkills: JSON.parse(resume.unmatched_skills || "[]"),
    fit: fit
      ? {
          roleId: fit.roleId,
          role: fit.role,
          industries: fit.industries,
          fitScore: fit.fitScore,
          reasoning: resume.fit_reasoning,
        }
      : null,
    results,
  };
}

// POST /resume — multipart: resume (PDF), optional profileId, optional
// roleIds (comma-separated). Extracts skills with Claude, scores against
// the target roles, and asks Claude for a short fit explanation.
app.post("/resume", upload.single("resume"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "attach a PDF file as form field 'resume'" });
  }
  if (req.file.mimetype !== "application/pdf") {
    return res.status(400).json({ error: "only application/pdf is supported" });
  }

  const profileId = req.body.profileId ? parseInt(req.body.profileId, 10) : null;
  const profile = profileId ? getProfile(profileId) : null;
  if (profileId && !profile) return res.status(404).json({ error: "profile not found" });
  const targetRoleIds = req.body.roleIds
    ? String(req.body.roleIds).split(",").map((s) => parseInt(s, 10)).filter((n) => !isNaN(n))
    : profile
      ? profile.targetRoles.map((r) => r.role_id)
      : [];

  const parser = new PDFParse({ data: req.file.buffer });
  let text;
  try {
    text = (await parser.getText()).text;
  } catch (err) {
    return res.status(400).json({ error: `could not read PDF: ${err.message}` });
  } finally {
    await parser.destroy();
  }
  if (!text || !text.trim()) {
    return res.status(400).json({ error: "PDF contains no extractable text (scanned image?)" });
  }

  const vocab = db.prepare("SELECT skill_id, name FROM skills").all();
  const vocabByKey = new Map(vocab.map((s) => [s.name.toLowerCase(), s.skill_id]));

  let extracted;
  try {
    extracted = await extractResumeSkills(text, vocab.map((s) => s.name));
  } catch (err) {
    console.error("resume extraction failed:", err);
    return res.status(502).json({ error: `skill extraction failed: ${err.message}` });
  }

  // Match against the vocabulary only. Skills no posting has ever asked for
  // are kept for display but not added to the vocabulary.
  const matchedIds = new Set();
  const unmatched = [];
  for (const s of extracted.skills) {
    const id = vocabByKey.get(s.name.toLowerCase());
    if (id) matchedIds.add(id);
    else unmatched.push(s.name);
  }

  const resumeId = db.transaction(() => {
    const id = db
      .prepare(
        "INSERT INTO resumes (profile_id, filename, unmatched_skills, uploaded_at) VALUES (?, ?, ?, ?)"
      )
      .run(profileId, req.file.originalname, JSON.stringify(unmatched), new Date().toISOString())
      .lastInsertRowid;
    const ins = db.prepare("INSERT OR IGNORE INTO resume_skills (resume_id, skill_id) VALUES (?, ?)");
    for (const sid of matchedIds) ins.run(id, sid);
    return id;
  })();

  // Deterministic scoring first; Claude only explains the numbers.
  const { fit, scoredAll } = scoreSkillSet(matchedIds, targetRoleIds);
  let reasoning = null;
  if (fit) {
    try {
      reasoning = await explainFit({
        targetRoles: rolesById(targetRoleIds).map((r) => r.title),
        scored: scoredAll,
        resumeSkillNames: vocab.filter((s) => matchedIds.has(s.skill_id)).map((s) => s.name),
      });
    } catch (err) {
      // scoring already succeeded; a missing explanation shouldn't fail the upload
      console.error("fit explanation failed:", err);
      reasoning = null;
    }
    db.prepare("UPDATE resumes SET fit_role_id = ?, fit_reasoning = ? WHERE resume_id = ?").run(
      fit.roleId,
      reasoning,
      resumeId
    );
  }

  const resume = db.prepare("SELECT * FROM resumes WHERE resume_id = ?").get(resumeId);
  res.json(resumeResponse(resume, targetRoleIds));
});

// GET /resume/:resumeId — re-score a stored resume against current postings.
// No Claude call: skills and the fit explanation are reused from upload time.
// Optional ?roleIds=1,2 overrides the target roles.
app.get("/resume/:resumeId", (req, res) => {
  const resumeId = parseInt(req.params.resumeId, 10);
  if (isNaN(resumeId)) return res.status(400).json({ error: "resumeId must be a number" });
  const resume = db.prepare("SELECT * FROM resumes WHERE resume_id = ?").get(resumeId);
  if (!resume) return res.status(404).json({ error: "resume not found" });

  let targetRoleIds = [];
  if (req.query.roleIds) {
    targetRoleIds = String(req.query.roleIds).split(",").map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
  } else if (resume.profile_id) {
    const profile = getProfile(resume.profile_id);
    targetRoleIds = profile ? profile.targetRoles.map((r) => r.role_id) : [];
  }
  res.json(resumeResponse(resume, targetRoleIds));
});

app.listen(PORT, () => {
  console.log(`Delta API running at http://localhost:${PORT}`);
  if (MOCK) {
    console.log(`  --mock: Claude calls go to ${process.env.ANTHROPIC_BASE_URL} (run: node scripts/mock-api.js)`);
  }
});
