# Delta

A skill-gap analyzer that models which skills SFU courses teach, which
skills target internship roles require, and computes a readiness score
per role based on courses a student has actually completed.

## Why

Course calendars don't tell you which of your target roles you're
actually ready for. Delta cross-references course content against real
job requirements to surface the specific gaps — not just "learn more,"
but "you're missing SQL, Git, and REST APIs for this role."

## How it works

- `skills` — a controlled vocabulary of technical skills
- `courses` — SFU CS courses
- `roles` — target internship roles
- `course_skills` / `role_skills` — many-to-many junction tables linking
  courses/roles to the skills they teach/require
- `student_courses` — which courses a specific student has completed
- `readiness.py` computes, per role, what percentage of required skill
  *weight* the student already has, and lists exactly what's missing

This is a v0 with a small hand-seeded dataset (5 courses, 2 roles) to
prove the schema and query logic work end-to-end before scaling up data
collection.

## Setup

```bash
python3 build_db.py      # builds delta.db from schema.sql + data/*.csv
python3 readiness.py     # prints readiness % and missing skills per role
python3 readiness.py 2   # run for a different student_id
```

Requires Python 3 with the standard library only (`sqlite3`, `csv`) — no
external dependencies.

## Data

Seed data lives in `data/*.csv` and is intentionally small right now:

| File | Rows | Notes |
|---|---|---|
| `skills.csv` | 15 | controlled vocabulary — add new skills here first |
| `courses.csv` | 5 | a handful of core SFU CS courses |
| `roles.csv` | 2 | target roles |
| `course_skills.csv` | — | maps courses → skills they teach |
| `role_skills.csv` | — | maps roles → skills they require, with a weight (1.0 = core, lower = nice-to-have) |
| `student_courses.csv` | — | which courses a student has completed |

## Roadmap

- [ ] Expand to more courses (target: full CS core + electives)
- [ ] Expand to more roles, sourced from real job postings
- [ ] Automate skill extraction from course descriptions using an LLM
      (Claude/OpenAI API) instead of fully manual tagging
- [ ] Add a "study plan" query: for a role's missing skills, suggest
      which courses would close the largest gap
- [ ] Simple CLI or web frontend instead of running scripts directly
