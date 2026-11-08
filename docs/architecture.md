# Architecture

The tracker core lives in `src/` (TypeScript). The original Delta modules
(Adzuna ingestion, skill scoring, Find Openings, the Notion push) are still in
`lib/`, `scripts/` and `server.js` as plain JavaScript and keep working; the
tracker does not depend on them.

## The layers

```
HTTP request
    |
    v
 api/            translate HTTP <-> services. Parse the request, call a service,
    |            shape the response, map domain errors to status codes.
    v
 services/       use-cases ("add an application", "change its status"). Apply the
    |            rules, coordinate storage, return domain objects. No SQL, no HTTP.
    v
 domain/         the rules themselves: what an Application is, which status moves
                 are legal, what valid input looks like. Pure functions and types.
                 No database, no Express, no file system.

 importers/      adapters to outside systems (Notion rows to import, Simplify's
                 company list for search). They fetch and flatten
                 rows into the domain's SourceRow and know nothing else.

 repositories/   the only place SQL exists. Implements the *port* declared in
                 domain/ports.ts, translating rows <-> domain objects.
 db/             opening the database, applying migrations, and backing up /
                 restoring the database file.
 web/            the browser UI: plain HTML/CSS/JS served as static files. It only ever
                 talks to api/ over HTTP, so it is the one layer that can change
                 freely (see "The web UI has layers too" below).
 compose.ts      the composition root: builds every object and hands each one
                 what it needs. The only place that knows about all the layers.
 main.ts, import-notion.ts
                 entry points (web server, import command). They call compose.ts.
```

Sign-in follows the same layers: `domain/auth.ts` and `domain/password.ts` (pure rules, hashing),
`services/accounts.ts` (sign-up, sessions, profile), `repositories/users.ts` and `resume-versions.ts` (SQL),
and `api/app.ts`, where one check in front of `/api` turns a session cookie into the `userId` every
service call already takes.

### The dependency rule

Source code may only depend **inward**:

| layer | may import |
|---|---|
| `domain` | `domain` |
| `db` | `db` |
| `repositories` | `domain`, `db` |
| `importers` | `domain` |
| `services` | `domain` |
| `api` | `services`, `domain` |

`src/architecture.test.ts` enforces this by scanning every import. It is a test
rather than a paragraph in a document because a document erodes the first time
someone is in a hurry, and a red build does not. A new directory under `src/`
that isn't in the rules fails the test too, so it can't be quietly exempt.

### The web UI has layers too

`src/web/` has no build step and no TypeScript, so nothing checks it for you; the
structure is held by `src/web.test.ts` instead.

```
app.js          start-up, the top bar, which screen shows, keyboard shortcuts
views/          one file per screen (dashboard, applications, reminders) and per panel
                (drawer, new-application). They ask lib/api.js for data and draw it.
lib/            pieces shared by screens: api.js (the ONLY file that makes requests),
                dom.js (build elements; text only, never HTML), state.js, ui.js
                (chips, progress bar, menus, toast), overlay.js, format.js, theme.js
```

The same one-way rule applies: `lib/` never imports `views/` or `app.js`, and
`views/` never imports `app.js` (screens reach the shell through `lib/ctx.js`).
The UI also keeps no copy of the business rules. Which moves are legal, the list of
sectors, and how far an application got all arrive from the server (`/api/vocab`,
`/api/pipeline`), so the two can't disagree. The one exception is cosmetic:
filtering the table by status, sorting and searching run in the browser on the rows
already loaded, because it makes typing instant.

### Why bother

Concrete payoffs you can already see in this repo:

- **The rules are testable without a server or a database.** `domain/status.test.ts`
  checks all 64 status transitions in milliseconds.
- **Services never see SQL.** They talk to the `ApplicationRepository` *port*
  (an interface owned by the domain). SQLite is one implementation; the storage
  depends on the domain, not the reverse.
- **HTTP is replaceable.** Nothing below `api/` knows what a request is, so a
  Notion importer calls the same application service the web API does, so an
  imported row gets the same validation, duplicate check and status history as
  one you typed. A CSV importer later only needs a new adapter.
- **One place per kind of change.** A column rename touches `repositories/` and
  a migration. A new status rule touches `domain/status.ts`. A new endpoint
  touches `api/` and, if it's a new use-case, one service function.

### Two kinds of data, two files

| | `delta.db` (legacy) | `var/tracker.db` (tracker) |
|---|---|---|
| Contents | job postings, skills, scoring inputs | **your applications** |
| Source of truth | CSVs in git | the database itself |
| If lost | rebuild with `build_db.py` | gone — back it up |
| Schema changes | edit `schema.sql`, rebuild | numbered, append-only migrations |

Keeping them in separate files means the rebuildable data can never endanger
the irreplaceable data, and a backup is just "copy `var/`".

## Reading the code in the order a request travels

1. `src/api/app.ts` — the route for `POST /api/applications/:id/status`
2. `src/services/applications.ts` — `changeStatus`
3. `src/domain/status.ts` and `src/domain/application.ts` — the rules and validation it calls
4. `src/repositories/applications.ts` — `addStatusChange`, which writes the event and updates the status in one transaction
5. `src/db/migrations/0001_init.sql` — the tables underneath

## Running it

```bash
npm run tracker        # http://localhost:3001   (data in ./var/tracker.db)
npm test               # legacy tests + tracker tests
npm run typecheck      # tsc --noEmit
```

`DELTA_DATA_DIR` moves the data folder; `TRACKER_PORT` moves the port.
