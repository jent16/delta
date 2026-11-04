-- Adds the "drafting" status (you've started the application — writing the
-- answers, tailoring the resume — but haven't submitted).
--
-- SQLite cannot alter a CHECK constraint, so both tables that carry the status
-- list are rebuilt: create new, copy every row (ids included), drop old,
-- rename. The runner switches foreign keys off around this and verifies them
-- with foreign_key_check before committing; without that, dropping
-- `applications` would cascade-delete every status event.

CREATE TABLE applications_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    company TEXT NOT NULL,
    role_title TEXT NOT NULL,
    role_function TEXT NOT NULL DEFAULT 'Other',
    sector TEXT,
    location TEXT,
    term TEXT,
    url TEXT,
    source TEXT,
    applied_on TEXT,
    deadline_on TEXT,
    follow_up_on TEXT,
    resume_version TEXT,
    compensation TEXT,
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN
        ('saved','drafting','applied','assessment','interview','offer','rejected','withdrawn','ghosted')),
    dedupe_key TEXT NOT NULL,
    archived_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
INSERT INTO applications_new (id, user_id, company, role_title, role_function, sector, location, term, url, source,
    applied_on, deadline_on, follow_up_on, resume_version, compensation, notes, status, dedupe_key, archived_at, created_at, updated_at)
SELECT id, user_id, company, role_title, role_function, sector, location, term, url, source,
    applied_on, deadline_on, follow_up_on, resume_version, compensation, notes, status, dedupe_key, archived_at, created_at, updated_at
FROM applications;

CREATE TABLE status_events_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN
        ('saved','drafting','applied','assessment','interview','offer','rejected','withdrawn','ghosted')),
    occurred_on TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL
);
INSERT INTO status_events_new (id, application_id, status, occurred_on, note, created_at)
SELECT id, application_id, status, occurred_on, note, created_at FROM status_events;

DROP TABLE status_events;
DROP TABLE applications;
ALTER TABLE applications_new RENAME TO applications;
ALTER TABLE status_events_new RENAME TO status_events;

-- dropping a table drops its indexes, so they are recreated
CREATE INDEX idx_applications_user_status ON applications (user_id, status);
CREATE INDEX idx_applications_user_dedupe ON applications (user_id, dedupe_key);
CREATE INDEX idx_status_events_app ON status_events (application_id, id);
