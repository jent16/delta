"""
Computes, for a given student, how many of each role's minimum skills their
completed courses cover, and lists the specific skills that are missing.

Usage:
    python3 readiness.py            # defaults to student_id 1
    python3 readiness.py 2          # pass a different student_id
"""
import sqlite3
import sys

from requirements import role_requirements, coverage, role_label

DB_PATH = "delta.db"


def get_student_skills(cur, student_id):
    """Skills the student has, derived from courses they've completed."""
    cur.execute(
        """
        SELECT DISTINCT s.skill_id, s.name
        FROM student_courses sc
        JOIN course_skills cs ON sc.course_id = cs.course_id
        JOIN skills s ON cs.skill_id = s.skill_id
        WHERE sc.student_id = ?
        """,
        (student_id,),
    )
    return {sid: name for sid, name in cur.fetchall()}


def main():
    student_id = int(sys.argv[1]) if len(sys.argv) > 1 else 1

    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    student_skills = get_student_skills(cur, student_id)
    roles = cur.execute("SELECT role_id, title, industry FROM roles").fetchall()

    for role_id, title, industry in roles:
        req = role_requirements(cur, role_id)
        label = role_label(title, industry)
        if req["postings"] == 0:
            print(f"\n{label}: no postings ingested yet")
            continue

        have, total, missing = coverage(student_skills, req["minimum"])
        p_have, p_total, p_missing = coverage(student_skills, req["preferred"])

        print(f"\n{label}: {have}/{total} minimum skills (from {req['postings']} postings)")
        if missing:
            print(f"  Missing minimum: {', '.join(missing)}")
        else:
            print("  Meets every minimum skill.")
        if p_total:
            print(f"  Preferred: {p_have}/{p_total}" + (f" — missing {', '.join(p_missing)}" if p_missing else ""))

    conn.close()


if __name__ == "__main__":
    main()
