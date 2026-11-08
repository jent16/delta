-- The ledger for people imported from outside (LinkedIn's connections file): which person in the source became
-- which contact. It is what makes importing safe to repeat.
--
-- contact_id is SET NULL when you delete the contact, and the row STAYS. So a person you deleted is remembered as
-- "imported before" and a re-import does not bring them back: deleting someone is a choice. (Applications work
-- the same way: an imported row is skipped even after you have archived it.)
CREATE TABLE contact_import_records (
    user_id INTEGER NOT NULL REFERENCES users(id),
    source TEXT NOT NULL,                          -- "linkedin"
    external_id TEXT NOT NULL,                     -- the person's key in that source (profile link, else email, else name|company)
    contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
    imported_at TEXT NOT NULL,
    PRIMARY KEY (user_id, source, external_id)
);
