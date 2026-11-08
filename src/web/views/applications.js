// The table: your applications, filtered by saved list, status chip and search, sortable, with bulk actions.
// Data is one request (/api/pipeline for the chosen list). Filtering, sorting and searching then happen here,
// in the browser, so typing in the search box is instant.

import { api, describeError } from "../lib/api.js";
import { $, clear, h, icon } from "../lib/dom.js";
import { ctx } from "../lib/ctx.js";
import { ago, plural, shortDate, today } from "../lib/format.js";
import { label, movesFrom, state, vocab } from "../lib/state.js";
import { chip, emptyNote, logo, openMenu, progressBar, toast } from "../lib/ui.js";
import { table, toolbar } from "./toolbar.js";

const COLUMNS = [["company", "Company"], ["role", "Role"], ["status", "Status"], ["progress", "Progress"], ["sector", "Sector"], ["applied", "Applied"], ["updated", "Updated"]];
// when sorting by status: the live, promising ones first, the ended ones last
const STATUS_ORDER = ["offer", "interview", "assessment", "applied", "drafting", "saved", "ghosted", "rejected", "withdrawn"];
const FILTER_CHIPS = [["all", "All"], ["saved", "Saved"], ["drafting", "Drafting"], ["applied", "Applied"], ["assessment", "Assessment"], ["interview", "Interview"], ["offer", "Offer"], ["ended", "Ended"]];

let rows = [];        // the pipeline rows for the current list
let rowEls = new Map(); // id -> { tr, box }, so ticking a box doesn't rebuild the table
let gridEl = null, chipsEl = null, countEl = null; // this screen's own elements (not looked up in the page, which they may not be in yet)

const matchesFilter = (row, f) => f === "all" || (f === "ended" ? row.progress.outcome !== null : row.application.status === f);

function searched() {
  const q = state.query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter(({ application: a }) => `${a.company} ${a.roleTitle} ${a.location ?? ""} ${a.sector ?? ""}`.toLowerCase().includes(q));
}

const SORT_VALUE = {
  company: (r) => r.application.company.toLowerCase(),
  role: (r) => r.application.roleTitle.toLowerCase(),
  status: (r) => STATUS_ORDER.indexOf(r.application.status),
  progress: (r) => r.progress.level,
  sector: (r) => (r.application.sector ?? "~").toLowerCase(), // no sector sorts last
  applied: (r) => r.appliedOn ?? "",
  updated: (r) => r.lastChangeOn ?? "",
};
function sorted(list) {
  const value = SORT_VALUE[state.sort.key];
  const dir = state.sort.dir === "asc" ? 1 : -1;
  return [...list].sort((a, b) => {
    const x = value(a), y = value(b);
    return (x < y ? -1 : x > y ? 1 : 0) * dir || b.application.id - a.application.id;
  });
}

export async function applicationsView() {
  const lists = await api.lists();
  if (state.list !== "all" && !lists.some((l) => String(l.id) === state.list)) state.list = "all"; // that list was deleted
  const [data, stats] = await Promise.all([api.pipeline(state.list), state.list === "all" ? null : api.stats()]);
  rows = data.rows;
  const allCount = stats ? stats.stats.total : rows.length;
  const ids = new Set(rows.map((r) => r.application.id));
  for (const id of [...state.selected]) if (!ids.has(id)) state.selected.delete(id);

  const current = lists.find((l) => String(l.id) === state.list);
  const view = h("div", {});
  countEl = h("span", { class: "muted" });
  view.append(h("div", { class: "head" },
    h("div", {}, h("h1", { class: "title", text: current ? current.name : "Applications" }), countEl), toolbar()));

  const tabs = h("div", { class: "seg", role: "group", "aria-label": "List" });
  const tab = (name, count, id) => tabs.append(h("button", { type: "button", "aria-pressed": String(state.list === id), onclick: () => { state.list = id; state.selected.clear(); state.statusFilter = "all"; ctx.refresh(); } },
    name, h("span", { class: "n", text: String(count) })));
  tab("All applications", allCount, "all");
  lists.forEach((l) => tab(l.name, l.count, String(l.id)));
  chipsEl = h("div", { class: "chips", role: "group", "aria-label": "Status filter" });
  gridEl = h("table", { class: "grid" });
  view.append(tabs, chipsEl, h("div", { class: "tablewrap" }, gridEl));

  table.rerender = renderTable;
  renderTable();
  renderBulk();
  return view;
}

export function leaveApplications() {
  table.rerender = null;
  hideBulk();
}

// ---------- the table ----------
function renderTable() {
  const grid = gridEl;
  if (!grid) return;
  const base = searched();

  const chips = clear(chipsEl);
  for (const [key, name] of FILTER_CHIPS) {
    const n = base.filter((r) => matchesFilter(r, key)).length;
    chips.append(h("button", { class: "fchip", type: "button", "aria-pressed": String(state.statusFilter === key), onclick: () => { state.statusFilter = key; renderTable(); } }, name, h("span", { class: "n", text: String(n) })));
  }

  const visible = sorted(base.filter((r) => matchesFilter(r, state.statusFilter)));
  countEl.textContent = plural(visible.length, "application");

  clear(grid);
  rowEls = new Map();
  const selectAll = h("input", { type: "checkbox", "aria-label": "Select all shown", onchange: (e) => {
    for (const r of visible) { if (e.target.checked) state.selected.add(r.application.id); else state.selected.delete(r.application.id); }
    syncSelection(); renderBulk();
  } });
  const headRow = h("tr", {}, h("th", { class: "chk" }, selectAll));
  for (const [key, name] of COLUMNS) {
    const on = state.sort.key === key;
    headRow.append(h("th", { "aria-sort": on ? (state.sort.dir === "asc" ? "ascending" : "descending") : "none" },
      h("button", { type: "button", onclick: () => { state.sort = { key, dir: on && state.sort.dir === "desc" ? "asc" : "desc" }; renderTable(); } }, name, icon("sort", 13))));
  }
  grid.append(h("thead", {}, headRow));

  const body = h("tbody", {});
  const now = today();
  for (const row of visible) {
    const a = row.application;
    const box = h("input", { type: "checkbox", "aria-label": `Select ${a.company}`, onclick: (e) => e.stopPropagation(), onchange: (e) => {
      if (e.target.checked) state.selected.add(a.id); else state.selected.delete(a.id);
      syncSelection(); renderBulk();
    } });
    const tr = h("tr", { class: state.flash === a.id ? "flash" : "", onclick: () => ctx.openApplication(a.id) },
      h("td", { class: "chk", onclick: (e) => e.stopPropagation() }, box),
      h("td", {}, h("div", { class: "cell-co" }, logo(a.company), h("button", { class: "cell-link", type: "button", text: a.company, onclick: (e) => { e.stopPropagation(); ctx.openApplication(a.id); } }))),
      h("td", { class: "dim", text: a.roleTitle }),
      h("td", {}, chip(a.status, (e) => { e.stopPropagation(); statusMenu(a, e.currentTarget); })),
      h("td", {}, progressBar(row.progress)),
      h("td", { class: "dim", text: a.sector ?? "–" }),
      h("td", { class: "date", text: row.appliedOn ? shortDate(row.appliedOn) : "–" }),
      h("td", { class: "date", text: row.lastChangeOn ? ago(row.lastChangeOn, now) : "–" }));
    rowEls.set(a.id, { tr, box });
    body.append(tr);
  }
  if (!visible.length) body.append(h("tr", {}, h("td", { colspan: "8" }, emptyNote(rows.length ? "No applications match. Clear the search or a filter." : "Nothing here yet. Add your first application with the button above."))));
  grid.append(body);
  state.flash = null;
  syncSelection(visible, selectAll);
}

function syncSelection(visible, selectAll) {
  for (const [id, { tr, box }] of rowEls) { const on = state.selected.has(id); box.checked = on; tr.classList.toggle("sel", on); }
  const all = selectAll ?? gridEl.querySelector("thead input[type=checkbox]");
  if (all) all.checked = rowEls.size > 0 && [...rowEls.keys()].every((id) => state.selected.has(id));
}

// ---------- one application's status ----------
async function move(application, to) {
  try {
    await api.changeStatus(application.id, to);
    toast(`${application.company} moved to ${label(to)}`);
    await ctx.refresh();
  } catch (e) { toast(describeError(e), true); }
}

function statusMenu(application, anchor) {
  const next = movesFrom(application.status);
  if (!next.length) { toast(`${label(application.status)} is final. Nothing can follow it.`, true); return; }
  openMenu(anchor, "Move to", next.map((s) => ({ status: s, run: () => move(application, s) })));
}

// ---------- the bulk bar (all or nothing) ----------
const byId = (id) => rows.find((r) => r.application.id === id)?.application;

async function bulkGhost() {
  const picked = [...state.selected].map(byId).filter(Boolean);
  // check here first only to give a friendly message; the server re-checks and is the authority
  const blocked = picked.filter((a) => !movesFrom(a.status).includes("ghosted"));
  if (blocked.length) {
    const named = blocked.slice(0, 2).map((a) => `${a.company} is ${a.status}`).join(", ");
    toast(`Nothing changed. ${named}${blocked.length > 2 ? ` and ${blocked.length - 2} more` : ""} and can't be marked ghosted.`, true);
    return;
  }
  try {
    const r = await api.bulkStatus(picked.map((a) => a.id), "ghosted", "Marked ghosted in bulk");
    state.selected.clear();
    toast(`${plural(r.updated, "application")} marked ghosted`);
    await ctx.refresh();
  } catch (e) { toast(describeError(e), true); }
}

function bulkSector(anchor) {
  openMenu(anchor, "Set sector", vocab.sectors.map((sector) => ({ label: sector, run: async () => {
    try {
      const r = await api.bulkEdit([...state.selected], { sector });
      state.selected.clear();
      toast(`Sector set to ${sector} on ${plural(r.updated, "application")}`);
      await ctx.refresh();
    } catch (e) { toast(describeError(e), true); }
  } })));
}

export function hideBulk() { const el = $("#bulk"); el.hidden = true; clear(el); }

function renderBulk() {
  const el = clear($("#bulk"));
  if (state.view !== "applications" || !state.selected.size) { el.hidden = true; return; }
  el.hidden = false;
  el.className = "bulk";
  el.append(h("b", { text: `${state.selected.size} selected` }),
    h("button", { class: "btn small", type: "button", onclick: (e) => { e.stopPropagation(); bulkSector(e.currentTarget); } }, "Set sector", icon("down", 13)),
    h("button", { class: "btn small", type: "button", onclick: bulkGhost, text: "Mark ghosted" }),
    h("button", { class: "iconbtn", type: "button", "aria-label": "Clear selection", onclick: () => { state.selected.clear(); syncSelection(); renderBulk(); } }, icon("x", 15)));
}
