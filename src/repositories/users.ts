import type { SessionRepository, UserRecord, UserRepository } from "../domain/ports.ts";
import type { Db } from "../db/connection.ts";

interface UserRow { id: number; name: string; email: string | null; email_key: string | null; password_hash: string | null; created_at: string; last_login_at: string | null }
const COLUMNS = "id, name, email, email_key, password_hash, created_at, last_login_at";
const toUser = (r: UserRow): UserRecord => ({ id: r.id, name: r.name, email: r.email, emailKey: r.email_key, passwordHash: r.password_hash, createdAt: r.created_at, lastLoginAt: r.last_login_at });

export function createUserRepository(db: Db): UserRepository {
  const byId = db.prepare(`SELECT ${COLUMNS} FROM users WHERE id = ?`);
  const unclaimed = db.prepare("SELECT id FROM users WHERE email_key IS NULL ORDER BY id LIMIT 1");

  const register = db.transaction((f: { name: string; email: string; emailKey: string; passwordHash: string }, now: string) => {
    const free = unclaimed.get() as { id: number } | undefined;
    if (free) {
      db.prepare("UPDATE users SET name = ?, email = ?, email_key = ?, password_hash = ?, last_login_at = ? WHERE id = ?").run(f.name, f.email, f.emailKey, f.passwordHash, now, free.id);
      return { user: toUser(byId.get(free.id) as UserRow), claimed: true };
    }
    const id = db.prepare("INSERT INTO users (name, email, email_key, password_hash, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)").run(f.name, f.email, f.emailKey, f.passwordHash, now, now).lastInsertRowid as number;
    return { user: toUser(byId.get(id) as UserRow), claimed: false };
  });

  // Children first, then the rows that point at them, then the user. Deferred checking lets the order inside
  // this one transaction stop mattering; the check still runs at commit, so a table missed here makes the whole
  // deletion fail (and change nothing) instead of leaving orphans. A test lists every table to keep this honest.
  const deleteAccount = db.transaction((id: number) => {
    db.pragma("defer_foreign_keys = ON");
    const mine = (table: string) => `${table} WHERE user_id = ?`;
    db.prepare("DELETE FROM status_events WHERE application_id IN (SELECT id FROM applications WHERE user_id = ?)").run(id);
    db.prepare("DELETE FROM application_contacts WHERE application_id IN (SELECT id FROM applications WHERE user_id = ?) OR contact_id IN (SELECT id FROM contacts WHERE user_id = ?)").run(id, id);
    db.prepare("DELETE FROM contact_events WHERE contact_id IN (SELECT id FROM contacts WHERE user_id = ?)").run(id);
    for (const table of ["import_records", "contact_import_records", "contacts", "applications", "lists", "companies", "user_settings", "resume_versions", "interests", "sessions"]) {
      db.prepare(`DELETE FROM ${mine(table)}`).run(id);
    }
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
  });

  return {
    findById: (id) => { const r = byId.get(id) as UserRow | undefined; return r ? toUser(r) : null; },
    findByEmailKey: (key) => { const r = db.prepare(`SELECT ${COLUMNS} FROM users WHERE email_key = ?`).get(key) as UserRow | undefined; return r ? toUser(r) : null; },
    register: (fields, now) => register(fields, now),
    hasUnclaimed: () => unclaimed.get() !== undefined,
    setName: (id, name) => void db.prepare("UPDATE users SET name = ? WHERE id = ?").run(name, id),
    setPassword: (id, hash) => void db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, id),
    touchLogin: (id, now) => void db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(now, id),
    deleteAccount: (id) => deleteAccount(id),
  };
}

export function createSessionRepository(db: Db): SessionRepository {
  return {
    create: (tokenHash, userId, now, expiresAt) => void db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)").run(tokenHash, userId, now, now, expiresAt),
    find(tokenHash) {
      const r = db.prepare("SELECT user_id, created_at, last_seen_at, expires_at FROM sessions WHERE token_hash = ?").get(tokenHash) as { user_id: number; created_at: string; last_seen_at: string; expires_at: string } | undefined;
      return r ? { userId: r.user_id, createdAt: r.created_at, lastSeenAt: r.last_seen_at, expiresAt: r.expires_at } : null;
    },
    touch: (tokenHash, now, expiresAt) => void db.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?").run(now, expiresAt, tokenHash),
    remove: (tokenHash) => void db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash),
    removeForUser: (userId, except) => void db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash IS NOT ?").run(userId, except ?? null),
    removeExpired: (now) => void db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now),
  };
}
