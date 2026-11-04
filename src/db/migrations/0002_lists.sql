-- Saved filters ("lists"). A list stores a filter, never application ids, so an
-- application can match any number of lists and nothing is copied or moved.
--
-- `filter` is JSON in the shape of the domain's ListFilter:
--   {"statuses":[...], "roleFunctions":[...], "sectors":[...], "includeArchived":true}
-- It is validated in the domain on every write; json_valid is only the backstop.
CREATE TABLE lists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    filter TEXT NOT NULL CHECK (json_valid(filter)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Names are unique per user, ignoring case ("swe" and "SWE" are the same list).
CREATE UNIQUE INDEX lists_user_name ON lists (user_id, name COLLATE NOCASE);

-- Starter lists for the one existing user. This runs exactly once (a migration
-- never re-runs), so deleting a starter list is permanent — unlike seeding at
-- startup, which would quietly bring it back. A test asserts these filters
-- still pass the domain validator, so this SQL cannot drift from the code.
--   Fintech-adjacent = SWE/Quant roles at trading firms, banks, PE, or fintech companies.
INSERT INTO lists (user_id, name, filter, created_at, updated_at) VALUES
  (1, 'SWE', '{"roleFunctions":["SWE"]}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  (1, 'PM', '{"roleFunctions":["PM"]}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  (1, 'Fintech-adjacent', '{"roleFunctions":["SWE","Quant"],"sectors":["Fintech","Finance"]}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
