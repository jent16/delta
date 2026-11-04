// The Notion adapter: the only code that knows Notion's wire format. It turns
// a database's pages into flat SourceRows and nothing else — what a row MEANS
// is decided in domain/import.ts, so a CSV importer later reuses all of it.
//
// The HTTP client is injected (`fetchImpl`) so tests feed it canned responses;
// the token is a plain argument, never read from the environment in here.

import { SourceError, ValidationError } from "../domain/errors.ts";
import type { RowSource, SourceRow } from "../domain/import.ts";

const NOTION_VERSION = "2022-06-28";

/** Accepts a database link (with or without ?v=...) or a bare id, with or without dashes. */
export function parseDatabaseId(input: string): string {
  const match = input.replace(/-/g, "").match(/[0-9a-f]{32}/i);
  if (!match) throw new ValidationError([{ field: "database", message: "does not contain a Notion database id (32 hex characters)" }]);
  return match[0].toLowerCase();
}

interface NotionText { plain_text: string }
// Notion property values, only as far as flattening needs them.
type Prop = Record<string, unknown> & { type: string };

const text = (parts: unknown): string => (Array.isArray(parts) ? (parts as NotionText[]).map((t) => t.plain_text).join("") : "");

function flatten(p: Prop): string {
  switch (p.type) {
    case "title": return text(p.title);
    case "rich_text": return text(p.rich_text);
    case "select": return (p.select as { name: string } | null)?.name ?? "";
    case "status": return (p.status as { name: string } | null)?.name ?? "";
    case "multi_select": return ((p.multi_select as { name: string }[]) ?? []).map((o) => o.name).join(", ");
    case "date": return ((p.date as { start: string } | null)?.start ?? "").slice(0, 10); // drop any time-of-day
    case "url": return (p.url as string | null) ?? "";
    case "email": return (p.email as string | null) ?? "";
    case "phone_number": return (p.phone_number as string | null) ?? "";
    case "number": return p.number === null || p.number === undefined ? "" : String(p.number);
    case "checkbox": return p.checkbox ? "true" : "";
    default: return ""; // relations, rollups, files...: nothing the tracker maps
  }
}

interface Page {
  id: string;
  archived?: boolean;
  in_trash?: boolean;
  created_time?: string;
  last_edited_time?: string;
  properties: Record<string, Prop>;
}

export function createNotionSource(opts: { token: string | undefined; database: string; fetchImpl?: typeof fetch; baseUrl?: string }): RowSource {
  const databaseId = parseDatabaseId(opts.database);
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl ?? "https://api.notion.com";

  return {
    id: `notion:${databaseId}`,

    async fetchRows() {
      if (!opts.token) throw new SourceError("NOTION_TOKEN is not set (see the Notion section of the README)");
      const pages: Page[] = [];
      let cursor: string | undefined;
      do {
        const res = await doFetch(`${base}/v1/databases/${databaseId}/query`, {
          method: "POST",
          headers: { Authorization: `Bearer ${opts.token}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
          body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
        });
        const body = (await res.json().catch(() => ({}))) as { results?: Page[]; has_more?: boolean; next_cursor?: string; message?: string; code?: string };
        if (!res.ok) {
          const hint = res.status === 404 ? " — is the database shared with your Notion integration (••• menu → Connections)?" : "";
          throw new SourceError(`Notion refused the request (${res.status} ${body.code ?? ""}): ${body.message ?? "no details"}${hint}`);
        }
        pages.push(...(body.results ?? []));
        cursor = body.has_more ? body.next_cursor : undefined;
      } while (cursor);

      return pages
        .filter((pg) => !pg.archived && !pg.in_trash) // rows you deleted in Notion stay deleted
        .map((pg): SourceRow => {
          const fields: Record<string, string> = {};
          for (const [name, prop] of Object.entries(pg.properties)) {
            fields[name] = flatten(prop);
            if (prop.type === "title") fields["(title)"] = fields[name]!;
          }
          return { externalId: pg.id, fields, createdOn: pg.created_time?.slice(0, 10) ?? null, editedOn: pg.last_edited_time?.slice(0, 10) ?? null };
        });
    },
  };
}
