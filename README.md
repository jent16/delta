# Delta

A skill-gap analyzer built on real job postings. It stores what each
individual posting asks for, rolls that up into what a role actually
requires, and scores your resume against it — per role, per
specialization, and per company.

## Why

Course calendars and generic resume screeners don't tell you which of
your target roles you're actually ready for. Delta cross-references
skills from real postings against your resume to surface specific gaps —
not "learn more," but "AcmeCo wants SQL and Git, you have neither."

It also tells you which role you're most ready for *right now*, which
may not be the one you're targeting.

## Design

**There are no hand-picked weights.** Every posting is stored as its own
record with its own required/preferred skills, and requirements are
derived at query time:

- **Minimum** — required by at least half of a role's postings
- **Preferred** — mentioned by at least a fifth, but not a minimum
- **Per track** — the same rule inside one specialization, minus
  anything already role-wide

Thresholds live in `lib/requirements.js` and `requirements.py`; the two
implementations must stay in sync.

**Tracks** are specializations within a broad title — Backend, ML/AI,
Embedded/Systems under Software Engineer Intern, for example. They come
from a fixed list in `lib/tracks.js` that Claude picks from at ingest
time, so postings group cleanly instead of scattering across "ML",
"Machine Learning", and "AI". Add a track by adding a string.

**Industry is a property of the posting, not the role, and it's
classified, not asserted.** Earlier versions let you pass `--industry
Fintech` when ingesting a role — that just meant "trust me," with nothing
checking whether the postings pulled were actually from financial
companies. Now Claude classifies each posting's employer sector from its
company name and content, into a fixed list in `lib/industries.js` (same
"ML"/"Machine Learning"/"AI" fragmentation problem tracks solve, applied
to employer sector instead of specialization). A role's postings can span
several industries — "Backend Engineer Intern" postings from a bank and a
rideshare company are both valid, and get tagged Fintech and
Automotive/Transportation respectively, not one blanket label.

**Cost.** Claude is called once per posting at ingest, and twice per
resume upload (extract skills, explain the fit). Everything after that —
re-scoring, per-company views, adding a role to a profile — is pure SQL
and free. Re-running an ingest skips postings already stored, so you
only pay for listings you haven't seen.

## Schema

- `skills` — controlled vocabulary
- `courses` / `course_skills` — SFU CS courses and what they teach
- `roles` — targetable roles, unique on `title` — a role is a job function;
  it carries no industry, since its postings can span several
- `job_postings` — one real listing, with its company, track, industry, and source text
- `posting_skills` — what one posting asks for, as `required` or `preferred`
- `profiles` / `profile_roles` — a person and the roles they're targeting
- `resumes` / `resume_skills` — an upload, its matched skills, and its fit verdict
- `programs` / `program_courses` — a curriculum, for program-level coverage

## Setup

```bash
npm install
cp .env.example .env    # fill in ADZUNA_APP_ID, ADZUNA_APP_KEY, ANTHROPIC_API_KEY
python3 build_db.py     # syncs delta.db from schema.sql + data/*.csv (safe to re-run — see below)
node server.js          # http://localhost:3000
```

`build_db.py` is additive, not destructive: it never deletes `delta.db`,
and every seed table is upserted by its natural unique key (skill name,
course code, role title, `(posting source, external_id)`), so existing
rows — and their ids — don't shift on a re-run. That's what
lets `resumes`/`profiles` survive it: they're never touched at all. If you
remove a row from a CSV it stays in the database (no deletion sync); for a
true from-scratch rebuild, delete `delta.db` first.

No need to restart `node server.js` after running `build_db.py` — since it
writes into the same file instead of deleting and recreating it, an
already-running server's connection sees the new rows on its very next
query.

One real exception: if `schema.sql` itself changes (a column added or
removed), `CREATE TABLE IF NOT EXISTS` won't apply that to a table that
already exists with the old shape — delete `delta.db` and rebuild in that
case. Routine CSV-only changes never need this.

The Python scripts need only the standard library. Node is required for
the server and the ingest script.

- Adzuna credentials: free developer account at https://developer.adzuna.com/
- Anthropic API key: https://console.anthropic.com/

## Ingesting roles

```bash
npm run ingest -- --query "software engineer intern" --title "Software Engineer Intern"
npm run ingest -- --query "product manager intern" --title "Product Manager Intern"
python3 build_db.py     # rebuild delta.db with the new postings
```

Flags: `--query` (required, Adzuna search term), `--title` (canonical role
name, defaults to a title-cased `--query`), `--limit` (postings to pull,
default 15), `--country` (Adzuna country code, default `ca`).

There's no `--industry` flag — industry isn't something you assert, it's
classified per posting by Claude from the actual company name and content
(same call that extracts skills and picks a track, so no extra cost). A
role like "Backend Engineer Intern" can and will span multiple industries
across its postings; `GET /roles/:id/requirements` reports which ones its
data actually contains, derived from the postings, not typed in by hand.

If every extraction fails — bad key, no credits, network down — the script
writes nothing and exits non-zero, rather than leaving a role with no
skills behind it.

Known limitation: Adzuna's search API returns a truncated description
snippet, not the full posting text, so extraction quality is bounded by
that snippet. Good enough to find signal across many postings; not a
substitute for reading the full job description.

## Web UI

`public/index.html`, served by `server.js`, is a plain HTML/JS page with
no build step:

- **Profile** — pick or create one, and choose the roles you're targeting.
  Targets can change over time without re-uploading anything.
- **Upload** — the result leads with the role you're most ready for right
  now and a short explanation, then per-target breakdowns by minimum,
  preferred, and track, and a per-company list of every posting.
- **What employers ask for** — browse any role's rolled-up requirements
  and the individual listings behind them.

## API

| Route | What it does |
|---|---|
| `GET /roles` | every role with its posting count |
| `GET /roles/:id/requirements` | rolled-up minimum/preferred/tracks + every listing |
| `GET /skills` | the vocabulary, optional `?category=` |
| `GET /profiles`, `POST /profiles`, `PUT /profiles/:id` | manage profiles and their target roles |
| `POST /resume` | upload a PDF; extracts, scores, explains. Fields: `resume`, optional `profileId`, optional `roleIds` |
| `GET /resume/:id` | re-score a stored resume against current postings. No Claude call |
| `GET /readiness/:studentId` | course-derived skills vs every role |
| `GET /program-readiness/:programId` | a whole curriculum vs every role |

Resume skills are matched against the existing vocabulary only. A skill
no posting has ever asked for is reported under `unmatchedSkills` rather
than added to the vocabulary, so the skill list stays anchored to what
employers actually ask for.

## Developing without spending credits

`scripts/mock-api.js` stands in for both the Anthropic and Adzuna APIs
with canned responses:

```bash
node scripts/mock-api.js     # terminal 1, listens on 4010
node server.js --mock        # terminal 2, points Claude calls at it
```

`--mock` forces the override, so a real key in `.env` or the shell can't
leak mock traffic to the real API. For the ingest script, set both base
URLs explicitly:

```bash
ANTHROPIC_BASE_URL=http://localhost:4010 ADZUNA_BASE_URL=http://localhost:4010 \
  ANTHROPIC_API_KEY=mock ADZUNA_APP_ID=x ADZUNA_APP_KEY=y \
  node scripts/ingest-role.js --query "software engineer intern" --limit 3
```

## Model choice

Both call sites default to Claude Haiku 4.5 and are overridable in `.env`:

- `INGEST_MODEL` — bulk posting extraction, once per posting
- `RESUME_MODEL` — resume extraction and the fit explanation, twice per upload

Haiku is the right default for extraction: the schema is tight and the
work is mostly recognition. The fit explanation is the part that benefits
from a stronger model, so `RESUME_MODEL=claude-sonnet-5` is the first
upgrade to try if the reasoning reads thin. Per-upload cost stays well
under a cent either way.

## CLI

```bash
python3 readiness.py            # student 1's courses vs every role
python3 readiness.py 2          # a different student
python3 program_readiness.py    # a whole curriculum vs every role
```

## Data

Seed data lives in `data/*.csv`.

| File | Notes |
|---|---|
| `skills.csv` | controlled vocabulary; ingestion appends to it |
| `courses.csv` / `course_skills.csv` | SFU CS courses and what they teach |
| `roles.csv` | targetable roles, `title` unique |
| `job_postings.csv` | one row per real listing, with track, industry, and source text |
| `posting_skills.csv` | what each posting asks for, keyed by `(source, external_id)` |
| `student_courses.csv` / `program_courses.csv` / `programs.csv` | course-side data |

The two `seed-*` postings are hand-written holdovers from the original
v0 dataset, kept so the app has something to score against before any
ingest runs. Replace them once you've ingested real postings for those
roles.

`profiles` and `resumes` are runtime tables, not CSV-seeded — `build_db.py`
never touches them, so they survive a rebuild.

## Roadmap

- [x] Roles sourced from real job postings
- [x] Per-posting storage, tracks, and per-company gaps instead of weights
- [x] Resume upload → skill extraction → fit verdict
- [x] Profiles with target roles
- [ ] Ingest Product Manager Intern postings and validate the PM track list
- [ ] Expand to more courses (target: full CS core + electives)
- [ ] Automate skill extraction from course descriptions
- [ ] Study plan: for a role's missing skills, suggest which courses close the largest gap
- [x] Persist resumes across rebuilds instead of resetting them
- [x] Stop the running server from serving stale data after a rebuild —
      fixed as a side effect of the item above: build_db.py used to
      delete-and-recreate delta.db, which left a running server holding a
      handle to the old, unlinked file; now that it writes into the same
      file, an open connection sees new rows on its next query, no restart
- [x] Stop fitScore penalizing postings with zero required skills as if
      they scored 0%
- [x] Classify industry per posting from real company data instead of
      trusting an operator-typed `--industry` flag
