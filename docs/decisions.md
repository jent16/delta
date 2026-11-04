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
