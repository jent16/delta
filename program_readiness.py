"""
Compares an entire academic program's curriculum (not just one student's
completed courses) against role requirements — i.e. "if you finished
every required course in this program, how many of each role's minimum
skills would the curriculum alone have covered?"

Usage:
    python3 program_readiness.py
"""
import sqlite3

from requirements import role_requirements, coverage, role_label

DB_PATH = "delta.db"


def get_program_skills(cur, program_id):
    cur.execute(
        """
        SELECT DISTINCT s.skill_id, s.name
        FROM program_courses pc
        JOIN course_skills cs ON pc.course_id = cs.course_id
        JOIN skills s ON cs.skill_id = s.skill_id
        WHERE pc.program_id = ?
        """,
        (program_id,),
    )
    return {sid: name for sid, name in cur.fetchall()}


def main():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    programs = cur.execute("SELECT program_id, name FROM programs").fetchall()
    roles = cur.execute("SELECT role_id, title, industry FROM roles").fetchall()

    for program_id, program_name in programs:
        program_skills = get_program_skills(cur, program_id)
        print(f"\n=== {program_name} ===")
        print(f"Curriculum covers {len(program_skills)} distinct skills.")

        for role_id, title, industry in roles:
            req = role_requirements(cur, role_id)
            label = role_label(title, industry)
            if req["postings"] == 0:
                print(f"\n  {label}: no postings ingested yet")
                continue

            have, total, missing = coverage(program_skills, req["minimum"])
            print(f"\n  {label}: {have}/{total} minimum skills covered by curriculum")
            if missing:
                print(f"    Not covered by any required course: {', '.join(missing)}")
            else:
                print("    Fully covered by the curriculum.")

    conn.close()


if __name__ == "__main__":
    main()
