// The ONLY place SQL for contacts lives. Every query is scoped to the user, and linking checks that BOTH the
// person and the application belong to that user, so one user can never attach their contact to another's application.

import type { Contact, ContactEvent, ContactQuery, ContactSummary, LinkedApplication, LinkedContact, LinkRole, Relationship } from "../domain/contact.ts";
import type { ContactRepository } from "../domain/ports.ts";
import type { Db } from "../db/connection.ts";
import { dropIfUnused, ensureCompany } from "./companies.ts";

interface ContactRow {
  id: number;
  user_id: number;
  company_id: number | null;
  company: string | null;
  name: string;
  title: string | null;
  email: string | null;
  linkedin_url: string | null;
  relationship: string;
  notes: string;
  follow_up_on: string | null;
  created_at: string;
  updated_at: string;
}
interface SummaryRow extends ContactRow {
  last_event_on: string | null;
  applications: number;
}

const toContact = (r: ContactRow): Contact => ({
  id: r.id,
  userId: r.user_id,
  companyId: r.company_id,
  company: r.company,
  name: r.name,
  title: r.title,
  email: r.email,
  linkedinUrl: r.linkedin_url,
  relationship: r.relationship as Relationship,
  notes: r.notes,
  followUpOn: r.follow_up_on,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

// the company's name comes from the company record, not a copy on the contact
const SELECT = "SELECT p.*, c.name AS company FROM contacts p LEFT JOIN companies c ON c.id = p.company_id";

// column names come from this fixed map, never from request data
const COLUMNS = { name: "name", title: "title", email: "email", linkedinUrl: "linkedin_url", relationship: "relationship", notes: "notes", followUpOn: "follow_up_on" } as const;

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export function createContactRepository(db: Db): ContactRepository {
  const findById = (userId: number, id: number): Contact | null => {
    const row = db.prepare(`${SELECT} WHERE p.id = ? AND p.user_id = ?`).get(id, userId) as ContactRow | undefined;
    return row ? toContact(row) : null;
  };
  const ownsApplication = (userId: number, applicationId: number) => db.prepare("SELECT 1 FROM applications WHERE id = ? AND user_id = ?").get(applicationId, userId) !== undefined;

  const events = (id: number): ContactEvent[] =>
    (db.prepare("SELECT * FROM contact_events WHERE contact_id = ? ORDER BY id").all(id) as { id: number; contact_id: number; kind: string; occurred_on: string; note: string | null; created_at: string }[]).map((e) => ({
      id: e.id, contactId: e.contact_id, kind: e.kind as ContactEvent["kind"], occurredOn: e.occurred_on, note: e.note, createdAt: e.created_at,
    }));

  const linksOf = (contactId: number): LinkedApplication[] =>
    (db.prepare(
      `SELECT ac.application_id, ac.role, a.role_title, c.name AS company FROM application_contacts ac
         JOIN applications a ON a.id = ac.application_id JOIN companies c ON c.id = a.company_id
        WHERE ac.contact_id = ? ORDER BY ac.created_at, ac.application_id`,
    ).all(contactId) as { application_id: number; role: string; role_title: string; company: string }[]).map((l) => ({
      applicationId: l.application_id, company: l.company, roleTitle: l.role_title, role: l.role as LinkRole,
    }));

  return {
    findById,

    insert(userId, f, now) {
      const id = db.transaction(() => {
        const companyId = f.company ? ensureCompany(db, userId, f.company, null, now) : null;
        return Number(
          db.prepare(
            `INSERT INTO contacts (user_id, company_id, name, title, email, linkedin_url, relationship, notes, follow_up_on, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(userId, companyId, f.name, f.title, f.email, f.linkedinUrl, f.relationship, f.notes, f.followUpOn, now, now).lastInsertRowid,
        );
      })();
      return findById(userId, id) as Contact;
    },

    list(userId, query: ContactQuery) {
      const where = ["p.user_id = ?"];
      const params: (string | number)[] = [userId];
      if (query.companyId !== undefined) { where.push("p.company_id = ?"); params.push(query.companyId); }
      if (query.relationship) { where.push("p.relationship = ?"); params.push(query.relationship); }
      if (query.dueBy) { where.push("p.follow_up_on IS NOT NULL AND p.follow_up_on <= ?"); params.push(query.dueBy); }
      if (query.q) {
        const like = `%${escapeLike(query.q)}%`;
        where.push("(p.name LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' OR p.title LIKE ? ESCAPE '\\' OR p.notes LIKE ? ESCAPE '\\')");
        params.push(like, like, like, like);
      }
      const rows = db.prepare(
        `SELECT p.*, c.name AS company,
            (SELECT e.occurred_on FROM contact_events e WHERE e.contact_id = p.id ORDER BY e.id DESC LIMIT 1) AS last_event_on,
            (SELECT COUNT(*) FROM application_contacts ac WHERE ac.contact_id = p.id) AS applications
           FROM contacts p LEFT JOIN companies c ON c.id = p.company_id
          WHERE ${where.join(" AND ")} ORDER BY p.name COLLATE NOCASE, p.id`,
      ).all(...params) as SummaryRow[];
      return rows.map((r): ContactSummary => ({ ...toContact(r), lastEventOn: r.last_event_on, applications: r.applications }));
    },

    update(userId, id, patch, now) {
      const current = findById(userId, id);
      if (!current) return null;
      db.transaction(() => {
        const sets: string[] = [];
        const params: (string | number | null)[] = [];
        let oldCompany: number | null = null;
        if ("company" in patch) {
          oldCompany = current.companyId;
          sets.push("company_id = ?");
          params.push(patch.company ? ensureCompany(db, userId, patch.company, null, now) : null);
        }
        for (const key of Object.keys(patch) as (keyof typeof COLUMNS | "company")[]) {
          if (key === "company") continue;
          sets.push(`${COLUMNS[key]} = ?`);
          params.push((patch[key] ?? null) as string | null);
        }
        sets.push("updated_at = ?");
        params.push(now, id, userId);
        db.prepare(`UPDATE contacts SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`).run(...params);
        if (oldCompany !== null) dropIfUnused(db, oldCompany); // the company the person left, if nothing else refers to it
      })();
      return findById(userId, id);
    },

    remove(userId, id) {
      const current = findById(userId, id);
      if (!current) return false;
      db.transaction(() => {
        db.prepare("DELETE FROM contacts WHERE id = ? AND user_id = ?").run(id, userId); // the log and links go with it (ON DELETE CASCADE)
        if (current.companyId !== null) dropIfUnused(db, current.companyId);
      })();
      return true;
    },

    events(userId, id) {
      return findById(userId, id) ? events(id) : [];
    },

    addEvent(userId, id, event, now) {
      if (!findById(userId, id)) return null;
      const res = db.prepare("INSERT INTO contact_events (contact_id, kind, occurred_on, note, created_at) VALUES (?, ?, ?, ?, ?)").run(id, event.kind, event.on, event.note, now);
      db.prepare("UPDATE contacts SET updated_at = ? WHERE id = ? AND user_id = ?").run(now, id, userId);
      return events(id).find((e) => e.id === Number(res.lastInsertRowid)) ?? null;
    },

    link(userId, contactId, applicationId, role, now) {
      if (!findById(userId, contactId) || !ownsApplication(userId, applicationId)) return false;
      db.prepare("INSERT INTO application_contacts (application_id, contact_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(application_id, contact_id) DO UPDATE SET role = excluded.role").run(applicationId, contactId, role, now);
      return true;
    },

    unlink(userId, contactId, applicationId) {
      if (!findById(userId, contactId) || !ownsApplication(userId, applicationId)) return false;
      return db.prepare("DELETE FROM application_contacts WHERE contact_id = ? AND application_id = ?").run(contactId, applicationId).changes > 0;
    },

    forApplication(userId, applicationId) {
      if (!ownsApplication(userId, applicationId)) return [];
      const rows = db.prepare(`${SELECT} JOIN application_contacts ac ON ac.contact_id = p.id WHERE ac.application_id = ? AND p.user_id = ? ORDER BY ac.created_at, p.id`).all(applicationId, userId) as ContactRow[];
      const roles = new Map((db.prepare("SELECT contact_id, role FROM application_contacts WHERE application_id = ?").all(applicationId) as { contact_id: number; role: string }[]).map((r) => [r.contact_id, r.role as LinkRole]));
      return rows.map((r): LinkedContact => ({ contact: toContact(r), role: roles.get(r.id) ?? "other" }));
    },

    applicationsOf(userId, contactId) {
      return findById(userId, contactId) ? linksOf(contactId) : [];
    },

    exportAll(userId) {
      return (db.prepare(`${SELECT} WHERE p.user_id = ? ORDER BY p.id`).all(userId) as ContactRow[]).map((r) => ({ contact: toContact(r), events: events(r.id), links: linksOf(r.id) }));
    },
  };
}
