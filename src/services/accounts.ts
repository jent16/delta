// Accounts and the profile. Sign-up, sign-in and sessions live in AuthService; what the person has told us
// about themselves (name, school, goals, resume versions) lives in ProfileService.
//
// Signing in never reveals whether an email has an account: an unknown email and a wrong password get the
// same answer, and take the same time.

import { createLoginThrottle, emailKey, hashToken, newSessionToken, parseLogin, parseNameChange, parsePasswordChange, parsePasswordConfirmation, parseSignup, sessionExpiry, SESSION_TOUCH_AFTER_MS } from "../domain/auth.ts";
import type { Account, LoginThrottle } from "../domain/auth.ts";
import { AuthError, NotFoundError, RateLimitedError, SignupsClosedError, ValidationError } from "../domain/errors.ts";
import type { PasswordHasher } from "../domain/password.ts";
import type { ResumeVersionRepository, SessionRepository, SettingsRepository, UserRecord, UserRepository } from "../domain/ports.ts";
import { parseNewResumeVersion, parseResumeVersionPatch, parseSettingsPatch, settingsFromStored } from "../domain/settings.ts";
import type { ResumeVersion, Settings } from "../domain/settings.ts";
import type { Clock } from "./applications.ts";

const toAccount = (u: UserRecord): Account => ({ id: u.id, name: u.name, email: u.email, createdAt: u.createdAt });

export interface AuthService {
  /** What a signed-out page needs: may someone sign up, and would signing up take over data that already exists? */
  state(): { canSignUp: boolean; claimsExistingData: boolean };
  /** Creates the account (or claims the existing data's account) and signs the new person in. */
  signUp(raw: unknown): { account: Account; token: string; claimed: boolean };
  signIn(raw: unknown): { account: Account; token: string };
  signOut(token: string): void;
  /** The account behind a session cookie, or null if it is missing, unknown or expired. Extends the session as a side effect. */
  authenticate(token: string | undefined): { account: Account; tokenHash: string } | null;
  /** Changes the password and signs every OTHER browser out. */
  changePassword(userId: number, raw: unknown, currentTokenHash: string): void;
  /** Permanently deletes the account and all its data. Needs the password again. */
  deleteAccount(userId: number, raw: unknown): void;
}

export function createAuthService(deps: {
  users: UserRepository;
  sessions: SessionRepository;
  hasher: PasswordHasher;
  clock: Clock;
  /** False on a server that should not accept new people (the one-off claim of existing data is still allowed). */
  allowSignup?: boolean;
  throttle?: LoginThrottle;
  /** Runs just before an account is deleted (the place to take a backup). */
  beforeDelete?: () => void;
}): AuthService {
  const { users, sessions, hasher, clock } = deps;
  const throttle = deps.throttle ?? createLoginThrottle();
  const allowSignup = deps.allowSignup ?? true;
  const now = () => clock().toISOString();

  const startSession = (userId: number) => {
    const { token, hash } = newSessionToken();
    const t = clock();
    sessions.removeExpired(t.toISOString());
    sessions.create(hash, userId, t.toISOString(), sessionExpiry(t, t).toISOString());
    return token;
  };

  const mustBeUser = (userId: number): UserRecord => {
    const u = users.findById(userId);
    if (!u) throw new AuthError();
    return u;
  };

  const checkPassword = (user: UserRecord, password: string, field: string) => {
    if (!user.passwordHash || !hasher.verify(password, user.passwordHash)) throw new ValidationError([{ field, message: "is not right" }]);
  };

  return {
    state: () => ({ canSignUp: allowSignup || users.hasUnclaimed(), claimsExistingData: users.hasUnclaimed() }),

    signUp(raw) {
      const input = parseSignup(raw);
      if (!allowSignup && !users.hasUnclaimed()) throw new SignupsClosedError();
      const key = emailKey(input.email);
      if (users.findByEmailKey(key)) throw new ValidationError([{ field: "email", message: "already has an account — sign in instead" }]);
      const { user, claimed } = users.register({ name: input.name, email: input.email, emailKey: key, passwordHash: hasher.hash(input.password) }, now());
      return { account: toAccount(user), token: startSession(user.id), claimed };
    },

    signIn(raw) {
      const { email, password } = parseLogin(raw);
      const key = emailKey(email);
      const wait = throttle.wait(key, clock().getTime());
      if (wait > 0) throw new RateLimitedError(wait);
      const user = users.findByEmailKey(key);
      const ok = user?.passwordHash ? hasher.verify(password, user.passwordHash) : (hasher.burn(password), false);
      if (!ok || !user) {
        throttle.failed(key, clock().getTime());
        throw new AuthError("that email and password don't match");
      }
      throttle.succeeded(key);
      users.touchLogin(user.id, now());
      return { account: toAccount(user), token: startSession(user.id) };
    },

    signOut(token) {
      sessions.remove(hashToken(token));
    },

    authenticate(token) {
      if (!token) return null;
      const tokenHash = hashToken(token);
      const s = sessions.find(tokenHash);
      if (!s) return null;
      const t = clock();
      if (new Date(s.expiresAt).getTime() <= t.getTime()) { sessions.remove(tokenHash); return null; }
      const user = users.findById(s.userId);
      if (!user) { sessions.remove(tokenHash); return null; }
      if (t.getTime() - new Date(s.lastSeenAt).getTime() >= SESSION_TOUCH_AFTER_MS) {
        sessions.touch(tokenHash, t.toISOString(), sessionExpiry(new Date(s.createdAt), t).toISOString());
      }
      return { account: toAccount(user), tokenHash };
    },

    changePassword(userId, raw, currentTokenHash) {
      const user = mustBeUser(userId);
      const { current, next } = parsePasswordChange(raw);
      checkPassword(user, current, "current");
      users.setPassword(userId, hasher.hash(next));
      sessions.removeForUser(userId, currentTokenHash); // anyone else who was signed in (or had stolen a cookie) is out
    },

    deleteAccount(userId, raw) {
      const user = mustBeUser(userId);
      const { password } = parsePasswordConfirmation(raw);
      checkPassword(user, password, "password");
      deps.beforeDelete?.();
      users.deleteAccount(userId);
    },
  };
}

// ---------------------------------------------------------------------------------------------

export interface Profile extends Settings {
  name: string;
  email: string | null;
  createdAt: string;
}

export interface ProfileService {
  get(userId: number): { profile: Profile; resumeVersions: ResumeVersion[]; unlisted: { name: string; uses: number }[] };
  /** The name and the settings fields (school, program, gradYear, targetRoles, targetTerms), any of them. */
  edit(userId: number, raw: unknown): Profile;
  addResumeVersion(userId: number, raw: unknown): ResumeVersion;
  editResumeVersion(userId: number, id: number, raw: unknown): ResumeVersion;
  removeResumeVersion(userId: number, id: number): void;
}

export function createProfileService(deps: { users: UserRepository; settings: SettingsRepository; versions: ResumeVersionRepository; clock: Clock }): ProfileService {
  const { users, settings, versions, clock } = deps;
  const profile = (userId: number): Profile => {
    const u = users.findById(userId);
    if (!u) throw new NotFoundError("account");
    return { ...settingsFromStored(settings.all(userId)), name: u.name, email: u.email, createdAt: u.createdAt };
  };
  const mustFind = (userId: number, id: number) => {
    const v = versions.findById(userId, id);
    if (!v) throw new NotFoundError("resume version");
    return v;
  };
  const refuseTaken = (userId: number, name: string, exceptId?: number) => {
    const clash = versions.findByName(userId, name);
    if (clash && clash.id !== exceptId) throw new ValidationError([{ field: "name", message: `you already have a resume version called "${clash.name}"` }]);
  };

  return {
    get: (userId) => ({ profile: profile(userId), resumeVersions: versions.all(userId), unlisted: versions.unlisted(userId) }),

    edit(userId, raw) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new ValidationError([{ field: "(body)", message: "must be a JSON object" }]);
      const { name, ...rest } = raw as Record<string, unknown>;
      // validate everything before writing anything, so a bad field changes nothing
      const newName = "name" in (raw as object) ? parseNameChange(name) : undefined;
      const patch = Object.keys(rest).length ? parseSettingsPatch(rest) : {};
      if (newName === undefined && Object.keys(rest).length === 0) throw new ValidationError([{ field: "(body)", message: "nothing to change" }]);
      if (newName !== undefined) users.setName(userId, newName);
      for (const [key, value] of Object.entries(patch)) settings.set(userId, key, value ?? null);
      return profile(userId);
    },

    addResumeVersion(userId, raw) {
      const { name, note } = parseNewResumeVersion(raw);
      refuseTaken(userId, name);
      return versions.insert(userId, name, note, clock().toISOString());
    },

    editResumeVersion(userId, id, raw) {
      const patch = parseResumeVersionPatch(raw);
      mustFind(userId, id);
      if (patch.name !== undefined) refuseTaken(userId, patch.name, id);
      return versions.update(userId, id, patch) as ResumeVersion;
    },

    removeResumeVersion(userId, id) {
      mustFind(userId, id);
      versions.remove(userId, id);
    },
  };
}
