import test from "node:test";
import assert from "node:assert/strict";
import { AuthError, NotFoundError, RateLimitedError, SignupsClosedError, ValidationError } from "../domain/errors.ts";
import { THROTTLE } from "../domain/auth.ts";
import { hashToken } from "../domain/auth.ts";
import { makeTracker } from "../testing/harness.ts";

const ME = { name: "Justin", email: "justin@example.com", password: "a long enough one" };
const issues = (fn: () => unknown) => {
  try { fn(); } catch (e) { if (e instanceof ValidationError) return e.issues.map((i) => `${i.field}: ${i.message}`); throw e; }
  return [];
};

test("the first sign-up claims the existing data; the next one starts empty", () => {
  const t = makeTracker();
  t.service.add(1, { company: "Stripe", roleTitle: "SWE" });
  assert.deepEqual(t.auth.state(), { canSignUp: true, claimsExistingData: true });

  const first = t.auth.signUp(ME);
  assert.equal(first.claimed, true);
  assert.equal(first.account.id, 1);
  assert.equal(t.service.list(first.account.id, {}).length, 1); // the application came with the account
  assert.deepEqual(t.auth.state(), { canSignUp: true, claimsExistingData: false });

  const second = t.auth.signUp({ ...ME, email: "other@example.com", name: "Other" });
  assert.equal(second.claimed, false);
  assert.notEqual(second.account.id, 1);
  assert.equal(t.service.list(second.account.id, {}).length, 0);
  assert.equal(t.service.list(1, {}).length, 1); // and cannot see the first person's
});

test("an email can only have one account, however it is written", () => {
  const t = makeTracker();
  t.auth.signUp(ME);
  assert.deepEqual(issues(() => t.auth.signUp({ ...ME, email: "  JUSTIN@example.com " })), ["email: already has an account — sign in instead"]);
  assert.equal((t.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n, 1);
});

test("signing in: right password works (any case of the email); wrong password and unknown email give the same answer", () => {
  const t = makeTracker();
  t.auth.signUp(ME);
  assert.equal(t.auth.signIn({ email: "JUSTIN@example.com", password: ME.password }).account.email, "justin@example.com");
  const wrong = (() => { try { t.auth.signIn({ email: ME.email, password: "not the password" }); } catch (e) { return e as Error; } })();
  const unknown = (() => { try { t.auth.signIn({ email: "nobody@example.com", password: "whatever it is" }); } catch (e) { return e as Error; } })();
  assert.ok(wrong instanceof AuthError && unknown instanceof AuthError);
  assert.equal(wrong.message, unknown.message);
});

test("the unclaimed legacy user cannot be signed in to (it has no password)", () => {
  const t = makeTracker();
  assert.throws(() => t.auth.signIn({ email: "me", password: "anything at all" }), AuthError);
  assert.equal(t.users.findById(1)?.passwordHash, null);
});

test("the stored password is a hash, never the password", () => {
  const t = makeTracker();
  t.auth.signUp(ME);
  const row = t.db.prepare("SELECT password_hash FROM users WHERE id = 1").get() as { password_hash: string };
  assert.ok(row.password_hash.startsWith("scrypt$") && !row.password_hash.includes(ME.password));
});

test("a session token authenticates; only its hash is stored; sign-out and unknown tokens do not", () => {
  const t = makeTracker();
  const { token, account } = t.auth.signUp(ME);
  assert.equal(t.auth.authenticate(token)?.account.id, account.id);
  assert.equal(t.auth.authenticate(undefined), null);
  assert.equal(t.auth.authenticate(""), null);
  assert.equal(t.auth.authenticate("made-up"), null);
  const stored = t.db.prepare("SELECT token_hash FROM sessions").all() as { token_hash: string }[];
  assert.deepEqual(stored.map((r) => r.token_hash), [hashToken(token)]);
  t.auth.signOut(token);
  assert.equal(t.auth.authenticate(token), null);
});

test("a session expires after 30 idle days, is extended by use, and ends at 90 days regardless", () => {
  const t = makeTracker();
  const { token } = t.auth.signUp(ME);
  t.advance(29);
  assert.ok(t.auth.authenticate(token));         // used on day 29: now good until day 59
  t.advance(29);
  assert.ok(t.auth.authenticate(token));         // day 58: still good (until day 88)
  t.advance(29);
  assert.ok(t.auth.authenticate(token));         // day 87: until day 90 at most
  t.advance(4);
  assert.equal(t.auth.authenticate(token), null); // day 91: past the 90-day cap even though it was used 4 days ago
  assert.equal((t.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n, 0); // and it was cleaned up

  const { token: t2 } = t.auth.signIn({ email: ME.email, password: ME.password });
  t.advance(31);
  assert.equal(t.auth.authenticate(t2), null);   // idle for 31 days
});

test("using a session does not rewrite it on every request, only every few hours", () => {
  const t = makeTracker();
  const { token } = t.auth.signUp(ME);
  const seen = () => (t.db.prepare("SELECT last_seen_at FROM sessions").get() as { last_seen_at: string }).last_seen_at;
  const first = seen();
  t.advance(1 / 24 * 5);                 // five hours
  t.auth.authenticate(token);
  assert.equal(seen(), first);
  t.advance(1 / 24 * 2);                 // seven hours in total
  t.auth.authenticate(token);
  assert.notEqual(seen(), first);
});

test("a session whose user no longer exists is refused and removed", () => {
  const t = makeTracker();
  const { token } = t.auth.signUp(ME);
  t.db.pragma("foreign_keys = OFF");
  t.db.prepare("DELETE FROM users WHERE id = 1").run();
  t.db.pragma("foreign_keys = ON");
  assert.equal(t.auth.authenticate(token), null);
  assert.equal((t.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n, 0);
});

test("five wrong passwords lock the email, even for the right password; waiting unlocks it; other emails are unaffected", () => {
  const t = makeTracker();
  t.auth.signUp(ME);
  t.auth.signUp({ ...ME, email: "b@example.com", name: "B" });
  for (let i = 0; i < THROTTLE.maxFailures; i++) assert.throws(() => t.auth.signIn({ email: ME.email, password: "wrong wrong wrong" }), AuthError);
  assert.throws(() => t.auth.signIn({ email: ME.email, password: ME.password }), RateLimitedError);
  assert.ok(t.auth.signIn({ email: "b@example.com", password: ME.password }));
  t.advance(1 / 24);                     // an hour: well past 15 minutes
  assert.ok(t.auth.signIn({ email: ME.email, password: ME.password }));
});

test("locking applies to emails that have no account too, so it can't be used to tell who has one", () => {
  const t = makeTracker();
  for (let i = 0; i < THROTTLE.maxFailures; i++) assert.throws(() => t.auth.signIn({ email: "ghost@example.com", password: "wrong wrong wrong" }), AuthError);
  assert.throws(() => t.auth.signIn({ email: "ghost@example.com", password: "wrong wrong wrong" }), RateLimitedError);
});

test("changing the password: needs the current one, signs other browsers out, keeps this one", () => {
  const t = makeTracker();
  const a = t.auth.signUp(ME);
  const other = t.auth.signIn({ email: ME.email, password: ME.password });
  const me = t.auth.authenticate(a.token)!;
  assert.deepEqual(issues(() => t.auth.changePassword(1, { current: "wrong password!", next: "a brand new password" }, me.tokenHash)), ["current: is not right"]);
  assert.ok(t.auth.authenticate(other.token)); // nothing happened yet
  assert.deepEqual(issues(() => t.auth.changePassword(1, { current: ME.password, next: "" }, me.tokenHash)), ["next: is required"]);
  t.auth.changePassword(1, { current: ME.password, next: "a brand new password" }, me.tokenHash);
  assert.ok(t.auth.authenticate(a.token));
  assert.equal(t.auth.authenticate(other.token), null);
  assert.throws(() => t.auth.signIn({ email: ME.email, password: ME.password }), AuthError);
  assert.ok(t.auth.signIn({ email: ME.email, password: "a brand new password" }));
});

test("signups can be closed, except for claiming the data that already exists", () => {
  const t = makeTracker(undefined, undefined, undefined, { allowSignup: false });
  assert.deepEqual(t.auth.state(), { canSignUp: true, claimsExistingData: true });
  t.auth.signUp(ME);                                        // claims it
  assert.deepEqual(t.auth.state(), { canSignUp: false, claimsExistingData: false });
  assert.throws(() => t.auth.signUp({ ...ME, email: "x@example.com" }), SignupsClosedError);
  assert.ok(t.auth.signIn({ email: ME.email, password: ME.password })); // existing accounts still sign in
});

test("deleting an account needs the password, takes a backup first, and removes everything of theirs and nothing of anyone else's", () => {
  const t = makeTracker();
  t.auth.signUp(ME);
  const b = t.auth.signUp({ ...ME, email: "b@example.com", name: "B" }).account.id;
  t.service.add(1, { company: "Stripe", roleTitle: "SWE" });
  t.service.add(b, { company: "Stripe", roleTitle: "SWE" });
  assert.deepEqual(issues(() => t.auth.deleteAccount(1, { password: "not right at all" })), ["password: is not right"]);
  assert.equal(t.deletions.length, 0);
  assert.equal(t.service.list(1, {}).length, 1);

  t.auth.deleteAccount(1, { password: ME.password });
  assert.equal(t.deletions.length, 1);
  assert.equal(t.users.findById(1), null);
  assert.equal(t.service.list(b, {}).length, 1);
  assert.throws(() => t.auth.signIn({ email: ME.email, password: ME.password }), AuthError);
});

test("profile: name and settings fields save together or not at all; the email is read-only", () => {
  const t = makeTracker();
  t.auth.signUp(ME);
  const edited = t.profile.edit(1, { name: " Justin  T ", school: "SFU", program: "Computer Science", gradYear: 2028, targetRoles: ["SWE", "PM"], targetTerms: ["Summer 2027"] });
  assert.deepEqual([edited.name, edited.school, edited.program, edited.gradYear, edited.targetRoles, edited.targetTerms, edited.email], ["Justin T", "SFU", "Computer Science", 2028, ["SWE", "PM"], ["Summer 2027"], "justin@example.com"]);
  // one bad field refuses the whole patch, including the good name
  assert.throws(() => t.profile.edit(1, { name: "Changed", gradYear: 1850 }), ValidationError);
  assert.equal(t.profile.get(1).profile.name, "Justin T");
  assert.throws(() => t.profile.edit(1, { email: "other@example.com" }), ValidationError);
  assert.throws(() => t.profile.edit(1, {}), ValidationError);
  assert.throws(() => t.profile.edit(1, { name: "" }), ValidationError);
  assert.equal(t.profile.edit(1, { gradYear: null, program: "" }).gradYear, null);
  assert.equal(t.profile.get(1).profile.program, "");
  assert.throws(() => t.profile.edit(1, [] as unknown as object), ValidationError);
  // the alumni helper reads the school from the same place
  assert.equal(t.settings.get(1).school, "SFU");
});

test("profile: someone else's profile and settings are separate", () => {
  const t = makeTracker();
  t.auth.signUp(ME);
  const b = t.auth.signUp({ ...ME, email: "b@example.com", name: "B" }).account.id;
  t.profile.edit(1, { school: "SFU", targetTerms: ["Summer 2027"] });
  assert.deepEqual([t.profile.get(b).profile.targetTerms, t.profile.get(b).profile.name], [[], "B"]);
  assert.throws(() => t.profile.get(999), NotFoundError);
});

test("resume versions: add, no duplicates (any case), rename follows onto applications, delete keeps applications", () => {
  const t = makeTracker();
  t.auth.signUp(ME);
  const b = t.auth.signUp({ ...ME, email: "b@example.com", name: "B" }).account.id;
  const v3 = t.profile.addResumeVersion(1, { name: "SWE-v3", note: "for startups" });
  assert.deepEqual([v3.name, v3.note, v3.uses], ["SWE-v3", "for startups", 0]);
  assert.deepEqual(issues(() => t.profile.addResumeVersion(1, { name: " swe-V3 " })), ['name: you already have a resume version called "SWE-v3"']);
  assert.ok(t.profile.addResumeVersion(b, { name: "SWE-v3" })); // another person may use the same name

  const a1 = t.service.add(1, { company: "Stripe", roleTitle: "SWE", resumeVersion: "swe-v3" });
  const a2 = t.service.add(1, { company: "Ramp", roleTitle: "SWE", resumeVersion: "PM-v1" });
  t.service.archive(1, t.service.add(1, { company: "Block", roleTitle: "SWE", resumeVersion: "SWE-v3" }).id);
  assert.equal(t.profile.get(1).resumeVersions[0]!.uses, 2 - 1); // archived applications don't count
  assert.deepEqual(t.profile.get(1).unlisted, [{ name: "PM-v1", uses: 1 }]);

  const v2 = t.profile.addResumeVersion(1, { name: "SWE-v2" });
  assert.deepEqual(issues(() => t.profile.editResumeVersion(1, v2.id, { name: "swe-v3" })), ['name: you already have a resume version called "SWE-v3"']);
  assert.equal(t.profile.editResumeVersion(1, v2.id, { name: "SWE-v2" }).name, "SWE-v2"); // renaming to itself is fine

  const renamed = t.profile.editResumeVersion(1, v3.id, { name: "SWE-final" });
  assert.deepEqual([renamed.name, renamed.uses], ["SWE-final", 1]);
  assert.equal(t.service.get(1, a1.id).application.resumeVersion, "SWE-final");
  assert.equal(t.service.get(1, a2.id).application.resumeVersion, "PM-v1"); // others untouched
  assert.equal(t.profile.editResumeVersion(1, v3.id, { note: null }).note, null);
  assert.equal(t.profile.get(b).resumeVersions[0]!.name, "SWE-v3"); // and nobody else's changed

  t.profile.removeResumeVersion(1, v3.id);
  assert.equal(t.service.get(1, a1.id).application.resumeVersion, "SWE-final"); // text stays on the application
  assert.deepEqual(t.profile.get(1).unlisted.map((u) => u.name).sort(), ["PM-v1", "SWE-final"]);
  assert.throws(() => t.profile.removeResumeVersion(1, v3.id), NotFoundError);
  assert.throws(() => t.profile.editResumeVersion(b, v2.id, { note: "x" }), NotFoundError); // not yours
  assert.throws(() => t.profile.removeResumeVersion(b, v2.id), NotFoundError);
});

test("a successful sign-in forgives earlier wrong passwords (they don't add up across good logins)", () => {
  const t = makeTracker();
  t.auth.signUp(ME);
  for (let i = 0; i < THROTTLE.maxFailures - 1; i++) assert.throws(() => t.auth.signIn({ email: ME.email, password: "wrong wrong wrong" }), AuthError);
  assert.ok(t.auth.signIn({ email: ME.email, password: ME.password }));
  for (let i = 0; i < THROTTLE.maxFailures - 1; i++) assert.throws(() => t.auth.signIn({ email: ME.email, password: "wrong wrong wrong" }), AuthError);
  assert.ok(t.auth.signIn({ email: ME.email, password: ME.password })); // would be locked if the first four still counted
});

test("an unknown email still costs a full password check (so it can't be told apart by speed)", async () => {
  const { createAuthService } = await import("./accounts.ts");
  const { createScryptHasher } = await import("../domain/password.ts");
  const t = makeTracker();
  t.auth.signUp(ME);
  const real = createScryptHasher({ N: 1024, r: 8, p: 1 });
  const calls: string[] = [];
  const auth = createAuthService({ users: t.users, sessions: t.sessions, clock: t.clock,
    hasher: { hash: (p) => real.hash(p), verify: (p, s) => { calls.push("verify"); return real.verify(p, s); }, burn: (p) => { calls.push("burn"); real.burn(p); } } });
  assert.throws(() => auth.signIn({ email: "ghost@example.com", password: "whatever it is" }), AuthError);
  assert.deepEqual(calls, ["burn"]);
  calls.length = 0;
  assert.throws(() => auth.signIn({ email: ME.email, password: "wrong wrong wrong" }), AuthError);
  assert.deepEqual(calls, ["verify"]);
});
