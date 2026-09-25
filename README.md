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

**Some roles aren't well modeled by extracted technical skills at all.**
Product Manager postings ask for judgment and experience, not a
tool/language list — and in practice, Adzuna's snippet rarely even
reaches a PM posting's requirements section before running out of
characters (confirmed by inspecting the raw stored text: the ~500 char
cap gets eaten entirely by generic "our values" company-intro boilerplate
first). Every one of 25 real Product Manager Intern postings ingested
extracted zero skills, required or preferred — not a bug, a genuine
mismatch between this model and how PM listings are written. For roles
listed in `lib/qualifications.js`, a resume is scored directly against a
fixed qualification checklist instead — same closed-list-Claude-judges-
against idea as tracks and industries, just applied to the resume instead
of a posting. See **Qualifications-based roles** below.

**Cost.** Claude is called once per posting at ingest, twice per resume
upload (extract skills, explain the fit), plus once more per
qualifications-based role actually being scored (currently just one:
Product Manager Intern) — and a profile's targets gate that: an
untargeted qualifications-based role is skipped entirely, not just hidden
from the response, so a SWE-only profile never triggers the PM call at
all. "Also check roles outside my targets" opts back into scoring (and
paying for) every one. Everything after upload — re-scoring, per-company
views, adding a role to a profile — is pure SQL and free, including for
qualifications-based roles: the assessment is computed once at upload
time and cached on the `resumes` row, so `GET /resume/:id` never calls
Claude regardless of scope. Re-running an ingest skips postings already
stored, so you only pay for listings you haven't seen.

## Schema

- `skills` — controlled vocabulary
- `courses` / `course_skills` — SFU CS courses and what they teach
- `roles` — targetable roles, unique on `title` — a role is a job function;
  it carries no industry, since its postings can span several
- `job_postings` — one real listing, with its company, track, industry, and source text
- `posting_skills` — what one posting asks for, as `required` or `preferred`
- `profiles` / `profile_roles` — a person and the roles they're targeting
- `resumes` / `resume_skills` — an upload, its matched skills, its fit
  verdict, and cached qualification-checklist results where applicable
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

## Qualifications-based roles

For roles listed in `lib/qualifications.js` (currently just `Product
Manager Intern`), resume scoring skips the posting-derived skills path
entirely. On upload, `assessQualifications()` in `lib/extract-skills.js`
sends the resume text plus a fixed list of qualifications (e.g. "Product
Sense", "Data-Driven Decision Making") and Claude judges each one
`evidenced: true/false` against the candidate's actual experience — not
keyword presence — with a short quoted reason for each. That result is
cached as JSON on the `resumes` row (`qualifications` column), so
`GET /resume/:id` re-scores for free like everything else; it's only
computed fresh on upload.

Real postings and industries for these roles still come from the same
ingestion pipeline and are still shown (company list, real industries
spanned) — there just aren't posting-derived skill requirements to roll
up, since none were ever extracted. `fitScore` is simply the share of
qualifications evidenced (e.g. 5/6 = 83%).

Course-based readiness (`GET /readiness/:studentId`,
`GET /program-readiness/:programId`) has no resume text to assess, so
qualifications-based roles are excluded from those results entirely
rather than shown as a false 0%.

A profile's targets gate this the same way they gate everything else
(see Web UI, Profile) — a qualifications-based role outside a profile's
targets is never assessed, not just hidden after the fact, unless "also
check roles outside my targets" is on for that upload.

Add a role to this list by adding an entry to
`QUALIFICATIONS_BY_ROLE` in `lib/qualifications.js` — a short array of
broad, checkable competencies, not a skills vocabulary.

## Web UI

`public/index.html`, served by `server.js`, is a plain HTML/JS page with
no build step:

- **Profile** — pick or create one, and choose the roles you're targeting.
  Targets can change over time without re-uploading anything. A profile
  with targets set is scoped to them by default — a PM-targeting profile
  has no reason to be checked against SWE roles, or vice versa, and for
  qualifications-based roles (see below) that scoping means the Claude
  call for an untargeted one simply never happens. Check "Also check
  roles outside my targets" to opt into the old always-search-everything
  behavior for that one upload.
- **Upload** — the result leads with the role you're most ready for right
  now (among your targets, unless broadened) and a short explanation,
  then per-target breakdowns by minimum, preferred, and track, and a
  per-company list of every posting.
- **What employers ask for** — browse any role's rolled-up requirements
  and the individual listings behind them.
- **Find openings** — a separate, unscored browser of real internship/new-grad
  postings (see below), not connected to the ingestion/scoring pipeline.

## Find openings

A curated browser over Simplify's public listings — no scoring, no Claude,
just fetching and filtering. Fully separate from everything above: it
doesn't touch `roles`/`job_postings`, and there's nothing to ingest.

Source: `SimplifyJobs/Summer2027-Internships` and `SimplifyJobs/New-Grad-Positions`
on GitHub — public, no auth, updated daily. `lib/openings.js` fetches and
caches each dataset for an hour, then filters in memory.

Filters, all optional and composable:

- **Position type** — which of the two datasets (intern vs. new grad)
- **Term** — internships only (e.g. "Summer 2027"); options are populated
  from what's actually in the current filtered set, same as everywhere
  else in this app — never a hardcoded list. Postings are pre-filtered to
  the current term through one year out — `termWindow()` in
  `lib/openings.js` — so an already-past "Summer 2016" or a
  four-years-out "Fall 2029" never shows up, even before you touch the
  filter. A posting with several terms only needs one inside the window.
- **Region → State/Province → City** — a real drill-down, not one flat
  bucket. Location strings are free text ("San Jose, CA", "Toronto, ON,
  Canada", bare "London"); `parseLocation()` in `lib/openings.js` extracts
  as much structure as each string actually has. State/province options
  only appear once you've picked US or Canada, and only ever show values
  that exist in the currently-filtered results; city cascades the same
  way once a state's picked. International has no further breakdown —
  the underlying location strings are too unstructured for one.
- **Category** — Software / Product / Hardware / Data-AI-ML / Quant,
  normalized from Simplify's inconsistent raw values ("Software" vs
  "Software Engineering") the same way role industries are normalized
  from a fixed list at ingest time
- **Degree level** — Bachelor's / Master's / PhD. A posting with an empty
  `degrees` list (unspecified) still matches any level; a posting that
  explicitly lists only higher degrees is excluded — e.g. filtering to
  Bachelor's drops a PhD-only listing instead of showing it anyway

**Sponsorship** is real data on every listing (shown as a badge) but not
yet filterable — a likely next addition, not built because it wasn't the
immediate priority.

## Notion tracker

Find openings can push a listing into a Notion database as a new row, so
what you've applied to lives where you already keep it. Each profile has
its own database (a SWE profile and a PM profile can point at different
trackers, so sectors don't mix).

Setup: create an internal integration at notion.so/my-integrations, put its
token in `.env` as `NOTION_TOKEN`, share each tracker database with the
integration (database ••• menu → Connections), then pick a profile and paste
that database's URL into "Notion tracker for this profile". Every listing
then gets an **Add to tracker** button.

It's deliberately one-way: the app writes, you own the status (applied / in
progress / closed) in Notion, and nothing is ever read back or deleted —
which is also why closed postings need no cleanup logic. Consequently Find
openings can't hide roles you've already applied to; it only marks the ones
you added *here*.

Each push reads the database's real property names and fills only the ones
it recognizes (company, term, posted date, city, link, degree, sponsorship,
category, plus the title), matched case-insensitively — see `FIELD_NAMES`
in `lib/notion.js` to add aliases. Anything else, including a Status
property, is left for you. `tracked_listings` remembers what was pushed per
profile (by Simplify's stable listing id), so a repeat click never
duplicates a row, and a row you delete in Notion stays deleted.

`node server.js --mock` points Notion at `scripts/mock-api.js` too, so the
whole flow can be exercised without a token.

## API

| Route | What it does |
|---|---|
| `GET /roles` | every role with its posting count |
| `GET /roles/:id/requirements` | rolled-up minimum/preferred/tracks + every listing |
| `GET /skills` | the vocabulary, optional `?category=` |
| `GET /profiles`, `POST /profiles`, `PUT /profiles/:id` | manage profiles and their target roles |
| `POST /resume` | upload a PDF; extracts, scores, explains. Fields: `resume`, optional `profileId`, optional `roleIds`, optional `broadenFit` (search every role, not just targets) |
| `GET /resume/:id` | re-score a stored resume against current postings. No Claude call. Optional `?roleIds=`, `?broaden=1` |
| `GET /readiness/:studentId` | course-derived skills vs every role |
| `GET /program-readiness/:programId` | a whole curriculum vs every role |
| `POST /tracker` | add a listing (`profileId`, `listingId`) to that profile's Notion database. `GET /tracker/:profileId` lists ids already added |
| `GET /openings` | curated Simplify listings — see Find openings above for all filter params |

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
- [x] Ingest Product Manager Intern postings — 25 real postings, tracks and
      industries classified correctly, but every single one extracted zero
      skills (required or preferred). Confirmed root cause: Adzuna's ~500
      char snippet cap is consistently eaten by generic "our values/mission"
      company-intro boilerplate for PM listings before reaching an actual
      requirements section, unlike most SWE postings. The role exists and
      is browsable, but currently has no derivable minimum/preferred skills
      at all — a resume scores 0% against it either way, for lack of
      anything to compare against
- [x] Fix Product Manager Intern having no scorable requirements — not
      by fetching full posting text (that's still a real option, just not
      the one taken); instead resumes targeting qualifications-based roles
      (`lib/qualifications.js`) are scored directly against a fixed
      competency checklist assessed from the resume text itself, since PM
      is inherently a judgment-and-experience role, not a tool/language
      checklist. See "Qualifications-based roles" above
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
- [x] Find-openings region filter: drill down to state/province, then city,
      instead of one flat US/Canada/International bucket
- [x] Find-openings degree-level filter (Bachelor's/Master's/PhD)
- [x] Notion tracker: per-profile database, one-way "Add to tracker" from Find openings
- [ ] Find-openings sponsorship filter — the data's already there
      (shown as a badge), just not filterable yet
- [x] Scope resume scoring to a profile's targets by default (fit,
      results, and which qualifications-based roles even get assessed),
      with an opt-in to broaden — a PM-targeting profile no longer pays
      for or sees an unrequested SWE check, and vice versa
