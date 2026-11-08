import { identityKey } from "../domain/keys.ts";
import type { ResumeVersionRepository } from "../domain/ports.ts";
import type { ResumeVersion } from "../domain/settings.ts";
import type { Db } from "../db/connection.ts";

interface Row { id: number; name: string; note: string | null; created_at: string; uses: number }

// "same name" for an application's free text is the same rule as everywhere else (identityKey), written out in SQL
// for ASCII: lowercase, trimmed. Inner double spaces are the one place it could differ, and a miss there is harmless.
const USES = `(SELECT COUNT(*) FROM applications a WHERE a.user_id = r.user_id AND a.archived_at IS NULL AND lower(trim(a.resume_version)) = r.name_key)`;
const SELECT = `SELECT r.id, r.name, r.note, r.created_at, ${USES} AS uses FROM resume_versions r`;
const toVersion = (r: Row): ResumeVersion => ({ id: r.id, name: r.name, note: r.note, uses: r.uses, createdAt: r.created_at });

export function createResumeVersionRepository(db: Db): ResumeVersionRepository {
  const findById = (userId: number, id: number) => {
    const r = db.prepare(`${SELECT} WHERE r.user_id = ? AND r.id = ?`).get(userId, id) as Row | undefined;
    return r ? toVersion(r) : null;
  };

  const update = db.transaction((userId: number, id: number, patch: { name?: string; note?: string | null }) => {
    const current = db.prepare("SELECT name, name_key FROM resume_versions WHERE user_id = ? AND id = ?").get(userId, id) as { name: string; name_key: string } | undefined;
    if (!current) return null;
    if (patch.name !== undefined) {
      const key = identityKey(patch.name);
      db.prepare("UPDATE resume_versions SET name = ?, name_key = ? WHERE id = ?").run(patch.name, key, id);
      // applications that used the old name follow it, so the Insights grouping doesn't split in two
      db.prepare("UPDATE applications SET resume_version = ? WHERE user_id = ? AND lower(trim(resume_version)) = ?").run(patch.name, userId, current.name_key);
    }
    if (patch.note !== undefined) db.prepare("UPDATE resume_versions SET note = ? WHERE id = ?").run(patch.note, id);
    return findById(userId, id);
  });

  return {
    all: (userId) => (db.prepare(`${SELECT} WHERE r.user_id = ? ORDER BY r.name_key`).all(userId) as Row[]).map(toVersion),
    findById,
    findByName(userId, name) {
      const r = db.prepare(`${SELECT} WHERE r.user_id = ? AND r.name_key = ?`).get(userId, identityKey(name)) as Row | undefined;
      return r ? toVersion(r) : null;
    },
    insert(userId, name, note, now) {
      const id = db.prepare("INSERT INTO resume_versions (user_id, name, name_key, note, created_at) VALUES (?, ?, ?, ?, ?)").run(userId, name, identityKey(name), note, now).lastInsertRowid as number;
      return findById(userId, id) as ResumeVersion;
    },
    update: (userId, id, patch) => update(userId, id, patch),
    remove: (userId, id) => db.prepare("DELETE FROM resume_versions WHERE user_id = ? AND id = ?").run(userId, id).changes > 0,
    unlisted(userId) {
      const rows = db.prepare(`SELECT MIN(trim(a.resume_version)) AS name, lower(trim(a.resume_version)) AS k, COUNT(*) AS uses
        FROM applications a
        WHERE a.user_id = ? AND a.archived_at IS NULL AND a.resume_version IS NOT NULL AND trim(a.resume_version) <> ''
          AND lower(trim(a.resume_version)) NOT IN (SELECT name_key FROM resume_versions WHERE user_id = ?)
        GROUP BY k ORDER BY uses DESC, k`).all(userId, userId) as { name: string; uses: number }[];
      return rows.map((r) => ({ name: r.name, uses: r.uses }));
    },
  };
}
