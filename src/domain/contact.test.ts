import test from "node:test";
import assert from "node:assert/strict";
import { alumniLinks, DEFAULT_SCHOOL } from "./alumni.ts";
import { isLinkedInUrl, parseContactPatch, parseContactQuery, parseEvent, parseLink, parseNewContact } from "./contact.ts";
import { ValidationError } from "./errors.ts";
import { DEFAULT_SETTINGS, parseSettingsPatch } from "./settings.ts";

const issues = (fn: () => unknown) => { try { fn(); } catch (e) { if (e instanceof ValidationError) return e.issues.map((i) => i.field).sort(); throw e; } return null; };

test("a new contact needs a name; everything else is optional, with sensible defaults", () => {
  assert.deepEqual(parseNewContact({ name: "  Priya   Shah " }), { name: "Priya Shah", company: null, title: null, email: null, linkedinUrl: null, relationship: "other", notes: "", followUpOn: null });
  assert.deepEqual(issues(() => parseNewContact({})), ["name"]);
  assert.deepEqual(issues(() => parseNewContact({ name: "   " })), ["name"]);
  assert.deepEqual(issues(() => parseNewContact({ name: "x".repeat(201) })), ["name"]);
});

test("every field is validated, and a typo in a field name is an error rather than silently dropped", () => {
  const ok = parseNewContact({ name: "A", company: "Stripe", title: "Recruiter", email: "a@b.co", linkedinUrl: "https://www.linkedin.com/in/a", relationship: "alumni", notes: "met at the fair", followUpOn: "2026-11-20" });
  assert.deepEqual([ok.company, ok.relationship, ok.followUpOn, ok.email], ["Stripe", "alumni", "2026-11-20", "a@b.co"]);
  for (const [bad, field] of [[{ email: "nope" }, "email"], [{ email: "a@b" }, "email"], [{ relationship: "boss" }, "relationship"], [{ followUpOn: "2026-02-30" }, "followUpOn"], [{ followUpOn: "soon" }, "followUpOn"],
    [{ linkedinUrl: "http://linkedin.com/in/a" }, "linkedinUrl"], [{ title: 5 }, "title"], [{ notes: "x".repeat(5001) }, "notes"], [{ compny: "Stripe" }, "compny"]] as const) {
    assert.deepEqual(issues(() => parseNewContact({ name: "A", ...bad })), [field], JSON.stringify(bad));
  }
  assert.deepEqual(issues(() => parseNewContact(null)), ["(body)"]);
  assert.deepEqual(issues(() => parseNewContact([])), ["(body)"]);
});

test("a LinkedIn link must be https on linkedin.com: never javascript:, http, credentials, or a look-alike domain", () => {
  for (const good of ["https://linkedin.com/in/a", "https://www.linkedin.com/in/a?x=1", "https://ca.linkedin.com/in/a"]) assert.equal(isLinkedInUrl(good), true, good);
  for (const bad of ["javascript:alert(1)", "http://www.linkedin.com/in/a", "https://evil-linkedin.com/in/a", "https://linkedin.com.evil.com/in/a", "https://user:pw@linkedin.com/in/a", "https://notlinkedin.com", "linkedin.com/in/a", "", "data:text/html,x", "https://linkedin.co/in/a"]) assert.equal(isLinkedInUrl(bad), false, bad);
});

test("a patch changes only what it names; blank clears an optional field; a name can't be cleared; empty patch is refused", () => {
  assert.deepEqual(parseContactPatch({ title: "" }), { title: null });
  assert.deepEqual(parseContactPatch({ company: null, followUpOn: "" }), { company: null, followUpOn: null });
  assert.deepEqual(parseContactPatch({ notes: null }), { notes: "" });
  assert.deepEqual(parseContactPatch({ relationship: "recruiter", name: "B" }), { relationship: "recruiter", name: "B" });
  assert.deepEqual(issues(() => parseContactPatch({ name: "" })), ["name"]);
  assert.deepEqual(issues(() => parseContactPatch({})), ["(body)"]);
});

test("query: search text, company, relationship and 'due'; anything malformed is an error", () => {
  assert.deepEqual(parseContactQuery({ q: " priya ", company: "7", relationship: "alumni", due: "1" }, "2026-11-05"), { q: "priya", companyId: 7, relationship: "alumni", dueBy: "2026-11-05" });
  assert.deepEqual(parseContactQuery({}, "2026-11-05"), {});
  assert.deepEqual(parseContactQuery({ due: "0" }, "2026-11-05"), {});
  assert.deepEqual(issues(() => parseContactQuery({ company: "abc" }, "2026-11-05")), ["company"]);
  assert.deepEqual(issues(() => parseContactQuery({ relationship: "boss" }, "2026-11-05")), ["relationship"]);
});

test("a link needs an application id and a known role (default 'other')", () => {
  assert.deepEqual(parseLink({ applicationId: 4 }), { applicationId: 4, role: "other" });
  assert.deepEqual(parseLink({ applicationId: 4, role: "referrer" }), { applicationId: 4, role: "referrer" });
  assert.deepEqual(issues(() => parseLink({})), ["applicationId"]);
  assert.deepEqual(issues(() => parseLink({ applicationId: "4" })), ["applicationId"]);
  assert.deepEqual(issues(() => parseLink({ applicationId: 4, role: "boss" })), ["role"]);
  assert.deepEqual(issues(() => parseLink({ applicationId: 4, extra: 1 })), ["extra"]);
});

test("an event needs a kind; the date defaults to today; a note is optional and bounded", () => {
  assert.deepEqual(parseEvent({ kind: "messaged" }, "2026-11-05"), { kind: "messaged", on: "2026-11-05", note: null });
  assert.deepEqual(parseEvent({ kind: "call", on: "2026-11-01", note: " 15 min " }, "2026-11-05"), { kind: "call", on: "2026-11-01", note: "15 min" });
  assert.deepEqual(issues(() => parseEvent({}, "2026-11-05")), ["kind"]);
  assert.deepEqual(issues(() => parseEvent({ kind: "yelled" }, "2026-11-05")), ["kind"]);
  assert.deepEqual(issues(() => parseEvent({ kind: "call", on: "2026-13-01" }, "2026-11-05")), ["on"]);
  assert.deepEqual(issues(() => parseEvent({ kind: "call", note: "x".repeat(1001) }, "2026-11-05")), ["note"]);
});

// ---- alumni helper ----
test("alumni links are plain search addresses, exactly formed", () => {
  const links = alumniLinks("Simon Fraser University", "Stripe");
  assert.deepEqual(links.map((l) => l.id), ["linkedin-alumni", "google-alumni", "linkedin-recruiters"]);
  assert.equal(links[0]!.url, "https://www.linkedin.com/search/results/people/?keywords=Simon%20Fraser%20University%20Stripe");
  assert.equal(links[1]!.url, "https://www.google.com/search?q=site%3Alinkedin.com%2Fin%20%22Simon%20Fraser%20University%22%20%22Stripe%22");
  assert.equal(links[2]!.url, "https://www.linkedin.com/search/results/people/?keywords=Stripe%20university%20recruiter");
  assert.equal(links[0]!.label, "Simon Fraser University alumni at Stripe on LinkedIn");
});

test("alumni links can't be hijacked by what is in a company name: quotes, ampersands, hashes and slashes are encoded or removed", () => {
  const [li, g] = alumniLinks("SFU", 'A&B "Co" #1 / x?y=z');
  for (const l of [li!, g!]) {
    const u = new URL(l.url);
    assert.equal(u.hostname === "www.linkedin.com" || u.hostname === "www.google.com", true);
    assert.equal(u.hash, "");                                    // a '#' in the name did not start a fragment
    assert.equal([...u.searchParams.keys()].length, 1);          // '&' and '=' in the name did not add parameters
  }
  assert.equal(new URL(li!.url).searchParams.get("keywords"), "SFU A&B Co #1 / x?y=z");
  assert.equal(new URL(g!.url).searchParams.get("q"), 'site:linkedin.com/in "SFU" "A&B Co #1 / x?y=z"'); // the stray quotes are gone, so the phrase stays closed
});

test("no company means no links; a blank school falls back to the default", () => {
  assert.deepEqual(alumniLinks("SFU", "   "), []);
  assert.deepEqual(alumniLinks("SFU", '""'), []);
  assert.match(alumniLinks("  ", "Stripe")[0]!.label, new RegExp(`^${DEFAULT_SCHOOL}`));
});

// ---- settings ----
test("settings: the school can be set, and blank or null puts the default back", () => {
  assert.equal(DEFAULT_SETTINGS.school, "Simon Fraser University");
  assert.deepEqual(parseSettingsPatch({ school: "  University   of   Waterloo " }), { school: "University of Waterloo" });
  assert.deepEqual(parseSettingsPatch({ school: "" }), { school: null });
  assert.deepEqual(parseSettingsPatch({ school: null }), { school: null });
  assert.deepEqual(issues(() => parseSettingsPatch({})), ["(body)"]);
  assert.deepEqual(issues(() => parseSettingsPatch({ school: 5 })), ["school"]);
  assert.deepEqual(issues(() => parseSettingsPatch({ school: "x".repeat(101) })), ["school"]);
  assert.deepEqual(issues(() => parseSettingsPatch({ theme: "dark" })), ["theme"]);
});
