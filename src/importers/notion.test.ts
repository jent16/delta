import test from "node:test";
import assert from "node:assert/strict";
import { SourceError, ValidationError } from "../domain/errors.ts";
import { createNotionSource, parseDatabaseId } from "./notion.ts";

const ID = "3d49313a165e8039b400ca1c947f0865";
const rt = (s: string) => [{ plain_text: s }];
const page = (id: string, props: Record<string, unknown>, extra: object = {}) => ({
  id, created_time: "2026-09-01T10:00:00.000Z", last_edited_time: "2026-09-20T18:30:00.000Z", properties: props, ...extra,
});
const sample = page("page-1", {
  Company: { type: "title", title: rt("Stripe") },
  "Role/Program": { type: "rich_text", rich_text: [{ plain_text: "SWE " }, { plain_text: "Intern" }] },
  Status: { type: "select", select: { name: "Applied" } },
  Applied: { type: "date", date: { start: "2026-09-05T09:00:00.000-04:00", end: null } },
  Link: { type: "url", url: null },
  Stage: { type: "status", status: { name: "Open" } },
  Tags: { type: "multi_select", multi_select: [{ name: "a" }, { name: "b" }] },
  Rel: { type: "relation", relation: [] },
});

type Call = { url: string; init: RequestInit };
function fakeFetch(responses: { status?: number; body: unknown }[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses[calls.length - 1] ?? responses[responses.length - 1]!;
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

test("parseDatabaseId: link, link with view id, dashed id, bare id; garbage is refused", () => {
  assert.equal(parseDatabaseId(ID), ID);
  assert.equal(parseDatabaseId(`https://www.notion.so/me/${ID}?v=0123456789abcdef0123456789abcdef`), ID);
  assert.equal(parseDatabaseId("3D49313A-165E-8039-B400-CA1C947F0865"), ID);
  assert.throws(() => parseDatabaseId("https://example.com/nope"), ValidationError);
});

test("rows are flattened: every property type becomes text, dates lose the time, and the title is also exposed as (title)", async () => {
  const { fetchImpl } = fakeFetch([{ body: { results: [sample], has_more: false } }]);
  const [r] = await createNotionSource({ token: "t", database: ID, fetchImpl }).fetchRows();
  assert.deepEqual(r!.fields, {
    Company: "Stripe", "(title)": "Stripe", "Role/Program": "SWE Intern", Status: "Applied", Applied: "2026-09-05",
    Link: "", Stage: "Open", Tags: "a, b", Rel: "",
  });
  assert.deepEqual([r!.externalId, r!.createdOn, r!.editedOn], ["page-1", "2026-09-01", "2026-09-20"]);
});

test("it follows pagination until Notion says there is no more", async () => {
  const { fetchImpl, calls } = fakeFetch([
    { body: { results: [sample], has_more: true, next_cursor: "CUR" } },
    { body: { results: [{ ...sample, id: "page-2" }], has_more: false } },
  ]);
  const rows = await createNotionSource({ token: "t", database: ID, fetchImpl }).fetchRows();
  assert.deepEqual(rows.map((r) => r.externalId), ["page-1", "page-2"]);
  assert.equal(JSON.parse(calls[1]!.init.body as string).start_cursor, "CUR");
  assert.equal(JSON.parse(calls[0]!.init.body as string).start_cursor, undefined);
});

test("rows deleted or archived in Notion are not imported", async () => {
  const { fetchImpl } = fakeFetch([{ body: { results: [sample, { ...sample, id: "gone", archived: true }, { ...sample, id: "trash", in_trash: true }], has_more: false } }]);
  assert.deepEqual((await createNotionSource({ token: "t", database: ID, fetchImpl }).fetchRows()).map((r) => r.externalId), ["page-1"]);
});

test("the source id names the database, so different trackers have separate ledgers", () => {
  assert.equal(createNotionSource({ token: "t", database: `https://notion.so/${ID}` }).id, `notion:${ID}`);
});

test("errors are readable and never contain the token", async () => {
  const secret = "secret_TOKEN_123";
  const notFound = fakeFetch([{ status: 404, body: { code: "object_not_found", message: "Could not find database" } }]);
  await assert.rejects(
    createNotionSource({ token: secret, database: ID, fetchImpl: notFound.fetchImpl }).fetchRows(),
    (e) => e instanceof SourceError && /shared with your Notion integration/.test(e.message) && !e.message.includes(secret),
  );
  const noToken = createNotionSource({ token: undefined, database: ID, fetchImpl: notFound.fetchImpl });
  await assert.rejects(noToken.fetchRows(), /NOTION_TOKEN is not set/);
  assert.equal(notFound.calls.length, 1); // with no token it didn't even try
});

test("the token is sent as a bearer header and nowhere else", async () => {
  const { fetchImpl, calls } = fakeFetch([{ body: { results: [], has_more: false } }]);
  await createNotionSource({ token: "tok", database: ID, fetchImpl, baseUrl: "http://mock" }).fetchRows();
  assert.equal(calls[0]!.url, `http://mock/v1/databases/${ID}/query`);
  assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, "Bearer tok");
  assert.ok(!calls[0]!.url.includes("tok") && !String(calls[0]!.init.body).includes("tok"));
});
