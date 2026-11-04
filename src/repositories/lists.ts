// SQL for saved lists. The filter is stored as JSON text and parsed back here;
// it was validated by the domain before it was ever written.

import type { Db } from "../db/connection.ts";
import type { ListFilter, ListPatch, NewList, SavedList } from "../domain/list.ts";
import type { ListRepository } from "../domain/ports.ts";

interface ListRow {
  id: number;
  user_id: number;
  name: string;
  filter: string;
  created_at: string;
  updated_at: string;
}

const toList = (r: ListRow): SavedList => ({
  id: r.id,
  userId: r.user_id,
  name: r.name,
  filter: JSON.parse(r.filter) as ListFilter,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function createListRepository(db: Db): ListRepository {
  const findById = (userId: number, id: number): SavedList | null => {
    const row = db.prepare("SELECT * FROM lists WHERE id = ? AND user_id = ?").get(id, userId) as ListRow | undefined;
    return row ? toList(row) : null;
  };

  return {
    findById,

    insert(userId, list: NewList, now) {
      const res = db
        .prepare("INSERT INTO lists (user_id, name, filter, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(userId, list.name, JSON.stringify(list.filter), now, now);
      return findById(userId, Number(res.lastInsertRowid)) as SavedList;
    },

    findByName(userId, name) {
      const row = db
        .prepare("SELECT * FROM lists WHERE user_id = ? AND name = ? COLLATE NOCASE")
        .get(userId, name) as ListRow | undefined;
      return row ? toList(row) : null;
    },

    all(userId) {
      return (db.prepare("SELECT * FROM lists WHERE user_id = ? ORDER BY id").all(userId) as ListRow[]).map(toList);
    },

    update(userId, id, patch: ListPatch, now) {
      const sets: string[] = [];
      const params: (string | number)[] = [];
      if (patch.name !== undefined) {
        sets.push("name = ?");
        params.push(patch.name);
      }
      if (patch.filter !== undefined) {
        sets.push("filter = ?");
        params.push(JSON.stringify(patch.filter));
      }
      sets.push("updated_at = ?");
      params.push(now, id, userId);
      db.prepare(`UPDATE lists SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`).run(...params);
      return findById(userId, id);
    },

    remove(userId, id) {
      return db.prepare("DELETE FROM lists WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
    },
  };
}
