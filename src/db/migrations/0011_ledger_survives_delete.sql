-- Deleting an application for good must not let the Notion import bring it back.
--
-- import_records remembers which source row became which application, and a remembered row is never read again
-- (decision 18). That promise used to rest on applications only ever being archived. Now an application can be
-- deleted, so the ledger row has to outlive it: application_id becomes nullable and is set to NULL when the
-- application goes, exactly as contact_import_records already does for people. The row stays, so re-running the
-- import skips it instead of recreating something you deleted on purpose.
CREATE TABLE import_records_new (
    user_id INTEGER NOT NULL REFERENCES users(id),
    source TEXT NOT NULL,
    external_id TEXT NOT NULL,
    application_id INTEGER REFERENCES applications(id) ON DELETE SET NULL,
    imported_at TEXT NOT NULL,
    PRIMARY KEY (user_id, source, external_id)
);
INSERT INTO import_records_new (user_id, source, external_id, application_id, imported_at)
SELECT user_id, source, external_id, application_id, imported_at FROM import_records;
DROP TABLE import_records;
ALTER TABLE import_records_new RENAME TO import_records;
