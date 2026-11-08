import type { SettingsRepository } from "../domain/ports.ts";
import type { Db } from "../db/connection.ts";

export function createSettingsRepository(db: Db): SettingsRepository {
  return {
    all(userId) {
      const rows = db.prepare("SELECT key, value FROM user_settings WHERE user_id = ?").all(userId) as { key: string; value: string }[];
      return Object.fromEntries(rows.map((r) => [r.key, r.value]));
    },
    set(userId, key, value) {
      if (value === null) db.prepare("DELETE FROM user_settings WHERE user_id = ? AND key = ?").run(userId, key);
      else db.prepare("INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value").run(userId, key, value);
    },
  };
}
