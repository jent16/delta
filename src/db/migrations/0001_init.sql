-- The tracker's schema. This database holds irreplaceable user data, so it is
-- changed only by new numbered migrations, never by editing this file.

-- Every row belongs to a user from day one. There is exactly one user today
-- (the local you); adding login later means filling in this table, not
-- retrofitting a user_id onto every table.
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
);
INSERT INTO users (id, name, created_at) VALUES (1, 'Me', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),

    company TEXT NOT NULL,
    role_title TEXT NOT NULL,
    role_function TEXT NOT NULL DEFAULT 'Other',  -- SWE / PM / ... (closed list, validated in the domain)
    sector TEXT,                                   -- Fintech / ... ; NULL = unknown
    location TEXT,
    term TEXT,
    url TEXT,
    source TEXT,                                   -- where you found it: Simplify, referral, career fair...

    applied_on TEXT,                               -- YYYY-MM-DD
    deadline_on TEXT,
    follow_up_on TEXT,
    resume_version TEXT,
    compensation TEXT,
    notes TEXT NOT NULL DEFAULT '',

    -- The current status is a cached copy of the newest row in status_events.
    -- It exists so "list everything that's in Interview" is one cheap query.
    -- Both are only ever written together, inside one transaction
    -- (see repositories/applications.ts), so they cannot disagree.
    status TEXT NOT NULL CHECK (status IN
        ('saved','applied','assessment','interview','offer','rejected','withdrawn','ghosted')),

    -- normalized company|role|term, used to notice an application you already added
    dedupe_key TEXT NOT NULL,

    -- Deleting your own application history is rarely what you want, so
    -- "delete" archives: hidden by default, recoverable.
    archived_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_applications_user_status ON applications (user_id, status);
CREATE INDEX idx_applications_user_dedupe ON applications (user_id, dedupe_key);

-- The dated history of every status change. Response rates, "days since
-- applied", and time-in-stage are all questions this table can answer and a
-- single status column never could.
CREATE TABLE status_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN
        ('saved','applied','assessment','interview','offer','rejected','withdrawn','ghosted')),
    occurred_on TEXT NOT NULL,                     -- YYYY-MM-DD; can be backdated ("I applied last Tuesday")
    note TEXT,
    created_at TEXT NOT NULL
);
-- "newest event" is defined by insertion order (id), not occurred_on, because
-- occurred_on can be backdated.
CREATE INDEX idx_status_events_app ON status_events (application_id, id);
