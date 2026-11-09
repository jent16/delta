// "New application": a company box that suggests as you type (your own companies first, then a directory
// of companies that post internships, and it forgives typos), plus the few fields worth entering up front.

import { api, ApiError, describeError } from "../lib/api.js";
import { $, clear, h, icon } from "../lib/dom.js";
import { ctx } from "../lib/ctx.js";
import { today } from "../lib/format.js";
import { closeOverlays, openOverlay } from "../lib/overlay.js";
import { state, vocab } from "../lib/state.js";
import { logo, toast } from "../lib/ui.js";

const START_STATUSES = [["saved", "Saved (not started)"], ["drafting", "Drafting (writing answers)"], ["applied", "Applied"]];

export function openNewApplication() {
  const modal = clear($("#modal"));
  let suggestions = [];
  let active = -1;
  let typedAt = 0;      // which keystroke a response belongs to, so a slow reply can't overwrite a newer one
  let controller = null;
  let timer = null;

  const error = h("div", { class: "err", id: "company-err", role: "alert", hidden: true });
  const hint = h("span", { class: "hint", id: "company-hint", text: "Your own companies come first, then a directory of companies that post internships. Typos still find the right one." });
  const list = h("ul", { class: "list", role: "listbox", id: "company-list", hidden: true });
  const company = h("input", { id: "f-company", type: "text", role: "combobox", "aria-expanded": "false", "aria-controls": "company-list", "aria-autocomplete": "list", placeholder: "Start typing a company", autocomplete: "off" });
  const role = h("input", { id: "f-role", type: "text", placeholder: "e.g. SWE Intern" });
  const posting = h("input", { id: "f-url", type: "url", placeholder: "Paste the link to the job posting (optional)", autocomplete: "off", spellcheck: "false" });
  const term = h("input", { id: "f-term", type: "text", placeholder: "e.g. Summer 2027" });
  const fn = h("select", { id: "f-fn" }, vocab.roleFunctions.map((f) => h("option", { value: f, text: f })));
  const sector = h("select", { id: "f-sector" }, h("option", { value: "", text: "Not sure yet" }), vocab.sectors.map((s) => h("option", { value: s, text: s })));
  const sectorNote = h("span", { class: "hint", id: "sector-note", hidden: true });
  const status = h("select", { id: "f-status" }, START_STATUSES.map(([value, text]) => h("option", { value, text })));
  const appliedOn = h("input", { id: "f-date", type: "date", value: today() });
  const appliedField = h("div", { class: "field", hidden: true }, h("label", { for: "f-date", text: "Applied on" }), appliedOn);
  const deadline = h("input", { id: "f-deadline", type: "date" });
  const location = h("input", { id: "f-loc", type: "text", placeholder: "City or Remote" });
  status.addEventListener("change", () => { appliedField.hidden = status.value !== "applied"; });

  const setOpen = (open) => { list.hidden = !open; company.setAttribute("aria-expanded", String(open)); };

  function paint() {
    clear(list);
    suggestions.forEach((s, i) => {
      const meta = h("span", { class: "meta" });
      if (s.match === "similar") meta.append(h("span", { class: "mini dym", text: "Did you mean?" }));
      if (s.sectorHint) meta.append(h("span", { class: "mini", text: s.sectorHint }));
      meta.append(h("span", { class: `mini${s.source === "yours" ? " me" : ""}`, text: s.source === "yours" ? (s.applications ? `In your tracker · ${s.applications}` : "In your tracker · archived") : "Directory" }));
      list.append(h("li", { class: "opt", role: "option", "aria-selected": String(i === active), onmousedown: (e) => { e.preventDefault(); choose(s); } }, logo(s.name), h("span", { class: "nm", text: s.name }), meta));
    });
    const typed = company.value.trim();
    if (typed && !suggestions.some((s) => s.name.toLowerCase() === typed.toLowerCase())) {
      list.append(h("li", { class: "opt", role: "option", "aria-selected": "false", onmousedown: (e) => { e.preventDefault(); choose({ name: typed }); } },
        icon("plus", 15), h("span", { class: "nm", text: `Add “${typed}” as a new company` }), h("span", { class: "meta" }, h("span", { class: "mini", text: "Not in the list" }))));
    }
    setOpen(list.childNodes.length > 0);
  }

  // a company you already have owns its sector: show it, don't let this form quietly disagree with it
  function lockSector(locked, name = "") {
    sector.disabled = locked;
    sectorNote.hidden = !locked;
    sectorNote.textContent = locked ? `The sector belongs to ${name}. Change it on the Companies screen.` : "";
  }

  function choose(s) {
    company.value = s.name;
    setOpen(false);
    if (s.source === "yours" && s.sector) { sector.value = s.sector; lockSector(true, s.name); }
    else {
      lockSector(false);
      if (s.sectorHint) sector.value = s.sectorHint; // a helpful guess for a company you don't have yet, which you can change
    }
    role.focus();
  }

  async function search() {
    const q = company.value.trim();
    const mine = ++typedAt;
    controller?.abort();
    if (!q) { suggestions = []; paint(); return; }
    controller = new AbortController();
    try {
      const r = await api.searchCompanies(q, controller.signal);
      if (mine !== typedAt) return;
      suggestions = r.suggestions;
      hint.textContent = r.directoryAvailable ? hint.dataset.base : `${r.note ?? "The company directory couldn't be loaded."} Showing only companies from your tracker.`;
      active = -1;
      paint();
    } catch (e) {
      if (e?.name !== "AbortError" && mine === typedAt) { suggestions = []; paint(); }
    }
  }
  hint.dataset.base = hint.textContent;

  company.addEventListener("input", () => { error.hidden = true; lockSector(false); clearTimeout(timer); timer = setTimeout(search, 150); });
  company.addEventListener("focus", () => { if (company.value.trim()) search(); });
  company.addEventListener("blur", () => setTimeout(() => setOpen(false), 120));
  company.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = suggestions.length;
      if (!n) return;
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
      paint();
    } else if (e.key === "Enter" && !list.hidden && active >= 0) { e.preventDefault(); choose(suggestions[active]); }
    else if (e.key === "Escape" && !list.hidden) { e.stopPropagation(); setOpen(false); }
  });

  const showError = (message, openId) => {
    clear(error).append(message, openId ? h("button", { class: "linkish", type: "button", text: " Open it", onclick: () => { closeOverlays(); ctx.openApplication(openId); } }) : null);
    error.hidden = false;
  };

  const submit = h("button", { class: "btn primary", type: "submit", text: "Add application" });
  async function onSubmit(e) {
    e.preventDefault();
    const name = company.value.trim();
    const title = role.value.trim();
    if (!name) { showError("Pick or type a company."); company.focus(); return; }
    if (!title) { role.focus(); toast("Add the role title.", true); return; }
    const body = { company: name, roleTitle: title, roleFunction: fn.value };
    if (sector.value) body.sector = sector.value;
    if (location.value.trim()) body.location = location.value.trim();
    if (term.value.trim()) body.term = term.value.trim();
    if (posting.value.trim()) body.url = posting.value.trim();
    if (deadline.value) body.deadlineOn = deadline.value;
    if (status.value === "applied") body.appliedOn = appliedOn.value || today(); // the server turns an applied date into an Applied status
    else body.status = status.value;
    submit.disabled = true;
    try {
      const created = await api.create(body);
      Object.assign(state, { flash: created.id, list: "all", statusFilter: "all", query: "", sort: { key: "updated", dir: "desc" } });
      closeOverlays();
      toast(`${name} added`);
      await ctx.navigate("applications");
    } catch (err) {
      submit.disabled = false;
      if (err instanceof ApiError && err.body?.error === "duplicate") showError("You already have this company and role (and term).", err.body.existingId);
      else showError(describeError(err));
    }
  }

  const close = h("button", { class: "btn small", type: "button", "aria-label": "Close", onclick: closeOverlays }, icon("x", 14), "Close");
  modal.append(
    h("header", {}, h("h2", { text: "New application" }), close),
    h("form", { class: "form", onsubmit: onSubmit },
      h("div", { class: "field" }, h("label", { for: "f-company", text: "Company" }), h("div", { class: "combo" }, company, list), error, hint),
      h("div", { class: "field" }, h("label", { for: "f-role", text: "Role" }), role),
      h("div", { class: "field" }, h("label", { for: "f-url", text: "Job posting link" }), posting),
      h("div", { class: "row2" }, h("div", { class: "field" }, h("label", { for: "f-fn", text: "Function" }), fn), h("div", { class: "field" }, h("label", { for: "f-sector", text: "Sector" }), sector, sectorNote)),
      h("div", { class: "row2" }, h("div", { class: "field" }, h("label", { for: "f-status", text: "Status" }), status), h("div", { class: "field" }, h("label", { for: "f-deadline", text: "Application deadline (optional)" }), deadline)),
      appliedField,
      h("div", { class: "row2" }, h("div", { class: "field" }, h("label", { for: "f-loc", text: "Location" }), location), h("div", { class: "field" }, h("label", { for: "f-term", text: "Term (optional)" }), term)),
      h("div", { class: "form-actions" }, h("button", { class: "btn", type: "button", onclick: closeOverlays, text: "Cancel" }), submit)));
  openOverlay(modal, company);
}
