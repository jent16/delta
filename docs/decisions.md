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
`saved -> applied -> assessment -> interview -> offer`, ending in `rejected`,
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
