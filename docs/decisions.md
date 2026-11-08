# Decisions

Short records of *why*, newest last. The code shows what was built; this shows
what else was considered, because that is the part that gets forgotten.

## 1. The app is the source of truth, not Notion
Notion was the record and the app only wrote to it, which made the app a form
with extra steps. Making the database the source of truth lets the app compute
things (response rate, overdue follow-ups) and makes Notion an optional export.
**Cost:** the data now lives in one place we must back up (see decision 4).

## 2. Two database files: `delta.db` and `var/tracker.db`
Delta's data could always be rebuilt from CSVs, so "delete the database when the
schema changes" was fine. A tracker's rows are the only copy. Separate files
mean the rebuildable data can never endanger the irreplaceable data.

## 3. Fixed status pipeline with dated history
`saved -> drafting -> applied -> assessment -> interview -> offer`, ending in `rejected`,
`withdrawn` or `ghosted`. Every change is a row in `status_events`.
- *Alternative: free-form statuses per list.* More flexible, but the app can't
  compute "response rate" if it doesn't know which statuses mean "applied".
- *Alternative: one status column, no history.* Simpler, but "days since
  applied" and time-in-stage can never be recovered later.
- *Rules as data:* the transition table in `domain/status.ts` is plain data so
  it can be tested exhaustively (all 64 pairs).
- `ghosted` is deliberately not final; people reply months later. `rejected`
  and `withdrawn` are.
- `status` is stored on the application *and* derived from the newest event. Both
  are written in one transaction and a test asserts they never disagree.
  *Trade-off:* a cached copy can drift if some future code path forgets the
  transaction; the benefit is that "everything in Interview" is one cheap query.
- `status` has a database `CHECK`. *Cost:* adding a status later means a
  migration that rebuilds the table (SQLite can't alter a CHECK). We judged an
  invalid status the worst kind of corruption.

## 4. Plain SQL migrations + a repository layer (no ORM yet)
Numbered `.sql` files and a ~60-line runner (`db/migrate.ts`) that applies each
in a transaction, records a checksum, and refuses to run if an applied file was
edited. *Why not an ORM:* it hides exactly the things worth learning first.
*Upgrade path:* the repository is the only code that touches SQL, so an ORM
could replace it without touching services.
**Not yet done:** automated backups and export (Step 6).

## 5. Lists are saved filters, not separate tables
`roleFunction` (SWE, PM...) and `sector` (Fintech...) are independent properties
of one application. A "list" is a stored `ApplicationQuery`. A Fintech SWE role
appears in both lists with no duplicate row. This is the same reason `industry`
moved from roles to postings in the old Delta: it was a property of the
*instance*, not the *category*.

## 6. TypeScript for the new core, run by Node's built-in type stripping
No build step or extra runner; `tsc --noEmit` checks types. Constraints this
imposes: no `enum`, no parameter properties (they need real code generation),
and relative imports carry `.ts`. We use string-literal unions instead of enums,
which is the idiomatic choice anyway. Legacy JavaScript is untouched (the
"strangler" approach: grow the new core beside the old, migrate by choice).

## 7. Dependencies point inward, and a test enforces it
See `architecture.md`. The services depend on a port owned by the domain.
**Known limit:** the port is synchronous because `better-sqlite3` is. Moving to
an async database (Postgres) would change the port's signatures and touch the
services — acceptable for a single-user local app, worth knowing for later.

## 8. Run locally first, but model users from day one
Every table row belongs to a `user_id`; `api/app.ts` has a single
`currentUserId` seam. Login later fills in that seam rather than retrofitting a
column onto every table. We don't build auth now: it would add a large security
surface (and today's unauthenticated endpoints are exactly why the old Delta
couldn't be deployed publicly).

## 9. "Delete" archives
Your application history is rarely something you want gone. `DELETE` sets
`archived_at`; archived rows are hidden by default and recoverable. An archived
application doesn't block re-adding the same one.

## 10. Reject unknown fields
`{"compny": "Stripe"}` is a 400, not a silently dropped value. Importers will
rely on this: a wrong column mapping should fail loudly in the preview, not
quietly lose data.

## 11. A list is a saved filter, not a container
`SWE`, `PM` and `Fintech-adjacent` are rows in a `lists` table holding a filter
(`{"roleFunctions":["SWE"]}`), never application ids. So there is no "move to
list" and no copy to keep in sync: an application simply matches whichever
filters describe it, counts update the moment anything changes, and creating a
new list is instant and retroactive. **Cost:** a list can't hold a hand-picked,
arbitrary set of applications. If you ever want that, it's a different feature
(tags), and it would sit beside lists rather than replace them.

## 12. Free-text search is not part of a saved filter
A list names a *category you return to*; a search is a *question you ask inside
it*. `GET /api/lists/:id/applications?q=jane` narrows the list; the narrowing
can only remove rows (`narrowQuery`). Two traps that is built to avoid: an
ad-hoc query can't reveal archived rows the list hides, and a contradictory
narrowing (PMs inside the SWE list) returns *nothing* — `narrowQuery` returns
`null` because the repository reads an empty list as "no constraint" and would
otherwise show everything. Tests pin both.

## 13. "Fintech" and "Finance" are different sectors
Stripe is a software company serving finance; Jane Street, a bank or a PE fund
*is* finance. Merging them hides a real difference when you filter, but the
"Fintech-adjacent" list deliberately matches both: SWE or Quant roles at either.
Adding the sector needed no migration because `sector` is validated in the
domain, not by a database CHECK — the closed list can grow with a code change.
The trade-off is that the database itself would accept `"Plumbing"`; only the
domain stops it.

## 14. Starter lists are seeded by the migration, not at startup
Seeding at startup would resurrect a list you deleted every time the server
restarted. A migration runs exactly once, so deleting a starter list sticks.
The cost is that the filter JSON lives in SQL, where the type checker can't see
it — so a test runs every seeded filter through the real validator.

## 15. Defence in depth for ownership
The service checks a list belongs to the caller; the repository's SQL *also*
filters by `user_id`. The second check is unreachable through the service, which
is why mutation testing found it untested — it now has its own repository-level
test. The point of the redundancy is that one forgotten check in a future
service can't leak another user's data.

## 16. Adding a status meant rebuilding two tables (and teaching the runner how)
Your Notion flow was Bookmarked -> In process (writing the answers) -> Applied,
so the pipeline gained `drafting` between Saved and Applied (migration 0003)
rather than folding it into Saved. The cost of keeping status a database CHECK:
SQLite cannot alter a CHECK, so the migration creates new tables, copies every
row, drops the old ones and renames. With foreign keys on, dropping
`applications` would silently cascade-delete every status event, so the
migration runner now switches foreign keys off around a migration (the pragma
can't change inside a transaction), runs `foreign_key_check` before the commit
(any dangling reference rolls the whole migration back) and always turns them
back on. A test builds a database as it was before 0003, fills it, upgrades it,
and checks nothing was lost. **Lesson:** a status list in a CHECK is safe but
expensive to change; the alternative (validate only in the domain) would have
made this a one-line change at the price of the database no longer guarding
itself.

## 17. The importer is an adapter plus pure mapping, and writes through the normal service
Three separable jobs: an *adapter* (`importers/notion.ts`) that only fetches and
flattens Notion pages into plain rows; *mapping* (`domain/import.ts`, pure) that
decides what a row means; and an *import service* that decides what to do. Rows
are written with the same `applications.add` / `changeStatus` calls the API
uses, so an import can't create something a person couldn't (no second set of
rules to drift). The Notion client is injected, so tests use canned responses
and the real database but never the network. A CSV importer is a new adapter
producing the same rows.
*Alternative:* write straight to the database. Faster to build, but it would
skip duplicate detection and status history, and need its own validation.

## 18. Delta is the source of truth after import; the ledger enforces it
`import_records` remembers which source row became which application. A row in
the ledger is never read again, so edits made in Delta are not overwritten and
an application you archived is not resurrected by re-running. The cost: fixing a
typo in Notion *after* importing doesn't flow through. That is the point of the
pivot, and the answer is to fix it in Delta.
*Alternative:* two-way sync. Rejected: it needs conflict rules ("which edit
wins?") that a single-user local tool shouldn't need.

## 19. Preview, then commit — and both run the same plan
Nothing is written until you say so. The preview and the commit execute one
`plan()` function, so the preview cannot promise something the commit doesn't
do (a test asserts the two summaries match). A row that fails at write time is
reported and not recorded, so one bad row never aborts the rest and a re-run
retries exactly the rows that failed.

## 20. Lossy source, honest guesses
Notion records the current status, not when it changed. A rejected row is
imported as *applied on the Applied date, then rejected*, dated with the row's
last edit, and the preview says the date is approximate. Two other guesses are
labelled as guesses too: a sector inferred from a short table of well-known
employers (`domain/company-hints.ts`), and a term lifted from "(Summer 2027)" in
a title. Anything with no column of its own (Opens date, a non-URL link) goes
into the notes so nothing is silently lost. Rows with an unknown status word
are refused rather than guessed.

## 21. Duplicates inside the source: the older row wins
Two Notion rows with the same company, role and term are one application in
Delta. The older row is imported and the newer is reported as a duplicate, never
silently dropped. If it was really a re-application, give it a term (or a
different role) in Notion and re-run.

## 22. Backups use SQLite's own snapshot, and are verified before they count
`VACUUM INTO` produces a consistent copy while the server runs. Copying the
file is the obvious approach and the wrong one: in WAL mode recent writes can
live in a separate `-wal` file, so a file copy may omit them or catch a write
half-done. Each backup is then opened, integrity-checked, and its row counts
compared with the live database; a copy that fails is deleted and reported. A
backup you haven't checked is a hope, not a backup.
*Cost:* a snapshot rewrites the whole file each time (fine at ~130 KB; if it
ever grows to hundreds of MB, incremental backups would be worth the complexity).

## 23. Back up at the moments that are dangerous, not just on a timer
Besides a periodic backup (startup, then when the newest is over 12 hours old),
a backup is taken automatically before a migration runs against existing data
and before an import commits. Those are the routine operations that rewrite
many rows, so they get a labelled backup that pruning never deletes. A new
install makes none: there is nothing to protect yet.

## 24. Restore is conservative: it refuses rather than guesses
It will not restore a damaged backup, a backup from a newer schema, or while
the database looks in use. That last one matters most: if the server is running
it keeps writing to the file it already opened; replacing the file underneath it
would silently throw those writes away. The signal is the `-wal`/`-shm` files an
open database leaves beside it. A crash can leave them too, which produces a
false alarm; that is the safe direction, and `force` exists for it. Restore
always saves the current database first (`pre-restore`), and removes the old
database's `-wal`/`-shm` so they cannot be replayed onto the restored data.

## 25. Export is a separate thing from backup
A backup is the database file and is only useful to this program. An export is
JSON or CSV with the full status history, meant for reading elsewhere. They are
not interchangeable, and there is deliberately no "restore from export":
that would be a second, weaker import path. CSV cells that start with `= + - @`
are prefixed with an apostrophe, because a note pasted from a web page could
otherwise run as a spreadsheet formula when the file is opened.

## 26. Stats are pure functions over rows, with stated definitions
`domain/stats.ts` takes applications plus their history and returns numbers; it
never touches the database. The definitions are the real work, and they are
written at the top of the file: "reached at least this stage" (a skipped
assessment still counts as passed), "responded" (assessment, interview, offer or
a rejection; silence and withdrawing are not responses), and a wait is
first-applied to first-response with backdated oddities dropped. Rates are
`null`, not 0%, when nothing has been applied to. Fetching all rows and counting
in memory is fine at hundreds of rows; SQL aggregation is the move if that ever
changes.

## 27. Reminders are derived, never stored
There is no reminders table to keep in sync. "Due", "overdue", "stale" and
"missed deadline" are computed from the dates already on each application and
today's date, so they are correct the moment you edit a date. The cost is no
snooze or dismiss; that would need state, and belongs with a UI that can use it.

## 28. Bulk edit allows only fields that can't cause collateral damage
`company`, `roleTitle` and `term` define identity (the duplicate check), so
changing them in bulk could silently merge or collide applications; `notes` is
too easy to overwrite wholesale. The allowed set (sector, function, location,
source, resume version, two dates) is a whitelist. It is also all-or-nothing:
if any id isn't yours, nothing changes, and the update is one SQL statement.
The repository checks ownership again on its own, because the service's check is
one line of defence, not the only one.

## 29. Company search is fuzzy only where fuzzy helps
Typing "ripling" should find "Rippling" (one edit, a transposition counts as one),
but loose fuzzy matching made "jane" suggest "Hamilton Lane" and "goog" suggest
"Moog" in the first real run. Near-misses now require 5+ letters, the same first
letter, comparison against the whole name or its first word only, and are
dropped when there are already three real matches. Your own spelling always
outranks the directory's, so a typo you made in Notion still finds itself.
The directory is cached on disk and refreshed weekly; if a refresh fails the
stale copy is used, and if there is none, search degrades to your own companies
and says so instead of erroring.

## 30. Close the database on exit
A process that exits without closing a WAL-mode database leaves `-wal`/`-shm`
files behind. Restore treats those as "the server is running", so the command
line tools and the server (on Ctrl+C) now close the connection explicitly. A
stale pair after a crash still gives a false alarm; that is the safe direction.

## 31. Bulk status change refuses the whole batch if any one move is illegal
The status rules exist so history is believable; a bulk action must not become a
way around them. `POST /api/applications/bulk/status` checks every application
against the transition table first and, if any can't make the move, changes
nothing and names them ("#12 (rejected), #31 (saved)"). The writes run in one
database transaction, so a failure part-way also leaves nothing changed. The
alternative, "apply to the ones that can and skip the rest", is friendlier but
leaves you guessing which were skipped.
**Using it:** the first real use marked 71 applications ghosted. "Silent" was
defined as applied, 21+ days with no change and no follow-up date; the two
applications that had reached an assessment were left alone, because someone had
replied. The ghost date is the day it was marked, not when the silence began
(that moment is unknowable), and each event carries a note saying so. Ghosted is
not final, so a late reply still moves it forward, and every one can be undone.
A labelled `pre-cleanup` backup was taken first.

## 32. The UI is plain files, served by the same process
No framework, no bundler, no build step: `src/web/` is HTML, CSS and ES modules,
and the API process serves it. A framework would earn its keep with many screens
and lots of shared state; this has three screens and one data source. The cost of
having nothing compile the UI is that nothing checks it either, so `src/web.test.ts`
checks the things that matter by reading the files: no `innerHTML`/`eval`, no inline
scripts or styles, no outside URLs, every import resolves, and the layering holds.
The page is served with a Content-Security-Policy (`script-src 'self'`,
`style-src 'self'`, `connect-src 'self'`, no framing). Your data includes text
imported from elsewhere, so a company called `<img onerror=...>` must display as
those characters and nothing more; the policy is the second wall behind "never
build HTML from text". It also means no Google Fonts for now (system fonts), which
is the honest price of the policy; self-hosting the font files is on the roadmap.

## 33. The server owns the rules; the browser asks
The UI asks `/api/vocab` for the statuses, the legal moves, the sectors and the
functions, and gets progress and dates from `/api/pipeline` and the application
detail. A copy of the transition table in JavaScript would work today and quietly
disagree the first time the rules change. The earlier concept demo did keep its own
copy, which is fine for a demo and exactly what the real UI must not do. The server
still re-checks everything: the UI pre-checks bulk "mark ghosted" only to give a
friendlier message naming companies, and the server is the authority.

## 34. The progress bar shows the furthest stage reached
Four segments: Applied, Assessment, Interview, Offer, filled to the furthest stage
ever reached in the dated history, not the current status. A rejection after an
interview still shows three segments, with a marker for how it ended. "Progress
toward a job" would sit at zero for nearly everything (offers are rare) and
"interviews completed" needs a total nobody knows; this needs no extra input. The
dashboard funnel uses the same rule, so a skipped assessment still counts as
having got past it.

## 35. Looks are tokens: a mode and a design
Neutrals (page, cards, lines, text) change with the mode (light, dark using
Google's dark greys, or follow the device). Four brand hues, how strongly panels
are tinted, and the accent change with the design (Soft pastel, Vibrant, Ocean).
Tiles, panels and chips are derived from those, so a new design is about ten lines
and cannot break dark mode. Soft pastel (the Hilos-style look) is the default. The
choice is remembered per browser; a classic `theme-init.js` applies it before first
paint so there is no flash of the wrong theme.

## 36. Motion is a small set of rules in one file, and a test fails if one is broken
The rules (written down by you, kept in `src/web/lib/motion-math.js`): entrances ease
out, moves ease in-out, exits ease in; popovers and dropdowns take 150-250 ms and
start at .95 scale, growing from the button that opened them and shrinking back
into it; exits are 20% shorter than entrances (computed, never typed in); rows
stagger by 30 ms; presses scale to .97; a moving knob stretches 12% and lifts a
hair mid-flight; things that travel go along an arc; nothing bounces; old and new
states overlap rather than taking turns; reveals use masks (a clip wipe for bars, a
circle spreading from the Appearance button for colour changes); icons crossfade
with a little blur; pulling something past its limit resists like a rubber band;
and anything held follows the hand with no tween.
**How it is enforced.** The numbers and curves are pure functions with unit tests
(`src/web-motion.test.ts`). `src/web.test.ts` fails if any curve leaves 0..1, any
CSS transition leaves 150-250 ms, a screen types its own duration, anything calls
`.animate()` outside `lib/motion.js` (the one place that honours "reduce motion"),
the press stops being instant while held, or an animated panel is centred with a
`transform` (an entrance animation would silently overwrite it).
**Two things worth knowing.**
1. Exits wait for their animation, so a hidden or background tab (whose animation
   clock stands still) would leave a closed panel invisible but still present and
   catching clicks. Every animation therefore also resolves on a timer.
2. Where the UI has no literal "knob" the rule is applied to the nearest thing: the
   highlight that slides between tabs. "Enter from the trigger" means a popover or the
   form grows from its button; the side drawer instead receives the company logo
   flying from the row you clicked, which is the same idea at a size that works.
Rows beyond the twelfth are not staggered: waiting 30 ms per row would make a
130-row table feel slow, so the rest simply appear.

## 37. A company is a record of its own: name and sector stored once
Before, every application carried its own copy of the company name and sector, so
"Stripe is Fintech" was written once per application and could disagree with itself,
and fixing a spelling meant editing every row. Now `companies` holds the name and the
sector, and applications point at it with `company_id`. The sector describes the
company, not the job (function is the property of the job), so it lives there. Setting it on
any one application, or in bulk, sets it for the company; a later application never
overwrites an existing sector; the new-application form shows it and locks it.
**Identity is deliberately simple.** Two names are the same company when they match
after lowercasing ASCII letters and collapsing spaces (`identityKey`). "Skydio" and
"skydio" are one company; "Stripe, Inc." is a different one until you merge them.
Anything cleverer (dropping "Inc.", accents) would have to be written twice, once in
TypeScript and once in the migration's SQL, and the two would eventually disagree. The
fuzzy matching in the search box only SUGGESTS; it never decides identity. A test runs
the real migration over awkward names and requires the SQL and the code to agree.
**The migration** rebuilt `applications` (dropping `company` and `sector`) in one
transaction, with the automatic pre-migration backup first. On the real data: 130
applications and 205 status events kept, 95 companies (four capitalisation variants
merged, display name = the first spelling that is not all lowercase), and no company
had two sectors, so none was lost. If one had, the most common sector wins, ties alphabetical.
**Consequences worth knowing.** Creating a company and its first application is one
transaction, so a failed or duplicate add leaves no empty company. Renaming a company
re-derives the duplicate key of every application there, so duplicate detection follows the
new spelling. Merging moves every application (history included) and is refused, with the
reason, if two would become the same role and term. Naming a different company on an
application moves it (it does not rename the company); a company left with no
applications at all is removed.

## 38. Insights show how much data is behind every number
A search of 94 applications with 4 replies makes most breakdowns nonsense: "Consumer Tech
replies 17%" is one reply. So every row on the Insights screen carries its counts, and
the server sends the minimum sample (10); rows below it are dimmed and marked "few", and
a note at the top says how many replies the whole page rests on. The alternative, a
clean-looking table of percentages, would quietly invite conclusions the data cannot support.
**Same definitions as the dashboard.** Only sent applications count; "replied" means a
real response (assessment, interview, offer or a rejection); interviews and offers count
at-least-that-far. **Time in a stage** is the days to the next recorded event, but a move
into "ghosted" is not counted as leaving the stage: that date is the day you decided to stop
waiting (the bulk cleanup stamped 71 of them on one day), not something that happened to the
application, and counting it would make "applied" mean however long you left it.
The two inputs the source and resume tables need (where you found it, which resume you sent)
were already columns; they are now editable in the detail panel.

## 39. People: a contact belongs to one company, links to many applications, and has a dated log
A contact is tied to at most one company, where they work NOW (people change jobs; you edit
it), using the same company record as applications, created in the same transaction. The
link to an application is many-to-many with a role for THAT application ("referrer",
"recruiter", "interviewer"...): one person can refer you to three roles, and one application can
have a recruiter and a referrer. What you did with someone is a dated log (messaged, replied,
call, asked for a referral), like an application's status history, which is what makes a
follow-up date meaningful. A company stays while a person still works there, and merging two
companies moves their people.
**Privacy and safety.** These rows are personal data about OTHER people, so they stay in your
database, are in your backups and export, and are never sent anywhere. Deleting a person is
permanent (unlike applications, which archive) and takes their log and links with it; the UI
asks first. Linking checks that BOTH the person and the application are the user's, and the
repository checks it again, so one user can never attach a contact to another's application.
A stored LinkedIn profile must be `https` on `linkedin.com`, and the UI re-checks the
address before it becomes a link, so imported or odd data can never produce a `javascript:` link.
**The alumni helper builds addresses and nothing more.** "Find SFU alumni at Stripe" assembles a
normal LinkedIn or Google search (school + company) that opens in your own browser, logged in as
you. No scraping, no automation, no use of any LinkedIn interface, which would break their terms
and could get your account restricted. Names are encoded (and quotes removed) so a company
called `A&B "Co" #1` cannot add parameters or break out of the search phrase; a test proves it.
The school is a per-user setting, default Simon Fraser University.

