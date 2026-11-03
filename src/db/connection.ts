import Database from "better-sqlite3";

export type Db = Database.Database;

export function openDatabase(file: string): Db {
  const db = new Database(file);
  if (file !== ":memory:") db.pragma("journal_mode = WAL"); // readers don't block the writer
  db.pragma("foreign_keys = ON"); // SQLite ignores FOREIGN KEY unless asked, per connection
  db.pragma("busy_timeout = 5000");
  return db;
}
