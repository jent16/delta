# Roadmap and pipeline

Where Delta is, how data moves through it, and what is planned. Updated as steps
land; the reasoning behind each choice is in [`decisions.md`](decisions.md).

## 1. The application pipeline (what a status means)

```
saved --> drafting --> applied --> assessment --> interview --> offer
  |          |            \             \              \           |
  |          |             +-------------+--------------+----> rejected / withdrawn
  +----------+--> withdrawn                      (also: ghosted, which can revive)
```

| Status | Meaning | Your Notion word |
|---|---|---|
| saved | bookmarked, not started | Bookmarked |
| drafting | writing answers, tailoring the resume | In process |
| applied | submitted | Applied |
| assessment | online assessment / coding screen | (OA) |
| interview | any interview round | |
| offer | offer in hand | |
| rejected / withdrawn | closed; nothing further happens | x |
| ghosted | no reply; can still move to assessment, interview, offer or rejected | |

Every change is a dated row (`status_events`), so response rate and time-in-stage
can be computed later. Illegal jumps are refused and the legal next moves listed.

## 2. How data flows today

```
 Notion trackers (SWE / PM / Fintech)              one-time, repeatable
        |  importers/notion.ts   fetch + flatten pages
        v
 domain/import.ts   map columns + status words (pure), guess sector/term, flag problems
        v
 services/import.ts   plan -> PREVIEW (writes nothing) -> COMMIT
        |   writes through the normal application service
        |   (same validation, duplicate check, status history as typing it in)
        v
 var/tracker.db   <-- the source of truth from here on (applications, status_events,
        |             lists, import_records ledger; schema changed only by migrations)
        v
 services -> api   /api/applications  /api/lists  /api/import/notion/*
        v
 saved-filter lists:  SWE | PM | Fintech-adjacent      (a list is a filter, not a folder)
```

Separate and untouched: the original Delta (Adzuna ingestion, skill scoring, PM
checklist, Find Openings, one-way Notion push) in `lib/`, `scripts/`, `server.js`,
with its own rebuildable `delta.db`.

## 3. Build pipeline

| # | Step | State |
|---|---|---|
| 0 | Structure: TypeScript, layered architecture, migrations, tests, CI | done |
| 1 | Applications + dated status history + API | done |
| 2 | Lists as saved filters (SWE, PM, Fintech-adjacent), search | done |
| 2b | Drafting status (table rebuild, safe migration runner) | done |
| 3 | Notion importer: preview, commit, idempotent. 130 applications imported | done |
| 3b | Backup, verified restore, automatic backups, JSON/CSV export | done |
| 3c | API for the UI: company search, bulk edit, `missing=` filter, stats, reminders | done |
| 4 | Web UI: dashboard, applications table, quick-add with company search, detail panel, reminders, light/dark and selectable designs | done (first version) |
| 5 | Insights: funnel, response rate and time-in-stage per list | planned |
| 6 | Contacts (many-to-many with applications) and alumni helper | planned |
| 7 | Bring the old Delta in: "Save to tracker" from Find Openings; resume match shown on an application | planned |
| 8 | Follow-up reminders (overdue list, daily digest) | planned |
| 9 | Make it multi-user: login, deploy, retire the unauthenticated legacy endpoints | later |
| - | Optional: CSV/XLSX import, weekly ingest, sponsorship filter | when wanted |

### What each next step is for
- **3b Backup (done).** The tracker holds the only copy of 130 applications.
  Verified snapshots (automatic, plus before migrations and imports), a cautious
  restore, and JSON/CSV export. Still worth doing: point `DELTA_BACKUP_DIR` at a
  synced folder so a backup survives losing the disk.
- **3c API for the UI (done).** Company search (your own companies, then Simplify's
  list including closed postings, with "did you mean" for typos), bulk edit of
  safe fields, a `missing=` filter, stats and reminders. Built and tested before
  any HTML, so the UI stays a thin skin. Also done: bulk *status* change (used to mark 71
  silent applications ghosted) and a first pass classifying sectors (113 of 130 set).
- **4 UI (first version done).** Built last on purpose, on a finished and tested
  API, because looks change and behaviour shouldn't. Plain files in `src/web/`,
  served by the same process. Still to do here: animations and "feel" (waiting for
  your instructions), self-hosted fonts, and the small gaps listed below.
- **5 Insights.** Applied -> assessment -> interview funnel per list, how long
  applications sit in each stage, which source/resume version converts.
- **6 Contacts.** People at companies, link them to applications, "find alumni"
  deep links to LinkedIn searches (no scraping), import of your own LinkedIn
  connections export.
- **7 Old Delta.** The reason the project started: given an application, show how
  your resume matches the role's skills. Needs a decision on running one server.
- **9 Multi-user.** Every table already has `user_id`; this adds login, hosting
  and the security work the unauthenticated legacy endpoints currently prevent.

## 4. Known gaps (worth fixing, not yet scheduled)

UI:
- Fonts: the design calls for Young Serif / Figtree / DM Mono, but the page's
  security policy forbids loading them from Google, so it uses the system's fonts.
  Fix: download the three font files once and serve them from `src/web/` (needs
  your OK to download).
- Archive has no "unarchive" in the UI (the data is kept, and exports include it).
- Company, role and term can't be edited from the panel (they define what counts
  as a duplicate); fix a typo by archiving and re-adding for now.
- No login: fine while it only listens on your own machine, required before hosting (step 9).
- 17 applications still have no sector; the bulk "Set sector" menu makes that quick.

Backend:
- 17 applications (15 companies, e.g. Intuit, Grow, Amplify, Honeywell) still have
  no sector because they couldn't be placed with confidence; set them with
  `missing=sector` + bulk edit.
- Sectors on the other 113 were best guesses by company name, applied in bulk;
  worth a skim in the UI.
- Imported typos stay as written (e.g. company names); a company directory
  (step 3c/4) is how they get cleaned.
- Duplicates inside Notion are skipped, not merged: give a re-application a term
  or distinct role in Notion first.
- The status of a rejected row is dated by its last edit in Notion (approximate).
- Fintech-adjacent matches SWE and Quant roles only; PM and Data roles at finance
  firms (e.g. Capstone / Tech Execution) are in their own lists but not in it.
