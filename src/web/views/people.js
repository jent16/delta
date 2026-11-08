// People: everyone you know at the companies you apply to. Search, filter by how you know them or who is due a
// follow-up, add someone, and open a person to log what you did, link them to applications, or find alumni.

import { api, describeError } from "../lib/api.js";
import { clear, h, icon } from "../lib/dom.js";
import { ctx } from "../lib/ctx.js";
import { ago, plural, shortDate, today } from "../lib/format.js";
import { label, state, vocab } from "../lib/state.js";
import { emptyNote, logo, toast } from "../lib/ui.js";
import { table, toolbar } from "./toolbar.js";

let rows = [];
let filter = "all"; // all | due | a relationship
let gridEl = null, chipsEl = null, countEl = null;

const visibleBase = () => {
  const q = state.query.trim().toLowerCase();
  return rows.filter((p) => !q || `${p.name} ${p.company ?? ""} ${p.title ?? ""}`.toLowerCase().includes(q));
};
const due = (p, now) => p.followUpOn !== null && p.followUpOn <= now;

export async function peopleView() {
  rows = await api.contacts();
  const settings = await api.settings();
  countEl = h("span", { class: "muted" });
  chipsEl = h("div", { class: "chips", role: "group", "aria-label": "Filter" });
  gridEl = h("table", { class: "grid people-grid" });
  table.rerender = renderTable;
  table.view = "people";
  renderTable();

  const school = h("input", { class: "inline-input school", type: "text", value: settings.school, "aria-label": "School for the alumni search", maxlength: "100" });
  school.addEventListener("change", async () => {
    try { const s = await api.editSettings({ school: school.value }); school.value = s.school; toast(`Alumni searches will look for ${s.school}`); }
    catch (e) { school.value = settings.school; toast(describeError(e), true); }
  });

  return h("div", {},
    h("div", { class: "head" }, h("div", {}, h("h1", { class: "title", text: "People" }), countEl), toolbar()),
    h("p", { class: "note-line", text: "Recruiters, alumni and referrers. Link them to applications, log what you did, and find alumni at a company. This stays in your own database." }),
    h("div", { class: "chips-row" }, chipsEl, h("button", { class: "btn primary", type: "button", onclick: () => ctx.openNewPerson() }, icon("plus", 15), "Add person")),
    h("div", { class: "tablewrap" }, gridEl),
    h("div", { class: "settings-line" }, h("label", { for: "school", text: "School for the alumni search" }), (school.id = "school", school)));
}

function renderTable() {
  const now = today();
  const base = visibleBase();
  const filters = [["all", "All", () => true], ["due", "Follow up due", (p) => due(p, now)], ...vocab.relationships.map((r) => [r, label(r), (p) => p.relationship === r])];
  clear(chipsEl);
  for (const [key, name, test] of filters) {
    const n = base.filter(test).length;
    if (key !== "all" && key !== "due" && n === 0 && filter !== key) continue; // hide relationships nobody has
    chipsEl.append(h("button", { class: "fchip", type: "button", "aria-pressed": String(filter === key), onclick: () => { filter = key; renderTable(); } }, name, h("span", { class: "n", text: String(n) })));
  }
  const test = filters.find((f) => f[0] === filter)?.[2] ?? (() => true);
  const shown = base.filter(test);
  countEl.textContent = plural(shown.length, "person", "people");

  clear(gridEl).append(h("thead", {}, h("tr", {}, ...["Name", "Company", "How you know them", "Last contact", "Follow up", "Applications"].map((n) => h("th", {}, h("span", { class: "th-plain", text: n }))))));
  const body = h("tbody", {});
  for (const p of shown) {
    const overdue = due(p, now);
    body.append(h("tr", { "data-person-id": String(p.id), onclick: (e) => ctx.openPerson(p.id, e.currentTarget) },
      h("td", {}, h("div", { class: "cell-co" }, logo(p.name), h("button", { class: "cell-link", type: "button", text: p.name, onclick: (e) => { e.stopPropagation(); ctx.openPerson(p.id, e.currentTarget); } }),
        p.title ? h("span", { class: "dim small", text: p.title }) : null)),
      h("td", { class: "dim", text: p.company ?? "–" }),
      h("td", {}, h("span", { class: "mini", text: label(p.relationship) })),
      h("td", { class: "date", text: p.lastEventOn ? ago(p.lastEventOn, now) : "–" }),
      h("td", { class: `date${overdue ? " overdue" : ""}`, text: p.followUpOn ? shortDate(p.followUpOn) : "–" }),
      h("td", { class: "date", text: String(p.applications) })));
  }
  if (!shown.length) body.append(h("tr", {}, h("td", { colspan: "6" }, emptyNote(rows.length ? "No one matches. Clear the search or a filter." : "No one yet. Add a recruiter, an alum, or someone who offered to refer you."))));
  gridEl.append(body);
}

export function peopleLeave() {
  if (table.view === "people") { table.rerender = null; table.view = null; }
}
