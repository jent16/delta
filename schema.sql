-- Delta: Skill-gap analyzer database schema
-- Models: courses teach skills, roles require skills, students take courses

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

CREATE TABLE IF NOT EXISTS roles (
    role_id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    industry TEXT
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

-- junction table: many roles require many skills, with a weight for importance
CREATE TABLE IF NOT EXISTS role_skills (
    role_id INTEGER NOT NULL REFERENCES roles(role_id),
    skill_id INTEGER NOT NULL REFERENCES skills(skill_id),
    weight REAL NOT NULL DEFAULT 1.0,  -- 1.0 = core requirement, 0.5 = nice-to-have
    PRIMARY KEY (role_id, skill_id)
);

-- tracks which courses a specific student has actually completed
CREATE TABLE IF NOT EXISTS student_courses (
    student_id INTEGER NOT NULL,
    course_id INTEGER NOT NULL REFERENCES courses(course_id),
    PRIMARY KEY (student_id, course_id)
);

-- a resume a user uploaded for matching against roles
CREATE TABLE IF NOT EXISTS resumes (
    resume_id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    uploaded_at TEXT NOT NULL   -- ISO 8601 timestamp
);

-- skills extracted from a resume's text
CREATE TABLE IF NOT EXISTS resume_skills (
    resume_id INTEGER NOT NULL REFERENCES resumes(resume_id),
    skill_id INTEGER NOT NULL REFERENCES skills(skill_id),
    PRIMARY KEY (resume_id, skill_id)
);

-- real job postings that were ingested to derive a role's skill weights;
-- lets every role_skills weight be traced back to actual source listings
CREATE TABLE IF NOT EXISTS job_postings (
    posting_id INTEGER PRIMARY KEY AUTOINCREMENT,
    role_id INTEGER NOT NULL REFERENCES roles(role_id),
    source TEXT NOT NULL,       -- e.g. 'adzuna'
    external_id TEXT,           -- source's own posting id
    company TEXT,
    title TEXT,
    url TEXT,
    fetched_at TEXT NOT NULL    -- ISO 8601 timestamp
);
