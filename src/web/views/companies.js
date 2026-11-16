// Companies: each company once, with the sector that belongs to the company (not to any single application).
// Set Stripe to Fintech here and every Stripe application is classified. Rename fixes a spelling everywhere.
// Merge folds a duplicate ("Stripe Inc") into the company you meant ("Stripe").

import { api, ApiError, describeError } from "../lib/api.js";
import { $, clear, h, icon } from "../lib/dom.js";
import { nameList, renderBulkBar } from "../lib/bulk.js";
import { confirmDialog } from "../lib/confirm.js";
import { ctx } from "../lib/ctx.js";
import { plural } from "../lib/format.js";
import { closeOverlays, openOverlay } from "../lib/overlay.js";
import { state, vocab } from "../lib/state.js";
import { emptyNote, logo, openMenu, toast } from "../lib/ui.js";
import { table, toolbar } from "./toolbar.js";

let rows = [];
let filter = "all"; // all | none (no sector yet)
let gridEl = null, chipsEl = null, countEl = null;

const FILTERS = [["all", "All"], ["none", "No sector"]];

function visible() {
  const q = state.query.trim().toLowerCase();
  return rows.filter((c) => (!q || c.name.toLowerCase().includes(q)) && (filter === "all" || c.sector === null));
}

export async function companiesView() {
  rows = await api.companies();
  countEl = h("span", { class: "muted" });
  chipsEl = h("div", { class: "chips", role: "group", "aria-label": "Filter" });
  gridEl = h("table", { class: "grid companies-grid" });
  table.rerender = renderTable;
  table.view = "companies";
  renderTable();
  return h("div", {},
    h("div", { class: "head" }, h("div", {}, h("h1", { class: "title", text: "Companies" }), countEl), toolbar()),
    h("p", { class: "note-line", text: "A sector belongs to the company: set it once and every application there follows. Rename fixes a spelling everywhere; merge folds a duplicate into the one you meant." }),
    chipsEl, h("div", { class: "tablewrap" }, gridEl));
}

function renderTable() {
  const base = rows.filter((c) => !state.query.trim() || c.name.toLowerCase().includes(state.query.trim().toLowerCase()));
  clear(chipsEl);
  for (const [key, name] of FILTERS) {
    const n = base.filter((c) => key === "all" || c.sector === null).length;
    chipsEl.append(h("button", { class: "fchip", type: "button", "aria-pressed": String(filter === key), onclick: () => { filter = key; renderTable(); } }, name, h("span", { class: "n", text: String(n) })));
  }
  const shown = visible();
  countEl.textContent = plural(shown.length, "company", "companies");

  for (const id of [...state.selected]) if (!rows.some((c) => c.id === id)) state.selected.delete(id); // one that was just deleted
  rowEls = new Map();
  const selectAll = h("input", { type: "checkbox", "aria-label": "Select all shown", onchange: (e) => {
    for (const c of shown) { if (e.target.checked) state.selected.add(c.id); else state.selected.delete(c.id); }
    syncSelection(); renderBulk();
  } });
  clear(gridEl).append(h("thead", {}, h("tr", {}, h("th", { class: "chk" }, selectAll), ...["Company", "Sector", "Applications", ""].map((name) => h("th", {}, h("span", { class: "th-plain", text: name }))))));
  const body = h("tbody", {});
  for (const c of shown) body.append(row(c));
  if (!shown.length) body.append(h("tr", {}, h("td", { colspan: "5" }, emptyNote(rows.length ? "No companies match." : "No companies yet. They appear as you add applications."))));
  gridEl.append(body);
  syncSelection(selectAll);
  renderBulk();
}

// ---------- ticking companies, and deleting ----------
let rowEls = new Map(); // id -> { tr, box }, so ticking a box doesn't rebuild the table

function syncSelection(selectAll) {
  for (const [id, { tr, box }] of rowEls) { const on = state.selected.has(id); box.checked = on; tr.classList.toggle("sel", on); }
  const all = selectAll ?? gridEl.querySelector("thead input[type=checkbox]");
  if (all) all.checked = rowEls.size > 0 && [...rowEls.keys()].every((id) => state.selected.has(id));
}

function renderBulk() {
  renderBulkBar({
    count: state.view === "companies" ? state.selected.size : 0,
    onClear: () => { state.selected.clear(); syncSelection(); renderBulk(); },
    buttons: [h("button", { class: "btn small", type: "button", onclick: () => confirmDelete(rows.filter((c) => state.selected.has(c.id))) }, icon("trash", 14), "Delete")],
  });
}

/** Deleting a company takes every application there with it (archived ones too), so say exactly how many. People you know there are kept. */
function confirmDelete(picked) {
  if (!picked.length) return;
  const apps = picked.reduce((n, c) => n + c.totalApplications, 0);
  const archived = picked.reduce((n, c) => n + (c.totalApplications - c.applications), 0);
  const what = apps === 0 ? "None of them has an application." : `This permanently deletes ${plural(apps, "application")}${archived ? ` (${archived} archived)` : ""} at ${picked.length === 1 ? "it" : "them"}, with their status history and notes.`;
  confirmDialog({
    title: picked.length === 1 ? `Delete ${picked[0].name}?` : `Delete ${plural(picked.length, "company", "companies")}?`,
    body: [
      nameList(picked.map((c) => c.name), 4),
      what,
      "The people you know there are kept; they just no longer belong to a company. This can't be undone.",
    ],
    confirmLabel: picked.length === 1 ? "Delete company" : `Delete ${plural(picked.length, "company", "companies")}`, danger: true,
    onConfirm: async () => {
      try {
        const r = await api.deleteCompanies(picked.map((c) => c.id));
        state.selected.clear();
        toast(`${plural(r.removed, "company", "companies")} deleted${r.applications ? `, with ${plural(r.applications, "application")}` : ""}`);
        await ctx.refresh();
      } catch (e) { toast(describeError(e), true); }
    },
  });
}

function row(c) {
  // rename: saves when you leave the field; Escape puts the old name back
  const name = h("input", { class: "inline-input", type: "text", value: c.name, "aria-label": `Name of ${c.name}`, maxlength: "200" });
  name.addEventListener("keydown", (e) => { if (e.key === "Enter") name.blur(); else if (e.key === "Escape") { name.value = c.name; name.blur(); } });
  name.addEventListener("change", async () => {
    const next = name.value.replace(/\s+/g, " ").trim();
    if (!next || next === c.name) { name.value = c.name; return; }
    try {
      await api.editCompany(c.id, { name: next });
      toast(`Renamed to ${next}`);
      await ctx.refresh();
    } catch (e) {
      name.value = c.name;
      if (e instanceof ApiError && e.body?.error === "company_exists") confirmMerge(c, rows.find((x) => x.id === e.body.existingId) ?? { id: e.body.existingId, name: e.body.existingName, sector: null }, true); // the full row, so the dialog knows its sector
      else toast(describeError(e), true);
    }
  });

  const sector = h("select", { class: "inline-select", "aria-label": `Sector of ${c.name}` },
    h("option", { value: "", text: "Not set", selected: c.sector === null }), vocab.sectors.map((s) => h("option", { value: s, text: s, selected: s === c.sector })));
  sector.addEventListener("change", async () => {
    try {
      await api.editCompany(c.id, { sector: sector.value === "" ? null : sector.value });
      toast(`${c.name}: ${sector.value || "sector cleared"}${c.applications ? `, for ${plural(c.applications, "application")}` : ""}`);
      await ctx.refresh();
    } catch (e) { sector.value = c.sector ?? ""; toast(describeError(e), true); }
  });

  const open = h("button", { class: "cell-link", type: "button", title: "Show this company's applications", onclick: () => { state.query = c.name; state.statusFilter = "all"; ctx.navigate("applications", "all"); } },
    String(c.applications), c.totalApplications > c.applications ? h("span", { class: "dim", text: ` + ${c.totalApplications - c.applications} archived` }) : null);

  const merge = h("button", { class: "btn small", type: "button", onclick: (e) => { e.stopPropagation(); mergeMenu(c, e.currentTarget); } }, "Merge into…", icon("down", 13));
  const del = h("button", { class: "btn small danger-outline", type: "button", "aria-label": `Delete ${c.name}`, onclick: () => confirmDelete([c]) }, icon("trash", 14), "Delete");
  const box = h("input", { type: "checkbox", "aria-label": `Select ${c.name}`, onchange: (e) => {
    if (e.target.checked) state.selected.add(c.id); else state.selected.delete(c.id);
    syncSelection(); renderBulk();
  } });
  const tr = h("tr", { class: "static-row" }, h("td", { class: "chk" }, box), h("td", {}, h("div", { class: "cell-co" }, logo(c.name), name)), h("td", {}, sector), h("td", {}, open), h("td", { class: "end-cell" }, h("div", { class: "row-actions" }, merge, del)));
  rowEls.set(c.id, { tr, box });
  return tr;
}

function mergeMenu(from, anchor) {
  const others = rows.filter((c) => c.id !== from.id);
  if (!others.length) { toast("There is no other company to merge into.", true); return; }
  openMenu(anchor, `Merge “${from.name}” into`, others.map((c) => ({ label: c.name, run: () => confirmMerge(from, c, false) })));
}

/** Folding one company into another moves applications for good, so it asks first, and says exactly what will happen. */
function confirmMerge(from, into, becauseOfRename) {
  const modal = clear($("#modal"));
  const run = async () => {
    try {
      const r = await api.mergeCompany(from.id, into.id);
      closeOverlays();
      toast(`Merged ${plural(r.moved, "application")} into ${r.company.name}`);
      await ctx.refresh();
    } catch (e) { toast(describeError(e), true); }
  };
  const cancel = h("button", { class: "btn", type: "button", onclick: closeOverlays, text: "Cancel" });
  const go = h("button", { class: "btn primary", type: "button", onclick: run, text: `Merge into ${into.name}` });
  modal.append(
    h("header", {}, h("h2", { text: "Merge companies?" }), h("button", { class: "btn small", type: "button", "aria-label": "Close", onclick: closeOverlays }, icon("x", 14), "Close")),
    h("div", { class: "form" },
      h("p", { text: becauseOfRename ? `You already have a company called “${into.name}”. A company can only exist once.` : "" }),
      h("p", { text: `Every application at “${from.name}” will move to “${into.name}”, and “${from.name}” will be removed. The name “${into.name}” is kept${from.sector && !into.sector ? ` and it takes the sector ${from.sector}` : ""}.` }),
      h("p", { class: "muted", text: "Nothing is deleted, history included. If any role would end up duplicated, the merge is refused and nothing changes." }),
      h("div", { class: "form-actions" }, cancel, go)));
  openOverlay(modal, go);
}

export function companiesLeave() {
  if (table.view === "companies") { table.rerender = null; table.view = null; }
}
