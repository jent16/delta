// server.js
// Express API wrapping the same readiness logic as readiness.py,
// reading from the same delta.db SQLite database.

const express = require("express");
const Database = require("better-sqlite3");

const app = express();
const db = new Database("delta.db");
const PORT = 3000;

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

app.listen(PORT, () => {
  console.log(`Delta API running at http://localhost:${PORT}`);
});
