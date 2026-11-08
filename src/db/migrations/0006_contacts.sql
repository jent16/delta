-- People: contacts, their links to applications, a dated log of what you did with them, and per-user settings.
--
-- Contacts are personal data about OTHER people, so this stays in your own database. Every row carries
-- user_id, like everything else.
--
--   contacts              a person, optionally tied to the company they work at now
--   application_contacts  many-to-many: a person can be the referrer on several applications, and an
--                         application can have a recruiter AND a referrer; `role` is what they are to THAT one
--   contact_events        the dated log (messaged, replied, call...), like an application's status history
--   user_settings         one row per preference; today just the school the alumni helper searches for

CREATE TABLE contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    company_id INTEGER REFERENCES companies(id),       -- NULL = not tied to a company
    name TEXT NOT NULL,
    title TEXT,
    email TEXT,
    linkedin_url TEXT,                                  -- validated as https on linkedin.com in the domain
    relationship TEXT NOT NULL DEFAULT 'other'
        CHECK (relationship IN ('alumni','recruiter','referral','friend','professor','other')),
    notes TEXT NOT NULL DEFAULT '',
    follow_up_on TEXT,                                  -- YYYY-MM-DD; feeds Reminders
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_contacts_user_company ON contacts (user_id, company_id);
CREATE INDEX idx_contacts_user_followup ON contacts (user_id, follow_up_on);

CREATE TABLE application_contacts (
    application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'other'
        CHECK (role IN ('referrer','recruiter','interviewer','hiring-manager','other')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (application_id, contact_id)
);
CREATE INDEX idx_application_contacts_contact ON application_contacts (contact_id);

CREATE TABLE contact_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL
        CHECK (kind IN ('messaged','replied','call','met','referral-asked','referred','note')),
    occurred_on TEXT NOT NULL,                          -- YYYY-MM-DD; can be backdated
    note TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_contact_events_contact ON contact_events (contact_id, id);

CREATE TABLE user_settings (
    user_id INTEGER NOT NULL REFERENCES users(id),
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
);
