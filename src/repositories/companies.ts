// SQL for companies. Applications point at a company (company_id); the company holds the name and the
// sector, so each is written in exactly one place.

import { dedupeKey } from "../domain/application.ts";
import type { CompanySummary } from "../domain/company-record.ts";
import type { CompanyRepository } from "../domain/ports.ts";
import { identityKey } from "../domain/keys.ts";
import type { Sector } from "../domain/vocab.ts";
import type { Db } from "../db/connection.ts";

interface CompanyRow {
  id: number;
  user_id: number;
  name: string;
  sector: string | null;
  created_at: string;
  updated_at: string;
  applications: number;
  total: number;
}

const toSummary = (r: CompanyRow): CompanySummary => ({
  id: r.id,
  userId: r.user_id,
  name: r.name,
  sector: r.sector as Sector | null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  applications: r.applications,
  totalApplications: r.total,
});

const SELECT = `SELECT c.*,
    (SELECT COUNT(*) FROM applications a WHERE a.company_id = c.id AND a.archived_at IS NULL) AS applications,
    (SELECT COUNT(*) FROM applications a WHERE a.company_id = c.id) AS total
  FROM companies c`;

/**
 * Finds the user's company with this name (by identity key) or creates it, and returns its id.
 * An existing company keeps its sector; a missing one is filled in if a sector is offered
 * (so the first application you add for a company can set it, but a later one never overwrites it).
 * Runs inside the caller's transaction, so a company is never created for an application that then fails.
 */
export function ensureCompany(db: Db, userId: number, name: string, sector: string | null, now: string): number {
  const key = identityKey(name);
  const row = db.prepare("SELECT id, sector FROM companies WHERE user_id = ? AND name_key = ?").get(userId, key) as { id: number; sector: string | null } | undefined;
  if (row) {
    if (row.sector === null && sector) db.prepare("UPDATE companies SET sector = ?, updated_at = ? WHERE id = ?").run(sector, now, row.id);
    return row.id;
  }
  const res = db.prepare("INSERT INTO companies (user_id, name, name_key, sector, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(userId, name, key, sector, now, now);
  return Number(res.lastInsertRowid);
}

/** Removes a company nothing refers to any more (not an application, even archived, and not a contact). */
export function dropIfUnused(db: Db, companyId: number): void {
  db.prepare("DELETE FROM companies WHERE id = ? AND NOT EXISTS (SELECT 1 FROM applications WHERE company_id = companies.id) AND NOT EXISTS (SELECT 1 FROM contacts WHERE company_id = companies.id)").run(companyId);
}

export function createCompanyRepository(db: Db): CompanyRepository {
  const findById = (userId: number, id: number): CompanySummary | null => {
    const row = db.prepare(`${SELECT} WHERE c.user_id = ? AND c.id = ?`).get(userId, id) as CompanyRow | undefined;
    return row ? toSummary(row) : null;
  };

  /** Re-derives every application's duplicate key from its company's CURRENT name. */
  const rekey = (companyId: number, name: string) => {
    const apps = db.prepare("SELECT id, role_title, term FROM applications WHERE company_id = ?").all(companyId) as { id: number; role_title: string; term: string | null }[];
    const set = db.prepare("UPDATE applications SET dedupe_key = ? WHERE id = ?");
    for (const a of apps) set.run(dedupeKey({ company: name, roleTitle: a.role_title, term: a.term }), a.id);
  };

  return {
    all(userId) {
      return (db.prepare(`${SELECT} WHERE c.user_id = ? ORDER BY c.name COLLATE NOCASE, c.id`).all(userId) as CompanyRow[]).map(toSummary);
    },

    findById,

    findByName(userId, name) {
      const row = db.prepare(`${SELECT} WHERE c.user_id = ? AND c.name_key = ?`).get(userId, identityKey(name)) as CompanyRow | undefined;
      return row ? toSummary(row) : null;
    },

    rename(userId, id, name, now) {
      if (!findById(userId, id)) return null;
      db.transaction(() => {
        db.prepare("UPDATE companies SET name = ?, name_key = ?, updated_at = ? WHERE id = ? AND user_id = ?").run(name, identityKey(name), now, id, userId);
        rekey(id, name); // the duplicate keys contain the company's name, so they follow it
      })();
      return findById(userId, id);
    },

    setSector(userId, id, sector, now) {
      if (!findById(userId, id)) return null;
      db.prepare("UPDATE companies SET sector = ?, updated_at = ? WHERE id = ? AND user_id = ?").run(sector, now, id, userId);
      return findById(userId, id);
    },

    mergeConflicts(userId, fromId, intoId) {
      const into = findById(userId, intoId);
      if (!into) return [];
      const keys = db.prepare("SELECT dedupe_key FROM applications WHERE company_id = ? AND archived_at IS NULL").all(intoId) as { dedupe_key: string }[];
      const taken = new Set(keys.map((k) => k.dedupe_key));
      const moving = db.prepare("SELECT role_title, term FROM applications WHERE company_id = ? AND archived_at IS NULL").all(fromId) as { role_title: string; term: string | null }[];
      return moving.filter((a) => taken.has(dedupeKey({ company: into.name, roleTitle: a.role_title, term: a.term }))).map((a) => (a.term ? `${a.role_title} (${a.term})` : a.role_title));
    },

    merge(userId, fromId, intoId, now) {
      const from = findById(userId, fromId);
      const into = findById(userId, intoId);
      if (!from || !into) return null;
      let moved = 0;
      db.transaction(() => {
        moved = db.prepare("UPDATE applications SET company_id = ?, updated_at = ? WHERE company_id = ? AND user_id = ?").run(intoId, now, fromId, userId).changes;
        db.prepare("UPDATE contacts SET company_id = ?, updated_at = ? WHERE company_id = ? AND user_id = ?").run(intoId, now, fromId, userId); // the people come along
        rekey(intoId, into.name);
        // keep a sector that only the merged-away company had
        if (into.sector === null && from.sector !== null) db.prepare("UPDATE companies SET sector = ?, updated_at = ? WHERE id = ?").run(from.sector, now, intoId);
        db.prepare("DELETE FROM companies WHERE id = ? AND user_id = ?").run(fromId, userId);
      })();
      return { company: findById(userId, intoId) as CompanySummary, moved };
    },
  };
}
