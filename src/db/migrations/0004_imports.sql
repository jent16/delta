-- The import ledger: which row in an outside source became which application.
--
-- It is what makes importing safe to repeat. A row already in the ledger is
-- skipped, even if you have since edited or archived the application in Delta,
-- because from the moment of import Delta is the source of truth and the
-- source is never read back into an existing application.
CREATE TABLE import_records (
    user_id INTEGER NOT NULL REFERENCES users(id),
    source TEXT NOT NULL,                          -- e.g. "notion:3d49313a165e8039b400ca1c947f0865"
    external_id TEXT NOT NULL,                     -- the row's id in that source
    application_id INTEGER NOT NULL REFERENCES applications(id),
    imported_at TEXT NOT NULL,
    PRIMARY KEY (user_id, source, external_id)
);
