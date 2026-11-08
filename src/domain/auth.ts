// Accounts: what a valid sign-up, sign-in and password change look like, how emails are compared,
// how a session token is made, and how repeated wrong passwords are slowed down. All pure: the hashing
// itself is in password.ts and the storage is behind ports.

import { createHash, randomBytes } from "node:crypto";
import { ValidationError } from "./errors.ts";
import type { ValidationIssue } from "./errors.ts";

export const MIN_PASSWORD = 10;
export const MAX_PASSWORD = 200; // a hash of a huge input is a cheap way to tie up a server
export const SESSION_IDLE_DAYS = 30;     // signed out after this long without opening the app
export const SESSION_MAX_DAYS = 90;      // and never stay signed in longer than this, however often you visit
export const SESSION_TOUCH_AFTER_MS = 6 * 3_600_000; // "last seen" is rewritten at most every 6 hours, not on every click

export interface Account {
  id: number;
  name: string;
  email: string | null;
  createdAt: string;
}

/** Emails are compared lowercased and trimmed. (ASCII only, like every other key in the app.) */
export function emailKey(email: string): string {
  return email.replace(/[A-Z]/g, (c) => c.toLowerCase()).trim();
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// the passwords everybody tries first; a short blocklist, not a promise. Length is what actually protects you.
const COMMON = new Set(["password", "password1", "password12", "password123", "1234567890", "12345678910", "qwertyuiop", "iloveyou12", "letmein123", "0123456789", "abcdefghij", "1q2w3e4r5t", "qwerty12345", "admin12345", "welcome123"]);

function passwordIssues(password: string, email: string | null): string | null {
  if (password.length < MIN_PASSWORD) return `must be at least ${MIN_PASSWORD} characters`;
  if (password.length > MAX_PASSWORD) return `must be at most ${MAX_PASSWORD} characters`;
  const lowered = password.toLowerCase();
  if (COMMON.has(lowered) || /^(.)\1+$/.test(password)) return "is too easy to guess";
  if (email && (lowered === email.toLowerCase() || lowered === email.split("@")[0]!.toLowerCase())) return "must not be your email";
  return null;
}

function asObject(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new ValidationError([{ field: "(body)", message: "must be a JSON object" }]);
  return raw as Record<string, unknown>;
}

function readEmail(body: Record<string, unknown>, issues: ValidationIssue[]): string {
  const v = body.email;
  if (typeof v !== "string" || !v.trim()) { issues.push({ field: "email", message: "is required" }); return ""; }
  const email = v.trim();
  if (email.length > 254 || !EMAIL.test(email)) issues.push({ field: "email", message: "doesn't look like an email address" });
  return email;
}

function readName(value: unknown, issues: ValidationIssue[]): string {
  if (typeof value !== "string" || !value.trim()) { issues.push({ field: "name", message: "is required" }); return ""; }
  const name = value.replace(/\s+/g, " ").trim();
  if (name.length > 100) issues.push({ field: "name", message: "is too long (max 100)" });
  return name;
}

export interface Signup { name: string; email: string; password: string }

export function parseSignup(raw: unknown): Signup {
  const body = asObject(raw);
  const issues: ValidationIssue[] = [];
  const email = readEmail(body, issues);
  const name = readName(body.name, issues);
  const password = typeof body.password === "string" ? body.password : "";
  if (typeof body.password !== "string") issues.push({ field: "password", message: "is required" });
  else {
    const problem = passwordIssues(password, email || null);
    if (problem) issues.push({ field: "password", message: problem });
  }
  if (issues.length) throw new ValidationError(issues);
  return { name, email, password };
}

export function parseLogin(raw: unknown): { email: string; password: string } {
  const body = asObject(raw);
  // deliberately lenient: a login only needs to be well-formed; the rules for what a GOOD password is apply when choosing one
  if (typeof body.email !== "string" || !body.email.trim() || typeof body.password !== "string" || !body.password) {
    throw new ValidationError([{ field: "(body)", message: "enter your email and password" }]);
  }
  if (body.password.length > MAX_PASSWORD || body.email.length > 254) throw new ValidationError([{ field: "(body)", message: "enter your email and password" }]);
  return { email: body.email.trim(), password: body.password };
}

export function parsePasswordChange(raw: unknown, email: string | null): { current: string; next: string } {
  const body = asObject(raw);
  const issues: ValidationIssue[] = [];
  if (typeof body.current !== "string" || !body.current) issues.push({ field: "current", message: "enter your current password" });
  const next = typeof body.next === "string" ? body.next : "";
  const problem = typeof body.next === "string" ? passwordIssues(next, email) : "is required";
  if (problem) issues.push({ field: "next", message: problem });
  if (issues.length) throw new ValidationError(issues);
  return { current: body.current as string, next };
}

export function parsePasswordConfirmation(raw: unknown): { password: string } {
  const body = asObject(raw);
  if (typeof body.password !== "string" || !body.password || body.password.length > MAX_PASSWORD) throw new ValidationError([{ field: "password", message: "enter your password to confirm" }]);
  return { password: body.password };
}

export function parseNameChange(value: unknown): string {
  const issues: ValidationIssue[] = [];
  const name = readName(value, issues);
  if (issues.length) throw new ValidationError(issues);
  return name;
}

// ---- sessions ----

/** A random token for the cookie, and the hash that is stored. The token itself is never stored. */
export function newSessionToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** When a session last seen at `seenAt` and created at `createdAt` stops working. */
export function sessionExpiry(createdAt: Date, seenAt: Date): Date {
  const idle = seenAt.getTime() + SESSION_IDLE_DAYS * 86_400_000;
  const absolute = createdAt.getTime() + SESSION_MAX_DAYS * 86_400_000;
  return new Date(Math.min(idle, absolute));
}

// ---- slowing down password guessing ----

/**
 * Counts wrong passwords per key (the email). After MAX_FAILURES within WINDOW the key is locked until the last
 * failure is WINDOW old. In memory only: restarting the server forgives everyone, which is fine for slowing
 * a guesser down (a real hosted deployment would also rate-limit by address at its proxy).
 */
export const THROTTLE = { maxFailures: 5, windowMs: 15 * 60_000, maxKeys: 5000 } as const;

export interface LoginThrottle {
  /** Seconds until another attempt is allowed; 0 when it is allowed now. */
  wait(key: string, now: number): number;
  failed(key: string, now: number): void;
  succeeded(key: string): void;
}

export function createLoginThrottle(): LoginThrottle {
  const failures = new Map<string, { count: number; last: number }>();
  const prune = (now: number) => {
    for (const [k, v] of failures) if (now - v.last >= THROTTLE.windowMs) failures.delete(k);
  };
  return {
    wait(key, now) {
      const f = failures.get(key);
      if (!f) return 0;
      if (now - f.last >= THROTTLE.windowMs) { failures.delete(key); return 0; }
      return f.count >= THROTTLE.maxFailures ? Math.ceil((f.last + THROTTLE.windowMs - now) / 1000) : 0;
    },
    failed(key, now) {
      const f = failures.get(key);
      const fresh = !f || now - f.last >= THROTTLE.windowMs;
      if (failures.size >= THROTTLE.maxKeys && !failures.has(key)) prune(now);
      if (failures.size >= THROTTLE.maxKeys && !failures.has(key)) return; // full of live lockouts: refuse to grow rather than evict a real one
      failures.set(key, { count: fresh ? 1 : f!.count + 1, last: now });
    },
    succeeded(key) {
      failures.delete(key);
    },
  };
}
