// How your search is going, split by the things you can act on: which kind of role, which sector, where you
// found the posting, which resume you sent, and how long each stage takes. Numbers come from /api/breakdowns.
//
// With a small search, most rows are one or two applications. Every row shows its counts, and a row with
// fewer than the server's minimum sample is dimmed and labelled "few": a rate from 3 applications is a hint,
// not a finding, and a page that hides that would mislead you.

import { api } from "../lib/api.js";
import { h } from "../lib/dom.js";
import { ctx } from "../lib/ctx.js";
import { plural } from "../lib/format.js";
import { state } from "../lib/state.js";
import { emptyNote } from "../lib/ui.js";
import { panel } from "./parts.js";
import { toolbar } from "./toolbar.js";

const DIMENSIONS = [
  ["function", "By kind of role", "p-blue", "rows"],
  ["sector", "By sector", "p-butter", "grid"],
  ["source", "By where you found it", "p-salmon", "search"],
  ["resume", "By resume version", "", "star"],
];
const STAGE_NAMES = { saved: "Saved", drafting: "Drafting", applied: "Applied, waiting for a reply", assessment: "Assessment", interview: "Interview" };

const pct = (n, of) => (of ? `${Math.round((n / of) * 100)}%` : "–");

function table(rows, minSample, emptyText) {
  if (!rows.length) return h("div", { class: "card" }, emptyNote(emptyText));
  const head = h("div", { class: "ins-row ins-head" }, ...["", "Sent", "Replied", "Interviews", "Offers", "Ghosted"].map((t) => h("span", { text: t })));
  const body = rows.map((r) => {
    const few = r.sent < minSample;
    return h("div", { class: `ins-row${few ? " few" : ""}`, title: few ? `Only ${plural(r.sent, "application")}: too few to read much into` : undefined },
      h("b", { text: r.key }),
      h("span", { text: String(r.sent) }),
      h("span", {}, String(r.replied), h("small", { text: ` · ${pct(r.replied, r.sent)}` })),
      h("span", { text: String(r.interviews) }),
      h("span", { text: String(r.offers) }),
      h("span", { text: String(r.ghosted) }));
  });
  return h("div", { class: "card ins-table" }, head, ...body);
}

export async function insightsView() {
  const lists = await api.lists();
  if (state.insightsList !== "all" && !lists.some((l) => String(l.id) === state.insightsList)) state.insightsList = "all";
  const data = await api.breakdowns(state.insightsList);
  const { minSample, breakdowns, timeInStage } = data;

  const tabs = h("div", { class: "seg", role: "group", "aria-label": "List", "data-knob": "insights-list" });
  const tab = (name, id) => tabs.append(h("button", { type: "button", "aria-pressed": String(state.insightsList === id), onclick: () => { state.insightsList = id; ctx.refresh("swap"); }, text: name }));
  tab("All applications", "all");
  lists.forEach((l) => tab(l.name, String(l.id)));

  const sent = breakdowns.function.reduce((n, r) => n + r.sent, 0);
  const replied = breakdowns.function.reduce((n, r) => n + r.replied, 0);
  const small = replied < minSample || Object.values(breakdowns).some((rows) => rows.some((r) => r.sent < minSample));

  const view = h("div", {});
  view.append(h("div", { class: "head" }, h("div", {}, h("h1", { class: "title", text: "Insights" }), h("span", { class: "muted", text: "Where replies come from, and how long things take." })), toolbar()), tabs);

  if (!sent) {
    view.append(h("div", { class: "card" }, emptyNote("Nothing has been sent in this list yet, so there is nothing to compare.")));
    return view;
  }
  if (small) {
    view.append(h("p", { class: "caution", role: "note" },
      h("b", { text: `${plural(replied, "reply", "replies")} from ${plural(sent, "application")} so far. ` }),
      `Treat every rate below as a hint until a row has at least ${minSample} sent. Rows with fewer are dimmed and marked few.`));
  }

  const grid = h("div", { class: "stack" }); // one full-width column: the tables have six columns and long sector names
  for (const [key, title, cls, ic] of DIMENSIONS) {
    const rows = breakdowns[key];
    const onlyUnknown = rows.length > 0 && rows.every((r) => r.key === "Unknown");
    const hint = onlyUnknown && (key === "source" || key === "resume")
      ? h("p", { class: "panel-note", text: key === "source" ? "Nothing recorded yet. Fill in “Where you found it” in an application's detail panel and this fills in." : "Nothing recorded yet. Fill in “Resume version” in an application's detail panel to compare versions." })
      : null;
    grid.append(panel(cls, ic, title, rows.length || null, null, table(rows, minSample, "Nothing here yet."), hint));
  }
  // how long each stage takes
  const stages = h("div", { class: "card ins-table" }, h("div", { class: "ins-row stage-head" }, h("span", { text: "" }), h("span", { text: "Median days" }), h("span", { text: "From" })));
  for (const s of timeInStage) {
    stages.append(h("div", { class: `ins-row stage-row${s.samples < 3 ? " few" : ""}` },
      h("b", { text: STAGE_NAMES[s.stage] }), h("span", { text: s.median === null ? "–" : String(s.median) }), h("span", { text: plural(s.samples, "application") })));
  }
  grid.append(panel("p-blue", "rows", "How long each stage takes", null, null, stages,
    h("p", { class: "panel-note", text: "Days between entering a stage and the next recorded step. Moving to ghosted isn't counted: that date is when you gave up waiting, not something that happened to the application." })));
  view.append(grid);
  return view;
}
