-- Until now a user with no school set was treated as being at "Simon Fraser University". From now on, no school
-- means "search for anyone at the company" (a stranger's school is not yours). Anyone who was already using the
-- tracker (has applications) relied on the old default, so it is written down for them and nothing changes.
-- A brand-new database has no applications, so its first user starts with no school.
INSERT OR IGNORE INTO user_settings (user_id, key, value)
SELECT u.id, 'school', 'Simon Fraser University' FROM users u
WHERE EXISTS (SELECT 1 FROM applications a WHERE a.user_id = u.id);
