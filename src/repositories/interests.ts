import type { Interest, InterestPatch } from "../domain/interest.ts";
import type { InterestRepository } from "../domain/ports.ts";
import type { Db } from "../db/connection.ts";

interface Row { id: number; company: string; role_title: string | null; url: string | null; note: string; created_at: string; updated_at: string }
const toInterest = (r: Row): Interest => ({ id: r.id, company: r.company, roleTitle: r.role_title, url: r.url, note: r.note, createdAt: r.created_at, updatedAt: r.updated_at });
const COLUMNS = "id, company, role_title, url, note, created_at, updated_at";
const COLUMN_OF: Record<keyof InterestPatch, string> = { company: "company", roleTitle: "role_title", url: "url", note: "note" };

export function createInterestRepository(db: Db): InterestRepository {
  const findById = (userId: number, id: number) => {
    const r = db.prepare(`SELECT ${COLUMNS} FROM interests WHERE user_id = ? AND id = ?`).get(userId, id) as Row | undefined;
    return r ? toInterest(r) : null;
  };
  return {
    all: (userId) => (db.prepare(`SELECT ${COLUMNS} FROM interests WHERE user_id = ? ORDER BY created_at DESC, id DESC`).all(userId) as Row[]).map(toInterest),
    findById,
    insert(userId, f, now) {
      const id = db.prepare("INSERT INTO interests (user_id, company, role_title, url, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(userId, f.company, f.roleTitle, f.url, f.note, now, now).lastInsertRowid as number;
      return findById(userId, id) as Interest;
    },
    update(userId, id, patch, now) {
      const keys = (Object.keys(patch) as (keyof InterestPatch)[]).filter((k) => k in COLUMN_OF); // column names come from this table, never from the request
      const sets = keys.map((k) => `${COLUMN_OF[k]} = ?`);
      const info = db.prepare(`UPDATE interests SET ${[...sets, "updated_at = ?"].join(", ")} WHERE user_id = ? AND id = ?`).run(...keys.map((k) => patch[k] ?? null), now, userId, id);
      return info.changes ? findById(userId, id) : null;
    },
    remove: (userId, id) => db.prepare("DELETE FROM interests WHERE user_id = ? AND id = ?").run(userId, id).changes > 0,
  };
}
