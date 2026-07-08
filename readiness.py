"""
Computes a readiness score per role for a given student, and lists the
specific skills that are missing.

Usage:
    python3 readiness.py            # defaults to student_id 1
    python3 readiness.py 2          # pass a different student_id
"""
import sqlite3
import sys

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
    rows = cur.fetchall()
    return {sid: name for sid, name in rows}


def get_role_requirements(cur, role_id):
    cur.execute(
        """
        SELECT s.skill_id, s.name, rs.weight
        FROM role_skills rs
        JOIN skills s ON rs.skill_id = s.skill_id
        WHERE rs.role_id = ?
        """,
        (role_id,),
    )
    return cur.fetchall()


def main():
    student_id = int(sys.argv[1]) if len(sys.argv) > 1 else 1

    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    student_skills = get_student_skills(cur, student_id)

    cur.execute("SELECT role_id, title FROM roles")
    roles = cur.fetchall()

    for role_id, title in roles:
        requirements = get_role_requirements(cur, role_id)
        total_weight = sum(w for _, _, w in requirements)
        earned_weight = sum(w for sid, _, w in requirements if sid in student_skills)
        readiness = (earned_weight / total_weight * 100) if total_weight else 0

        missing = [name for sid, name, w in requirements if sid not in student_skills]

        print(f"\n{title}: {readiness:.0f}% ready")
        if missing:
            print(f"  Missing: {', '.join(missing)}")
        else:
            print("  No gaps — you meet every listed requirement.")

    conn.close()


if __name__ == "__main__":
    main()
