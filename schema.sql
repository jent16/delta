-- Delta: Skill-gap analyzer database schema
-- Models: courses teach skills; real job postings ask for skills; a resume
-- (or a student's completed courses) is scored against those postings.
--
-- There are no hand-picked weights. "What a role requires" is derived at
-- query time from the postings ingested for it — see lib/requirements.js
-- and readiness.py for the rule.

CREATE TABLE IF NOT EXISTS skills (
    skill_id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL  -- 'language', 'framework', 'concept', 'tool'
);

CREATE TABLE IF NOT EXISTS courses (
    course_id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,   -- e.g. 'CMPT 225'
    title TEXT NOT NULL
);

-- a role someone might target, e.g. 'Software Engineer Intern'. Postings are
-- attached to a role at ingest time; the role itself carries no skill data.
-- Industry lives on job_postings, not here — a role is a job function, and
-- postings under it can span multiple employer sectors (see job_postings).
CREATE TABLE IF NOT EXISTS roles (
    role_id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL UNIQUE
);

-- academic programs/majors (e.g. "Computing Science Dual Degree Program - SFU-ZJU")
CREATE TABLE IF NOT EXISTS programs (
    program_id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    institution TEXT NOT NULL
);

-- junction table: which courses are required for a given program
CREATE TABLE IF NOT EXISTS program_courses (
    program_id INTEGER NOT NULL REFERENCES programs(program_id),
    course_id INTEGER NOT NULL REFERENCES courses(course_id),
    PRIMARY KEY (program_id, course_id)
);

-- junction table: many courses teach many skills
CREATE TABLE IF NOT EXISTS course_skills (
    course_id INTEGER NOT NULL REFERENCES courses(course_id),
    skill_id INTEGER NOT NULL REFERENCES skills(skill_id),
    PRIMARY KEY (course_id, skill_id)
);

-- tracks which courses a specific student has actually completed
CREATE TABLE IF NOT EXISTS student_courses (
    student_id INTEGER NOT NULL,
    course_id INTEGER NOT NULL REFERENCES courses(course_id),
    PRIMARY KEY (student_id, course_id)
);

-- one real job posting, kept as a first-class record so every requirement
-- can be traced to the listing (and company) that asked for it
CREATE TABLE IF NOT EXISTS job_postings (
    posting_id INTEGER PRIMARY KEY AUTOINCREMENT,
    role_id INTEGER NOT NULL REFERENCES roles(role_id),
    source TEXT NOT NULL,       -- e.g. 'adzuna', 'seed'
    external_id TEXT NOT NULL,  -- source's own posting id
    company TEXT,
    title TEXT,
    url TEXT,
    track TEXT,                 -- specialization within the role, from lib/tracks.js
    industry TEXT,               -- employer's sector, Claude-classified from lib/industries.js
                                  -- at ingest time (NULL for hand-written seed postings, which
                                  -- have no real company to classify)
    description TEXT,           -- text the skills were extracted from
    fetched_at TEXT NOT NULL,   -- ISO 8601 timestamp
    UNIQUE (source, external_id)
);

-- skills one posting asks for, as extracted by Claude at ingest time
CREATE TABLE IF NOT EXISTS posting_skills (
    posting_id INTEGER NOT NULL REFERENCES job_postings(posting_id),
    skill_id INTEGER NOT NULL REFERENCES skills(skill_id),
    level TEXT NOT NULL CHECK (level IN ('required', 'preferred')),
    PRIMARY KEY (posting_id, skill_id)
);

-- a person using Delta, with the roles they are currently targeting
CREATE TABLE IF NOT EXISTS profiles (
    profile_id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profile_roles (
    profile_id INTEGER NOT NULL REFERENCES profiles(profile_id),
    role_id INTEGER NOT NULL REFERENCES roles(role_id),
    PRIMARY KEY (profile_id, role_id)
);

-- a resume a user uploaded for matching against postings
CREATE TABLE IF NOT EXISTS resumes (
    resume_id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER REFERENCES profiles(profile_id),
    filename TEXT NOT NULL,
    unmatched_skills TEXT,      -- JSON array: skills Claude saw that no posting asks for
    qualifications TEXT,        -- JSON object: {roleTitle: [{name, evidenced, evidence}]},
                                 -- for roles scored by qualification checklist instead of
                                 -- posting-derived skills (see lib/qualifications.js) —
                                 -- computed once at upload time so re-scoring stays free
    fit_role_id INTEGER REFERENCES roles(role_id),  -- role the resume fits best today
    fit_reasoning TEXT,         -- Claude's short explanation of that fit
    uploaded_at TEXT NOT NULL   -- ISO 8601 timestamp
);

-- skills extracted from a resume's text that exist in the vocabulary
CREATE TABLE IF NOT EXISTS resume_skills (
    resume_id INTEGER NOT NULL REFERENCES resumes(resume_id),
    skill_id INTEGER NOT NULL REFERENCES skills(skill_id),
    PRIMARY KEY (resume_id, skill_id)
);
