// server.js
// Express API wrapping the same readiness logic as readiness.py,
// reading from the same delta.db SQLite database.

const express = require("express");
const Database = require("better-sqlite3");
const multer = require("multer");
const { PDFParse } = require("pdf-parse");
const { extractResumeSkills } = require("./lib/extract-skills");

const app = express();
const db = new Database("delta.db");
const PORT = 3000;

// readiness % at or above this counts as a "match" rather than a gap
const MATCH_THRESHOLD = 75;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

function getStudentSkills(studentId) {
  const rows = db
    .prepare(
      `SELECT DISTINCT s.skill_id, s.name
       FROM student_courses sc
       JOIN course_skills cs ON sc.course_id = cs.course_id
       JOIN skills s ON cs.skill_id = s.skill_id
       WHERE sc.student_id = ?`
    )
    .all(studentId);

  const skillMap = {};
  for (const row of rows) {
    skillMap[row.skill_id] = row.name;
  }
  return skillMap;
}

function getRoleRequirements(roleId) {
  return db
    .prepare(
      `SELECT s.skill_id, s.name, rs.weight
       FROM role_skills rs
       JOIN skills s ON rs.skill_id = s.skill_id
       WHERE rs.role_id = ?`
    )
    .all(roleId);
}

// GET /readiness/:studentId
// Returns readiness % and missing skills for every role, for one student.
app.get("/readiness/:studentId", (req, res) => {
  const studentId = parseInt(req.params.studentId, 10);
  if (isNaN(studentId)) {
    return res.status(400).json({ error: "studentId must be a number" });
  }

  const studentSkills = getStudentSkills(studentId);
  const roles = db.prepare("SELECT role_id, title FROM roles").all();

  const results = roles.map((role) => {
    const requirements = getRoleRequirements(role.role_id);
    const totalWeight = requirements.reduce((sum, r) => sum + r.weight, 0);
    const earnedWeight = requirements
      .filter((r) => studentSkills[r.skill_id])
      .reduce((sum, r) => sum + r.weight, 0);

    const readiness = totalWeight ? (earnedWeight / totalWeight) * 100 : 0;
    const missing = requirements
      .filter((r) => !studentSkills[r.skill_id])
      .map((r) => r.name);

    return {
      role: role.title,
      readinessPercent: Math.round(readiness),
      missingSkills: missing,
    };
  });

  res.json({ studentId, results });
});

function getProgramSkills(programId) {
  const rows = db
    .prepare(
      `SELECT DISTINCT s.skill_id, s.name
       FROM program_courses pc
       JOIN course_skills cs ON pc.course_id = cs.course_id
       JOIN skills s ON cs.skill_id = s.skill_id
       WHERE pc.program_id = ?`
    )
    .all(programId);

  const skillMap = {};
  for (const row of rows) {
    skillMap[row.skill_id] = row.name;
  }
  return skillMap;
}

// GET /roles
// Lists every role currently in the database.
app.get("/roles", (req, res) => {
  const roles = db.prepare("SELECT role_id, title, industry FROM roles").all();
  res.json({ roles });
});

// GET /skills
// Lists the full skill vocabulary, optionally filtered by category
// e.g. /skills?category=language
app.get("/skills", (req, res) => {
  const { category } = req.query;
  const skills = category
    ? db
        .prepare("SELECT skill_id, name, category FROM skills WHERE category = ?")
        .all(category)
    : db.prepare("SELECT skill_id, name, category FROM skills").all();
  res.json({ skills });
});

// GET /program-readiness/:programId
// Returns, for one academic program, what % of each role's requirements
// its required curriculum covers (curriculum-level, not one student).
app.get("/program-readiness/:programId", (req, res) => {
  const programId = parseInt(req.params.programId, 10);
  if (isNaN(programId)) {
    return res.status(400).json({ error: "programId must be a number" });
  }

  const program = db
    .prepare("SELECT program_id, name, institution FROM programs WHERE program_id = ?")
    .get(programId);
  if (!program) {
    return res.status(404).json({ error: "program not found" });
  }

  const programSkills = getProgramSkills(programId);
  const roles = db.prepare("SELECT role_id, title FROM roles").all();

  const results = roles.map((role) => {
    const requirements = getRoleRequirements(role.role_id);
    const totalWeight = requirements.reduce((sum, r) => sum + r.weight, 0);
    const coveredWeight = requirements
      .filter((r) => programSkills[r.skill_id])
      .reduce((sum, r) => sum + r.weight, 0);

    const coverage = totalWeight ? (coveredWeight / totalWeight) * 100 : 0;
    const notCovered = requirements
      .filter((r) => !programSkills[r.skill_id])
      .map((r) => r.name);

    return {
      role: role.title,
      coveragePercent: Math.round(coverage),
      notCoveredByAnyCourse: notCovered,
    };
  });

  res.json({ program: program.name, institution: program.institution, results });
});

function getResumeSkills(resumeId) {
  const rows = db
    .prepare(
      `SELECT DISTINCT s.skill_id, s.name
       FROM resume_skills rs
       JOIN skills s ON rs.skill_id = s.skill_id
       WHERE rs.resume_id = ?`
    )
    .all(resumeId);

  const skillMap = {};
  for (const row of rows) {
    skillMap[row.skill_id] = row.name;
  }
  return skillMap;
}

function scoreResumeAgainstRoles(resumeSkills) {
  const roles = db.prepare("SELECT role_id, title FROM roles").all();
  return roles
    .map((role) => {
      const requirements = getRoleRequirements(role.role_id);
      const totalWeight = requirements.reduce((sum, r) => sum + r.weight, 0);
      const earnedWeight = requirements
        .filter((r) => resumeSkills[r.skill_id])
        .reduce((sum, r) => sum + r.weight, 0);

      const readiness = totalWeight ? (earnedWeight / totalWeight) * 100 : 0;
      const missing = requirements
        .filter((r) => !resumeSkills[r.skill_id])
        .map((r) => r.name);

      return {
        role: role.title,
        readinessPercent: Math.round(readiness),
        isMatch: readiness >= MATCH_THRESHOLD,
        missingSkills: missing,
      };
    })
    .sort((a, b) => b.readinessPercent - a.readinessPercent);
}

// resolves an extracted skill name to an existing skill_id, inserting a new
// skill row if nothing in the vocabulary matches it
function resolveSkillId(name, category) {
  const existing = db
    .prepare("SELECT skill_id FROM skills WHERE LOWER(name) = LOWER(?)")
    .get(name);
  if (existing) return existing.skill_id;

  const inserted = db
    .prepare("INSERT INTO skills (name, category) VALUES (?, ?)")
    .run(name, category || "concept");
  return inserted.lastInsertRowid;
}

// POST /resume — upload a resume PDF, extract its skills with Claude, and
// score it against every role in one shot.
app.post("/resume", upload.single("resume"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "attach a PDF file as form field 'resume'" });
  }
  if (req.file.mimetype !== "application/pdf") {
    return res.status(400).json({ error: "only application/pdf is supported" });
  }

  const parser = new PDFParse({ data: req.file.buffer });
  let text;
  try {
    text = (await parser.getText()).text;
  } catch (err) {
    return res.status(400).json({ error: `could not read PDF: ${err.message}` });
  } finally {
    await parser.destroy();
  }

  const knownSkillNames = db.prepare("SELECT name FROM skills").all().map((r) => r.name);

  let extracted;
  try {
    extracted = await extractResumeSkills(text, knownSkillNames);
  } catch (err) {
    return res.status(502).json({ error: `skill extraction failed: ${err.message}` });
  }

  const insertResume = db.prepare(
    "INSERT INTO resumes (filename, uploaded_at) VALUES (?, ?)"
  );
  const insertResumeSkill = db.prepare(
    "INSERT OR IGNORE INTO resume_skills (resume_id, skill_id) VALUES (?, ?)"
  );

  const { resumeId, skillNames } = db.transaction(() => {
    const resumeId = insertResume.run(req.file.originalname, new Date().toISOString())
      .lastInsertRowid;
    const skillNames = [];
    for (const s of extracted) {
      const skillId = resolveSkillId(s.name.trim(), s.category);
      insertResumeSkill.run(resumeId, skillId);
      skillNames.push(s.name.trim());
    }
    return { resumeId, skillNames };
  })();

  res.json({
    resumeId,
    filename: req.file.originalname,
    extractedSkills: skillNames,
    results: scoreResumeAgainstRoles(getResumeSkills(resumeId)),
  });
});

// GET /resume/:resumeId — re-score a previously uploaded resume, e.g. after
// new roles have been ingested since it was uploaded.
app.get("/resume/:resumeId", (req, res) => {
  const resumeId = parseInt(req.params.resumeId, 10);
  if (isNaN(resumeId)) {
    return res.status(400).json({ error: "resumeId must be a number" });
  }

  const resume = db
    .prepare("SELECT resume_id, filename FROM resumes WHERE resume_id = ?")
    .get(resumeId);
  if (!resume) {
    return res.status(404).json({ error: "resume not found" });
  }

  res.json({
    resumeId,
    filename: resume.filename,
    results: scoreResumeAgainstRoles(getResumeSkills(resumeId)),
  });
});

app.listen(PORT, () => {
  console.log(`Delta API running at http://localhost:${PORT}`);
});
