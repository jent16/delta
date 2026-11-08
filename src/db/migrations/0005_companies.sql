-- Companies become their own table.
--
-- Until now every application carried its own copy of the company name and sector, so "Stripe is Fintech"
-- was written once per application and could disagree with itself, and fixing a spelling meant fixing
-- every row. Now a company is stored once (name + sector) and applications point at it with company_id.
--
-- What this does, in one transaction (the runner takes a backup first and checks foreign keys before commit):
--   1. companies: one row per distinct company name, where "same name" is the simple identity key
--      (lowercase ASCII, spaces collapsed, trimmed). So "Skydio" and "skydio" become ONE company.
--      The display name is the first-added spelling that is not all lowercase, if there is one.
--   2. Its sector is the most common sector among that company's applications (ties: alphabetical).
--      On your data no company had two different sectors, so nothing is lost.
--   3. applications is rebuilt: company and sector columns go, company_id comes in, and dedupe_key is
--      recomputed in the same simple form the code now uses (company|role|term).
--
-- The key expression below is checked against the TypeScript identityKey() by a test over awkward
-- strings (tabs, double spaces, accents), because the two must always agree.

CREATE TABLE companies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,            -- identity key of the name; unique per user
    sector TEXT,                       -- NULL = unknown
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX companies_user_key ON companies (user_id, name_key);

CREATE TEMP TABLE app_keys AS
SELECT id, user_id, company, sector, created_at,
       trim(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(lower(coalesce(company, '')), char(9), ' '), char(10), ' '), char(13), ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' ')) AS ck,
       trim(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(lower(coalesce(role_title, '')), char(9), ' '), char(10), ' '), char(13), ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' ')) AS rk,
       trim(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(lower(coalesce(term, '')), char(9), ' '), char(10), ' '), char(13), ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' ')) AS tk
FROM applications;

INSERT INTO companies (user_id, name, name_key, sector, created_at, updated_at)
SELECT g.user_id,
       (SELECT k2.company FROM app_keys k2 WHERE k2.user_id = g.user_id AND k2.ck = g.ck
         ORDER BY (k2.company = lower(k2.company)) ASC, k2.id ASC LIMIT 1),
       g.ck,
       (SELECT k3.sector FROM app_keys k3 WHERE k3.user_id = g.user_id AND k3.ck = g.ck AND k3.sector IS NOT NULL
         GROUP BY k3.sector ORDER BY COUNT(*) DESC, k3.sector ASC LIMIT 1),
       MIN(g.created_at),
       MIN(g.created_at)
FROM app_keys g
GROUP BY g.user_id, g.ck;

CREATE TABLE applications_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    company_id INTEGER NOT NULL REFERENCES companies(id),
    role_title TEXT NOT NULL,
    role_function TEXT NOT NULL DEFAULT 'Other',
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

INSERT INTO applications_new (id, user_id, company_id, role_title, role_function, location, term, url, source,
    applied_on, deadline_on, follow_up_on, resume_version, compensation, notes, status, dedupe_key, archived_at, created_at, updated_at)
SELECT a.id, a.user_id, c.id, a.role_title, a.role_function, a.location, a.term, a.url, a.source,
    a.applied_on, a.deadline_on, a.follow_up_on, a.resume_version, a.compensation, a.notes, a.status,
    k.ck || '|' || k.rk || '|' || k.tk,
    a.archived_at, a.created_at, a.updated_at
FROM applications a
JOIN app_keys k ON k.id = a.id
JOIN companies c ON c.user_id = a.user_id AND c.name_key = k.ck;

DROP TABLE applications;
ALTER TABLE applications_new RENAME TO applications;
DROP TABLE app_keys;

-- dropping a table drops its indexes, so they are recreated (status_events still points at applications(id) by name)
CREATE INDEX idx_applications_user_status ON applications (user_id, status);
CREATE INDEX idx_applications_user_dedupe ON applications (user_id, dedupe_key);
CREATE INDEX idx_applications_company ON applications (company_id);
