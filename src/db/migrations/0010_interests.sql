-- "Interested": jobs you might apply to, before they are applications. Just a company, an optional role, a link
-- to the posting and a note. Starting one creates a real application (with the link and note carried over) and
-- removes the row here; nothing about the pipeline, the lists or the 130 applications you already have changes.
CREATE TABLE interests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    company TEXT NOT NULL,
    role_title TEXT,
    url TEXT,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_interests_user ON interests (user_id, created_at);
