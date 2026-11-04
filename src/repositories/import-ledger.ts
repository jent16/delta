import type { Db } from "../db/connection.ts";
import type { ImportLedger } from "../domain/ports.ts";

export function createImportLedger(db: Db): ImportLedger {
  return {
    known(userId, source) {
      const rows = db
        .prepare("SELECT external_id, application_id FROM import_records WHERE user_id = ? AND source = ?")
        .all(userId, source) as { external_id: string; application_id: number }[];
      return new Map(rows.map((r) => [r.external_id, r.application_id]));
    },
    record(userId, source, externalId, applicationId, now) {
      db.prepare("INSERT OR IGNORE INTO import_records (user_id, source, external_id, application_id, imported_at) VALUES (?, ?, ?, ?, ?)").run(
        userId, source, externalId, applicationId, now,
      );
    },
  };
}
