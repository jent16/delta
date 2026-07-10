"""
Compares an entire academic program's curriculum (not just one student's
completed courses) against role requirements — i.e. "if you finished
every required course in this program, how ready would you be for each
role, based purely on the curriculum?"

Usage:
    python3 program_readiness.py
"""
import sqlite3

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
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    programs = cur.execute("SELECT program_id, name FROM programs").fetchall()
    roles = cur.execute("SELECT role_id, title FROM roles").fetchall()

    for program_id, program_name in programs:
        program_skills = get_program_skills(cur, program_id)
        print(f"\n=== {program_name} ===")
        print(f"Curriculum covers {len(program_skills)} distinct skills.")

        for role_id, role_title in roles:
            requirements = get_role_requirements(cur, role_id)
            total_weight = sum(w for _, _, w in requirements)
            covered_weight = sum(
                w for sid, _, w in requirements if sid in program_skills
            )
            coverage = (covered_weight / total_weight * 100) if total_weight else 0

            missing = [name for sid, name, w in requirements if sid not in program_skills]

            print(f"\n  {role_title}: {coverage:.0f}% covered by curriculum")
            if missing:
                print(f"    Not covered by any required course: {', '.join(missing)}")
            else:
                print("    Fully covered by the curriculum.")

    conn.close()


if __name__ == "__main__":
    main()
