const test = require("node:test");
const assert = require("node:assert/strict");
const { buildProperties, parseDatabaseId } = require("../lib/notion");

const LISTING = {
  title: "Software Engineer Intern", company: "Snowflake", terms: ["Spring 2027", "Summer 2027"],
  locations: ["Menlo Park, CA", "Bellevue, WA"], url: "https://example.com/j", datePosted: "2026-09-24T10:00:00Z",
  degrees: ["Bachelor's", "Master's"], sponsorship: "Offers Sponsorship", category: "Software Engineering",
};
const statusSelect = (...names) => ({ type: "select", select: { options: names.map((name) => ({ name })) } });

// the real tracker's shape (found by reading the live "swe tracker" database)
const REAL_TRACKER = {
  Link: { type: "url" }, Location: { type: "rich_text" }, Opens: { type: "date" }, Applied: { type: "date" },
  Notes: { type: "rich_text" }, Status: statusSelect("Bookmarked", "Applied", "In process", "x"),
  "Role/Program": { type: "rich_text" }, Company: { type: "title" },
};
const val = (p) => p.title?.[0].text.content ?? p.rich_text?.[0].text.content ?? p.url ?? p.date?.start ?? p.select?.name ?? p.status?.name;

test("parseDatabaseId: URL, dashed uuid, bare id, garbage", () => {
  const id = "0123456789abcdef0123456789abcdef";
  assert.equal(parseDatabaseId(`https://www.notion.so/ws/My-Tracker-${id}?v=abc`), id);
  assert.equal(parseDatabaseId("01234567-89ab-cdef-0123-456789abcdef"), id);
  assert.equal(parseDatabaseId(id), id);
  assert.equal(parseDatabaseId("not a database"), null);
  assert.equal(parseDatabaseId(""), null);
});

test("buildProperties: real tracker — company in the title column, role in Role/Program", () => {
  const { properties, skipped } = buildProperties(REAL_TRACKER, LISTING);
  assert.equal(val(properties.Company), "Snowflake");
  assert.equal(val(properties["Role/Program"]), "Software Engineer Intern");
  assert.equal(val(properties.Opens), "2026-09-24");
  assert.equal(val(properties.Location), "Menlo Park, CA · Bellevue, WA");
  assert.equal(val(properties.Link), "https://example.com/j");
  assert.deepEqual(skipped.sort(), ["Applied", "Notes"]); // left for the user
});

test("buildProperties: a new row never claims to be Applied", () => {
  const { properties } = buildProperties(REAL_TRACKER, LISTING);
  assert.equal(val(properties.Status), "Bookmarked");
  assert.equal(properties.Applied, undefined);
});

test("buildProperties: status is only set to an option the user already has", () => {
  const onlyApplied = { ...REAL_TRACKER, Status: statusSelect("Applied", "Rejected") };
  assert.equal(buildProperties(onlyApplied, LISTING).properties.Status, undefined);
  const nativeStatus = { ...REAL_TRACKER, Status: { type: "status", status: { options: [{ name: "Not started" }, { name: "Done" }] } } };
  assert.deepEqual(buildProperties(nativeStatus, LISTING).properties.Status, { status: { name: "Not started" } });
});

test("buildProperties: title column is the role -> 'Title' stays the role, company column filled", () => {
  const schema = { Name: { type: "title" }, Company: { type: "rich_text" } };
  const { properties } = buildProperties(schema, LISTING);
  assert.equal(val(properties.Name), "Software Engineer Intern");
  assert.equal(val(properties.Company), "Snowflake");
});

test("buildProperties: no company column -> combines title and company in the title", () => {
  const { properties } = buildProperties({ Name: { type: "title" } }, LISTING);
  assert.equal(val(properties.Name), "Software Engineer Intern — Snowflake");
});

test("buildProperties: select/multi_select values are sanitized (commas break Notion options)", () => {
  const schema = { Name: { type: "title" }, Term: { type: "multi_select" }, Type: { type: "select" } };
  const { properties } = buildProperties(schema, { ...LISTING, category: "Data, AI & ML" });
  assert.deepEqual(properties.Term.multi_select.map((o) => o.name), ["Spring 2027", "Summer 2027"]);
  assert.equal(properties.Type.select.name, "Data AI & ML");
});

test("buildProperties: property names match case-insensitively; unknown types are never written", () => {
  const schema = { NAME: { type: "title" }, "date posted": { type: "date" }, Location: { type: "people" } };
  const { properties } = buildProperties(schema, LISTING);
  assert.equal(val(properties["date posted"]), "2026-09-24");
  assert.equal(properties.Location, undefined);
});

test("buildProperties: a database without a title property is an error, not a crash later", () => {
  assert.throws(() => buildProperties({ Link: { type: "url" } }, LISTING), /no title property/);
});
