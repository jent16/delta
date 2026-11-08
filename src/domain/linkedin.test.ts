import test from "node:test";
import assert from "node:assert/strict";
import { canonicalProfileUrl, cleanEmail, cleanName, connectionKey, guessRelationship, matchCompany, normalizeProfileUrl, parseCsv, parseConnectedOn, parseConnections, planConnections } from "./linkedin.ts";
import type { ConnectionRow, PlanContext } from "./linkedin.ts";

// ---------- CSV ----------
test("CSV: quoted fields, doubled quotes, commas and newlines inside quotes, CRLF, a byte-order mark, no trailing newline", () => {
  assert.deepEqual(parseCsv('a,b,c\n1,2,3\n'), [["a", "b", "c"], ["1", "2", "3"]]);
  assert.deepEqual(parseCsv('a,b\r\n"x, y","he said ""hi"""\r\n'), [["a", "b"], ["x, y", 'he said "hi"']]);
  assert.deepEqual(parseCsv('a,b\n"line1\nline2",z'), [["a", "b"], ["line1\nline2", "z"]]);
  assert.deepEqual(parseCsv("﻿a,b\n1,2"), [["a", "b"], ["1", "2"]]);
  assert.deepEqual(parseCsv("a,,c\n,,\n1,,3"), [["a", "", "c"], ["1", "", "3"]]); // empty cells kept; an all-empty row dropped
  assert.deepEqual(parseCsv(""), []);
  assert.deepEqual(parseCsv('a,b\n"unterminated,x'), [["a", "b"], ["unterminated,x"]]); // never throws on broken input
});

const FILE = (lines: string[]) => lines.join("\n");
const HEADER = "First Name,Last Name,URL,Email Address,Company,Position,Connected On";

test("the header is FOUND, so the note lines LinkedIn sometimes puts above it don't break the import", () => {
  const p = parseConnections(FILE(["Notes:", '"When exporting your connection data, you may notice that some email addresses are missing."', "", HEADER, "Priya,Shah,https://www.linkedin.com/in/priya,,Stripe,Engineer,05 Nov 2026"]));
  assert.equal(p.headerFound, true);
  assert.deepEqual(p.rows.map((r) => [r.firstName, r.lastName, r.company, r.position, r.url]), [["Priya", "Shah", "Stripe", "Engineer", "https://www.linkedin.com/in/priya"]]);
});

test("columns are located by NAME: a reordered or extended file works, and a missing column is just empty", () => {
  const p = parseConnections("Company,Last Name,Extra,First Name\nStripe,Shah,x,Priya");
  assert.deepEqual([p.rows[0]!.firstName, p.rows[0]!.lastName, p.rows[0]!.company, p.rows[0]!.url, p.rows[0]!.email], ["Priya", "Shah", "Stripe", "", ""]);
});

test("a file with no header is reported as such, not read as garbage", () => {
  assert.deepEqual(parseConnections("a,b\n1,2"), { rows: [], headerFound: false, unreadable: [] });
  assert.deepEqual(parseConnections(""), { rows: [], headerFound: false, unreadable: [] });
});

test("rows with too few columns are unreadable; short rows with enough are kept with empty cells", () => {
  const p = parseConnections(FILE([HEADER, "Solo", "Priya,Shah"]));
  assert.equal(p.unreadable.length, 1);
  assert.deepEqual(p.rows.map((r) => r.firstName), ["Priya"]);
});

// ---------- cleaning ----------
test("names: pronouns, emoji and trailing credentials go; unknown suffixes are kept as written", () => {
  assert.equal(cleanName("Priya", "Shah"), "Priya Shah");
  assert.equal(cleanName("Priya", "Shah (she/her)"), "Priya Shah");
  assert.equal(cleanName("Priya 🚀", "Shah"), "Priya Shah");
  assert.equal(cleanName("Jo", "Lee, CFA"), "Jo Lee");
  assert.equal(cleanName("Jo", "Lee, MBA, CFA"), "Jo Lee");
  assert.equal(cleanName("Jo", "Lee, P.Eng."), "Jo Lee");
  assert.equal(cleanName("Sam", "Smith, Jr."), "Sam Smith, Jr."); // not a credential we know
  assert.equal(cleanName("Cher", ""), "Cher");
  assert.equal(cleanName("  ", " "), "");
  assert.equal(cleanName("A", "B, Software Engineer"), "A B, Software Engineer"); // a comma followed by words is not a credential
});

test("profile links: every spelling of the same profile gives one key; anything that isn't a LinkedIn profile gives none", () => {
  for (const u of ["https://www.linkedin.com/in/Priya-Shah", "https://linkedin.com/in/priya-shah/", "https://ca.linkedin.com/in/priya-shah?trk=x#y", "https://www.linkedin.com/in/priya%2Dshah"]) assert.equal(normalizeProfileUrl(u), "linkedin.com/in/priya-shah", u);
  for (const u of ["", "javascript:alert(1)", "http://www.linkedin.com/in/a", "https://evil.com/in/a", "https://www.linkedin.com/company/stripe", "https://www.linkedin.com/in/", "not a url"]) assert.equal(normalizeProfileUrl(u), null, u);
  assert.equal(canonicalProfileUrl("https://ca.linkedin.com/in/Priya/?x=1"), "https://www.linkedin.com/in/priya");
  assert.equal(canonicalProfileUrl("javascript:alert(1)"), null);
});

test("emails: only a plausible address is kept", () => {
  assert.equal(cleanEmail(" a@b.co "), "a@b.co");
  for (const bad of ["", "nope", "a@b", "a b@c.d"]) assert.equal(cleanEmail(bad), null);
});

test("'Connected On': LinkedIn's '05 Nov 2026', ISO dates; anything else is simply unknown", () => {
  assert.equal(parseConnectedOn("05 Nov 2026"), "2026-11-05");
  assert.equal(parseConnectedOn("5 Nov 2026"), "2026-11-05");
  assert.equal(parseConnectedOn("11 September 2021"), "2021-09-11");
  assert.equal(parseConnectedOn("2026-11-05"), "2026-11-05");
  for (const bad of ["", "yesterday", "31 Feb 2026", "05 Foo 2026", "11/05/2026"]) assert.equal(parseConnectedOn(bad), null, bad);
});

test("a recruiter title is a guess; nothing else is guessed (the export has no school, so never 'alumni')", () => {
  for (const p of ["University Recruiter", "Technical Recruiter", "Talent Acquisition Partner", "Campus Recruiting Lead", "Early Careers Programs", "Sourcer"]) assert.deepEqual(guessRelationship(p), { relationship: "recruiter", guessed: true }, p);
  for (const p of ["Software Engineer", "Recruiting Coordinator Intern".replace("Recruiting", "Recruit"), ""].slice(0, 1).concat(["", "Engineer"])) assert.deepEqual(guessRelationship(p), { relationship: "other", guessed: false }, p);
});

test("the person key: profile link first, then email, then name and company; a case change does not make a new person", () => {
  const k = (url: string, email: string, name: string, company: string) => connectionKey({ url, email, name, company });
  assert.equal(k("https://www.linkedin.com/in/Priya", "p@x.com", "Priya Shah", "Stripe"), "url:linkedin.com/in/priya");
  assert.equal(k("", "P@X.com", "Priya Shah", "Stripe"), "email:p@x.com");
  assert.equal(k("bad", "nope", "Priya  Shah", " STRIPE "), "name:priya shah|stripe");
  assert.equal(k("", "", "Priya Shah", "Stripe"), k("", "", "priya shah", "stripe"));
});

// ---------- company matching ----------
const own = (...names: string[]) => names.map((name, i) => ({ id: i + 1, name }));
const COMPANIES = own("Stripe", "Jane Street", "Amazon", "Coinbase", "Shopify", "American Express");

test("exact: ignoring case and spacing; normalized: ignoring Inc., LLC, punctuation. Both link automatically", () => {
  assert.deepEqual(matchCompany("  STRIPE ", COMPANIES), { tier: "exact", company: COMPANIES[0] });
  assert.equal(matchCompany("Stripe, Inc.", COMPANIES).tier, "normalized");
  assert.equal(matchCompany("Stripe Inc", COMPANIES).company?.name, "Stripe");
  assert.equal(matchCompany("Jane Street Capital, LLC", own("Jane Street Capital")).tier, "normalized");
  assert.equal(matchCompany("Coinbase 🚀", COMPANIES).tier, "exact"); // emoji in the profile's company text
});

test("similar: aliases, a longer name that starts with yours, near-miss spellings. NEVER automatic", () => {
  const alias = matchCompany("Amazon Web Services", COMPANIES);
  assert.deepEqual([alias.tier, alias.candidates?.map((c) => c.name)], ["similar", ["Amazon"]]);
  assert.equal(matchCompany("AWS", COMPANIES).candidates?.[0]?.name, "Amazon");
  const sub = matchCompany("Stripe Payments Europe", COMPANIES);
  assert.deepEqual([sub.tier, sub.candidates?.map((c) => c.name)], ["similar", ["Stripe"]]);
  const typo = matchCompany("Shopfy", COMPANIES);
  assert.deepEqual([typo.tier, typo.candidates?.map((c) => c.name)], ["similar", ["Shopify"]]);
  assert.equal(matchCompany("Coinbse", COMPANIES).tier, "similar");
  assert.equal(matchCompany("Stripe", own("Stripe Payments")).tier, "similar");   // THEIR text is the start of YOUR name
});

test("no match: other companies, empty text, and short or different words that merely look alike", () => {
  assert.deepEqual(matchCompany("Some Random Startup", COMPANIES), { tier: "none" });
  assert.deepEqual(matchCompany("", COMPANIES), { tier: "none" });
  assert.deepEqual(matchCompany("   ", COMPANIES), { tier: "none" });
  assert.deepEqual(matchCompany("🚀", COMPANIES), { tier: "none" });
  assert.deepEqual(matchCompany("Blok", own("Block")), { tier: "none" });         // under 5 letters: too short to guess at
  assert.equal(matchCompany("Block", own("Black")).tier, "similar");              // one letter off IS offered, but only ever as a question
  assert.deepEqual(matchCompany("Moog", own("Goog")), { tier: "none" });          // different first letter
  assert.deepEqual(matchCompany("Stripes Laundry", own("Stripe")), { tier: "none" }); // not a whole-word start ("stripes" is not "stripe ")
});

test("two of your companies that normalize alike are never guessed between: the user chooses", () => {
  const m = matchCompany("Stripe", own("Stripe Inc", "Stripe LLC"));
  assert.deepEqual([m.tier, m.candidates?.map((c) => c.name)], ["similar", ["Stripe Inc", "Stripe LLC"]]);
  assert.equal(matchCompany("Stripe Inc", own("Stripe Inc", "Stripe LLC")).tier, "exact"); // but an exact spelling wins
});

test("candidates are ranked: alias, then 'starts with', then closest spelling; at most three", () => {
  const m = matchCompany("Amazon Web Services", own("Amazon", "Amazon Web Services Training", "Amazan", "Amazone"));
  assert.equal(m.tier, "similar");
  assert.equal(m.candidates![0]!.name, "Amazon");
  assert.ok(m.candidates!.length <= 3);
});

// ---------- the plan ----------
const row = (o: Partial<ConnectionRow> & { firstName: string; lastName: string }): ConnectionRow => ({ line: 2, url: "", email: "", company: "", position: "", connectedOn: "", ...o });
const ctx = (o: Partial<PlanContext> = {}): PlanContext => ({ companies: COMPANIES, known: new Map(), existing: [], accept: {}, ...o });
const act = (rows: ConnectionRow[], c = ctx()) => planConnections(rows, c).map((p) => p.action);

test("a connection at a company you have is added; elsewhere it is skipped and counted; no company and no name are said so", () => {
  assert.deepEqual(act([
    row({ firstName: "A", lastName: "One", company: "Stripe" }),
    row({ firstName: "B", lastName: "Two", company: "Totally Unknown Co" }),
    row({ firstName: "C", lastName: "Three", company: "" }),
    row({ firstName: "", lastName: "", company: "Stripe" }),
  ]), ["create", "untracked", "no_company", "invalid"]);
});

test("a created row carries everything the new contact needs: your company's spelling, a clean profile link, and notes of how it was found", () => {
  const [p] = planConnections([row({ firstName: "Priya", lastName: "Shah (she/her)", url: "https://CA.linkedin.com/in/Priya/?x=1", email: "p@x.com", company: "stripe, inc.", position: "University Recruiter", connectedOn: "05 Nov 2026" })], ctx());
  assert.deepEqual([p!.action, p!.name, p!.addTo?.name, p!.match.tier, p!.linkedinUrl, p!.email, p!.connectedOn, p!.relationship, p!.relationshipGuessed],
    ["create", "Priya Shah", "Stripe", "normalized", "https://www.linkedin.com/in/priya", "p@x.com", "2026-11-05", "recruiter", true]);
});

test("a 'similar' company waits for you; confirming one of the OFFERED candidates adds it; any other id is ignored", () => {
  const r = row({ firstName: "A", lastName: "One", company: "Amazon Web Services", url: "https://www.linkedin.com/in/a" });
  const [pending] = planConnections([r], ctx());
  assert.equal(pending!.action, "needs_confirmation");
  assert.match(pending!.reason!, /Amazon/);
  const amazon = COMPANIES.find((c) => c.name === "Amazon")!;
  const [ok] = planConnections([r], ctx({ accept: { [pending!.key]: amazon.id } }));
  assert.deepEqual([ok!.action, ok!.addTo?.name], ["create", "Amazon"]);
  const stripe = COMPANIES.find((c) => c.name === "Stripe")!;
  assert.equal(planConnections([r], ctx({ accept: { [pending!.key]: stripe.id } }))[0]!.action, "needs_confirmation"); // Stripe was never offered for this row
  assert.equal(planConnections([r], ctx({ accept: { [pending!.key]: 9999 } }))[0]!.action, "needs_confirmation");
});

test("people imported before are skipped, even if you deleted them since (deleting is a choice)", () => {
  const r = row({ firstName: "A", lastName: "One", company: "Stripe", url: "https://www.linkedin.com/in/a" });
  const key = planConnections([r], ctx())[0]!.key;
  const [here] = planConnections([r], ctx({ known: new Map([[key, 7]]) }));
  assert.deepEqual([here!.action, here!.reason], ["already_imported", "imported before"]);
  const [gone] = planConnections([r], ctx({ known: new Map([[key, null]]) }));
  assert.deepEqual([gone!.action, gone!.reason], ["already_imported", "imported before, then deleted by you"]);
});

test("someone you already have in People is skipped: by profile link (any spelling) or by name and company", () => {
  const byUrl = row({ firstName: "Priya", lastName: "Shah", company: "Stripe", url: "https://www.linkedin.com/in/priya" });
  assert.equal(act([byUrl], ctx({ existing: [{ name: "P. Shah", company: "Elsewhere", linkedinUrl: "https://ca.linkedin.com/in/Priya/" }] }))[0], "already_in_people");
  const byName = row({ firstName: "Priya", lastName: "Shah", company: "Stripe" });
  assert.equal(act([byName], ctx({ existing: [{ name: "priya  shah", company: "STRIPE", linkedinUrl: null }] }))[0], "already_in_people");
  assert.equal(act([byName], ctx({ existing: [{ name: "Priya Shah", company: "Figma", linkedinUrl: null }] }))[0], "create"); // same name, different company: a different person
});

test("the same person twice in the file: the first counts, the second says so", () => {
  const a = row({ firstName: "A", lastName: "One", company: "Stripe", url: "https://www.linkedin.com/in/a" });
  assert.deepEqual(act([a, { ...a, line: 3 }, row({ firstName: "B", lastName: "Two", company: "Stripe", url: "https://www.linkedin.com/in/b" })]), ["create", "duplicate_in_file", "create"]);
});

test("rows are planned independently: one bad row never changes another's outcome, and the order is preserved", () => {
  const rows = [row({ firstName: "", lastName: "" }), row({ firstName: "A", lastName: "One", company: "Stripe" }), row({ firstName: "B", lastName: "Two", company: "Nope" })];
  assert.deepEqual(planConnections(rows, ctx()).map((p) => [p.name, p.action]), [["", "invalid"], ["A One", "create"], ["B Two", "untracked"]]);
});

test("CSV: old-style carriage-return-only line endings still split rows", () => {
  assert.deepEqual(parseCsv("a,b\r1,2\r3,4"), [["a", "b"], ["1", "2"], ["3", "4"]]);
});

test("a header needs BOTH first and last name: a file with only one of them is not a Connections file", () => {
  assert.equal(parseConnections("First Name,Company\nA,X").headerFound, false);
  assert.equal(parseConnections("Last Name,Company\nA,X").headerFound, false);
});

test("a short company name of yours (under 4 letters) is never matched as the start of a longer one", () => {
  assert.deepEqual(matchCompany("Sky Digital Group", own("Sky")), { tier: "none" });
  assert.deepEqual(matchCompany("Box Office Pizza", own("Box")), { tier: "none" });
  assert.equal(matchCompany("Skye Digital Group", own("Skye")).tier, "similar"); // four letters is enough
});

test("at most three candidates are offered, however many of your companies look similar", () => {
  const m = matchCompany("Coinbase", own("Coinbas", "Coinbasee", "Coinbasr", "Coinbaze", "Coinbasx"));
  assert.equal(m.tier, "similar");
  assert.equal(m.candidates!.length, 3);
});
