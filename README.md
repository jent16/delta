# Delta

A skill-gap analyzer that models which skills SFU courses teach, which
skills target internship roles require, and either matches a student
(by completed courses or an uploaded resume) to the roles they're ready
for, or surfaces exactly what's missing.

## Why

Course calendars — and generic resume screeners — don't tell you which
of your target roles you're actually ready for. Delta cross-references
course content and resume-extracted skills against real job
requirements to surface the specific gaps — not just "learn more," but
"you're missing SQL, Git, and REST APIs for this role."

## How it works

- `skills` — a controlled vocabulary of technical skills
- `courses` — SFU CS courses
- `roles` — target internship roles, populated from real postings (see
  Automated role/skill ingestion below)
- `course_skills` / `role_skills` — many-to-many junction tables linking
  courses/roles to the skills they teach/require, with a weight derived
  from how often real postings actually asked for each skill
- `student_courses` — which courses a specific student has completed
- `resumes` / `resume_skills` — an uploaded resume and the skills Claude
  extracted from it (see Resume matching below)
- `readiness.py` / `POST /resume` compute, per role, what percentage of
  required skill *weight* the student/resume already has, and list
  exactly what's missing

This started as a v0 with a small hand-seeded dataset to prove the
schema and query logic end-to-end; role data and resume matching are
now sourced automatically instead of by hand.

## Setup

```bash
python3 build_db.py      # builds delta.db from schema.sql + data/*.csv
python3 readiness.py     # prints readiness % and missing skills per role
python3 readiness.py 2   # run for a different student_id
```

Requires Python 3 with the standard library only (`sqlite3`, `csv`) — no
external dependencies.

## Automated role/skill ingestion

Hand-seeding roles doesn't scale, and readiness scores are only as good as
the role data behind them. `scripts/ingest-role.js` pulls real postings for
a role from the [Adzuna](https://developer.adzuna.com/) job search API,
extracts required/preferred skills from each one with Claude, and merges
the result into `data/roles.csv`, `data/skills.csv`, and
`data/role_skills.csv` — a skill's weight is derived from what fraction of
real postings actually asked for it, not a hand-picked number. Every
posting used is logged to `data/job_postings.csv` so any weight can be
traced back to its source listings.

Setup:

```bash
npm install
cp .env.example .env    # fill in ADZUNA_APP_ID, ADZUNA_APP_KEY, ANTHROPIC_API_KEY
```

- Adzuna credentials: free developer account at https://developer.adzuna.com/
- Anthropic API key: https://console.anthropic.com/ (separate from a Claude
  Code session — this is a standalone key for the script to call the API)

Run it:

```bash
npm run ingest -- --query "software engineer intern" --title "Software Engineer Intern"
npm run ingest -- --query "product manager intern" --title "Product Manager Intern"
python3 build_db.py     # rebuild delta.db with the newly ingested data
```

Flags: `--query` (required, Adzuna search term), `--title` (canonical role
name to store, defaults to a title-cased `--query`), `--industry` (default
`Technology`), `--limit` (postings to pull, default 15), `--country`
(Adzuna country code, default `ca`).

Known limitation: Adzuna's search API returns a truncated description
snippet, not the full posting text, so extraction quality is bounded by
that snippet — good enough to find signal across many postings, not a
substitute for reading the full JD.

## Resume matching

`server.js` exposes a resume-upload flow that reuses the same Claude
extraction pattern as role ingestion, but pointed at a candidate's resume
instead of a job posting:

```bash
node server.js
curl -X POST http://localhost:3000/resume -F "resume=@/path/to/resume.pdf"
```

What it does: parses the uploaded PDF's text (`pdf-parse`), sends it to
Claude to extract every skill the resume actually demonstrates (not just
mentions in passing), normalizes each one against the existing `skills`
vocabulary case-insensitively — matching `"javascript"` to the canonical
`"JavaScript"`, say — and inserts any genuinely new skill it finds. It
then scores the resume against every role using the same weighted
readiness math as `readiness.py`, and marks a role a "match" once
readiness crosses `MATCH_THRESHOLD` (75% by default, set in
`server.js`) — otherwise it returns the specific missing skills.

`GET /resume/:resumeId` re-scores a previously uploaded resume without
re-parsing it — useful after ingesting more roles.

Requires `ANTHROPIC_API_KEY` in `.env` with billing enabled; without
credits, the endpoint fails cleanly with a `502` at the extraction step
(the PDF upload, parsing, and DB writes all still work — the failure is
isolated to the external API call).

**Narrowing which roles get scored:** both endpoints accept an optional
`title` and `industry` (form fields on `POST /resume`, query params on
`GET /resume/:resumeId`). `title` and an explicit `industry` hard-filter
which roles are even considered. If `industry` is left out, Claude's
`inferred_industry` guess (produced in the same extraction call, no extra
API cost) is used only as a *soft* sort — it never hides a role, it just
ranks same-industry roles first, since a guess shouldn't be able to hide
something the user might still want to see. The response includes
`inferredIndustry` and `usedInferredIndustry` so the UI can show what
happened.

## Web UI

`public/index.html`, served by `server.js` via `express.static`, is a
plain HTML/JS page (no build step, no framework) with two dependent
dropdowns:

- **Job function** — populated from `GET /roles`, deduplicated by title.
- **Industry** — populated from the industries that specific function has
  actually been ingested under; defaults to "Let Delta infer from my
  resume," which leaves `industry` unset so the backend falls back to the
  soft-sort behavior above.

Both dropdowns only ever show options that exist in the database — there's
no hardcoded taxonomy to keep in sync as more roles get ingested.

Run it with `node server.js` and open `http://localhost:3000`.

## Data

Seed data lives in `data/*.csv` and is intentionally small right now:

| File | Rows | Notes |
|---|---|---|
| `skills.csv` | 26 | controlled vocabulary — add new skills here first (or let ingestion add them) |
| `courses.csv` | 20 | SFU CS courses |
| `roles.csv` | 2 | target roles — grows via `scripts/ingest-role.js` |
| `course_skills.csv` | — | maps courses → skills they teach |
| `role_skills.csv` | — | maps roles → skills they require, with a weight (1.0 = core, lower = nice-to-have) |
| `student_courses.csv` | — | which courses a student has completed |
| `job_postings.csv` | — | real postings ingested per role, for traceability |

`resumes` and `resume_skills` are not CSV-seeded — they're written at
runtime by `POST /resume` and reset on every `build_db.py` rebuild, same
as any other request-scoped data.

## Roadmap

- [ ] Expand to more courses (target: full CS core + electives)
- [x] Expand to more roles, sourced from real job postings — automated via
      `scripts/ingest-role.js` (see above)
- [ ] Automate skill extraction from course descriptions using an LLM
      (course side is still hand-tagged; role side is now automated)
- [ ] Add a "study plan" query: for a role's missing skills, suggest
      which courses would close the largest gap
- [x] Simple CLI or web frontend instead of running scripts directly —
      `public/index.html`, served by `server.js` (see Web UI above)
- [x] Resume upload → skill extraction → readiness match — `POST /resume`
      reuses the same Claude-based extraction approach as role ingestion
