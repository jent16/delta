"""
Builds delta.db from schema.sql and the CSV files in data/.
Run this any time you want to rebuild the database from scratch:
    python3 build_db.py
"""
import sqlite3
import csv
import os

DB_PATH = "delta.db"
DATA_DIR = "data"


def load_csv(path):
    if not os.path.exists(path):
        return []
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def main():
    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)

    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA foreign_keys = ON")
    cur = conn.cursor()

    with open("schema.sql") as f:
        cur.executescript(f.read())

    # --- skills ---
    for row in load_csv(f"{DATA_DIR}/skills.csv"):
        cur.execute(
            "INSERT INTO skills (name, category) VALUES (?, ?)",
            (row["name"], row["category"]),
        )

    # --- courses ---
    for row in load_csv(f"{DATA_DIR}/courses.csv"):
        cur.execute(
            "INSERT INTO courses (code, title) VALUES (?, ?)",
            (row["code"], row["title"]),
        )

    # --- roles ---
    for row in load_csv(f"{DATA_DIR}/roles.csv"):
        cur.execute(
            "INSERT INTO roles (title, industry) VALUES (?, ?)",
            (row["title"], row["industry"]),
        )

    # --- programs ---
    for row in load_csv(f"{DATA_DIR}/programs.csv"):
        cur.execute(
            "INSERT INTO programs (name, institution) VALUES (?, ?)",
            (row["name"], row["institution"]),
        )

    conn.commit()

    # build lookup maps now that IDs exist
    skill_id = {name: sid for sid, name in cur.execute("SELECT skill_id, name FROM skills")}
    course_id = {code: cid for cid, code in cur.execute("SELECT course_id, code FROM courses")}
    # keyed by (title, industry) since the same title can be ingested under
    # multiple industries as distinct roles
    role_id = {
        (title, industry): rid
        for rid, title, industry in cur.execute("SELECT role_id, title, industry FROM roles")
    }
    program_id = {name: pid for pid, name in cur.execute("SELECT program_id, name FROM programs")}

    # --- course_skills ---
    for row in load_csv(f"{DATA_DIR}/course_skills.csv"):
        cur.execute(
            "INSERT INTO course_skills (course_id, skill_id) VALUES (?, ?)",
            (course_id[row["course_code"]], skill_id[row["skill_name"]]),
        )

    # --- student_courses ---
    for row in load_csv(f"{DATA_DIR}/student_courses.csv"):
        cur.execute(
            "INSERT INTO student_courses (student_id, course_id) VALUES (?, ?)",
            (int(row["student_id"]), course_id[row["course_code"]]),
        )

    # --- program_courses ---
    for row in load_csv(f"{DATA_DIR}/program_courses.csv"):
        cur.execute(
            "INSERT INTO program_courses (program_id, course_id) VALUES (?, ?)",
            (program_id[row["program_name"]], course_id[row["course_code"]]),
        )

    # --- job_postings ---
    for row in load_csv(f"{DATA_DIR}/job_postings.csv"):
        cur.execute(
            """INSERT INTO job_postings
               (role_id, source, external_id, company, title, url, track, description, fetched_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                role_id[(row["role_title"], row["industry"])],
                row["source"],
                row["external_id"],
                row["company"],
                row["title"],
                row["url"],
                row["track"],
                row["description"],
                row["fetched_at"],
            ),
        )

    conn.commit()

    posting_id = {
        (source, ext): pid
        for pid, source, ext in cur.execute(
            "SELECT posting_id, source, external_id FROM job_postings"
        )
    }

    # --- posting_skills ---
    for row in load_csv(f"{DATA_DIR}/posting_skills.csv"):
        cur.execute(
            "INSERT OR IGNORE INTO posting_skills (posting_id, skill_id, level) VALUES (?, ?, ?)",
            (
                posting_id[(row["source"], row["external_id"])],
                skill_id[row["skill_name"]],
                row["level"],
            ),
        )

    conn.commit()
    conn.close()
    print(f"Built {DB_PATH} from {DATA_DIR}/ successfully.")


if __name__ == "__main__":
    main()
