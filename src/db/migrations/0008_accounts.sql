-- Accounts: email + password sign-in, sessions, and a place for your resume versions.
--
-- The users table has existed since 0001 with one row ("Me", id 1) that owns every application.
-- Nothing is moved: that row simply gains an email and a password hash the first time somebody signs up
-- (they "claim" it), so the 130 applications you already have stay yours.

ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN email_key TEXT;        -- the email as compared: ASCII-lowercased, trimmed
ALTER TABLE users ADD COLUMN password_hash TEXT;    -- scrypt, never the password itself
ALTER TABLE users ADD COLUMN last_login_at TEXT;
-- a person can only have one account per email; rows with no email yet (the unclaimed one) don't count
CREATE UNIQUE INDEX idx_users_email_key ON users (email_key) WHERE email_key IS NOT NULL;

-- A session is a logged-in browser. The cookie holds a random token; only its SHA-256 is stored here,
-- so a leaked copy of the database cannot be used to sign in as anyone.
CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions (user_id);

-- The names of the resume versions you send ("SWE-v3"). Names only: no files are stored. An application's
-- "resume version" stays free text, so old rows keep working; this list is what the field suggests.
CREATE TABLE resume_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_resume_versions_key ON resume_versions (user_id, name_key);
