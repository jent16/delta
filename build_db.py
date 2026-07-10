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
    role_id = {title: rid for rid, title in cur.execute("SELECT role_id, title FROM roles")}
    program_id = {name: pid for pid, name in cur.execute("SELECT program_id, name FROM programs")}

    # --- course_skills ---
    for row in load_csv(f"{DATA_DIR}/course_skills.csv"):
        cur.execute(
            "INSERT INTO course_skills (course_id, skill_id) VALUES (?, ?)",
            (course_id[row["course_code"]], skill_id[row["skill_name"]]),
        )

    # --- role_skills ---
    for row in load_csv(f"{DATA_DIR}/role_skills.csv"):
        cur.execute(
            "INSERT INTO role_skills (role_id, skill_id, weight) VALUES (?, ?, ?)",
            (role_id[row["role_title"]], skill_id[row["skill_name"]], float(row["weight"])),
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

    conn.commit()
    conn.close()
    print(f"Built {DB_PATH} from {DATA_DIR}/ successfully.")


if __name__ == "__main__":
    main()
