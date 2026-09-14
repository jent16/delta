"""
Derives what a role requires from the postings ingested for it. Python twin
of lib/requirements.js — keep the two rules in sync.

A skill is a "minimum" for a role when at least MIN_SHARE of that role's
postings list it as required. It is "preferred" when at least PREF_SHARE of
postings mention it at any level but it did not make the minimum set.
"""
import sqlite3

MIN_SHARE = 0.5
PREF_SHARE = 0.2


def role_requirements(cur, role_id):
    """Returns {"postings": n, "minimum": [(skill_id, name)], "preferred": [(skill_id, name)]}."""
    n = cur.execute(
        "SELECT COUNT(*) FROM job_postings WHERE role_id = ?", (role_id,)
    ).fetchone()[0]
    if n == 0:
        return {"postings": 0, "minimum": [], "preferred": []}

    rows = cur.execute(
        """
        SELECT s.skill_id, s.name,
               SUM(CASE WHEN ps.level = 'required' THEN 1 ELSE 0 END) AS required_n,
               COUNT(*) AS any_n
        FROM job_postings jp
        JOIN posting_skills ps ON ps.posting_id = jp.posting_id
        JOIN skills s ON s.skill_id = ps.skill_id
        WHERE jp.role_id = ?
        GROUP BY s.skill_id
        ORDER BY required_n DESC, any_n DESC, s.name
        """,
        (role_id,),
    ).fetchall()

    minimum, preferred = [], []
    for sid, name, required_n, any_n in rows:
        if required_n / n >= MIN_SHARE:
            minimum.append((sid, name))
        elif any_n / n >= PREF_SHARE:
            preferred.append((sid, name))
    return {"postings": n, "minimum": minimum, "preferred": preferred}


def coverage(skills_have, requirement_list):
    """(have_count, total, missing_names) for a list of (skill_id, name)."""
    have = [name for sid, name in requirement_list if sid in skills_have]
    missing = [name for sid, name in requirement_list if sid not in skills_have]
    return len(have), len(requirement_list), missing


def role_label(title, industry):
    return f"{title} ({industry})" if industry else title
