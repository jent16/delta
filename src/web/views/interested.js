// Interested: jobs you might apply to, before they are applications. Paste the link, jot a note; when you are
// ready, "Start application" turns it into a real one (Saved or Drafting) with the link and note carried over.

import { api, describeError } from "../lib/api.js";
import { clear, h } from "../lib/dom.js";
import { confirmDialog } from "../lib/confirm.js";
import { plural } from "../lib/format.js";
import { emptyNote, externalLink, logo, openMenu, toast } from "../lib/ui.js";

const anyHost = () => true;

export async function interestedView() {
  let items = await api.interests();
  const count = h("span", { class: "muted" });
  const list = h("div", { class: "int-list" });

  const paint = () => {
    count.textContent = plural(items.length, "job");
    clear(list);
    if (!items.length) list.append(emptyNote("Nothing here yet. When you spot a job you might apply to, paste its link above."));
    for (const item of items) list.append(card(item, { remove: removeFromList, replace }));
  };
  const removeFromList = (id) => { items = items.filter((i) => i.id !== id); paint(); };
  const replace = (updated) => { items = items.map((i) => (i.id === updated.id ? updated : i)); };

  // ---- add: the link comes first, because it is the thing you have in your clipboard ----
  const link = h("input", { id: "int-url", type: "url", placeholder: "Paste the link to the job posting", autocomplete: "off", spellcheck: "false" });
  const company = h("input", { id: "int-company", type: "text", maxlength: "200", placeholder: "e.g. Stripe", autocomplete: "off" });
  const role = h("input", { id: "int-role", type: "text", maxlength: "200", placeholder: "e.g. SWE Intern (optional)" });
  const note = h("textarea", { id: "int-note", rows: "2", maxlength: "5000", placeholder: "Why it caught your eye, who to ask, what to prepare (optional)" });
  const problem = h("div", { class: "err", role: "alert", hidden: true });
  const add = h("button", { class: "btn primary", type: "submit", text: "Add to Interested" });
  const form = h("form", { class: "form int-form", novalidate: true },
    h("div", { class: "field" }, h("label", { for: "int-url", text: "Job posting link" }), link),
    h("div", { class: "row2" }, h("div", { class: "field" }, h("label", { for: "int-company", text: "Company" }), company), h("div", { class: "field" }, h("label", { for: "int-role", text: "Role" }), role)),
    h("div", { class: "field" }, h("label", { for: "int-note", text: "Notes" }), note),
    problem, h("div", { class: "form-actions" }, add));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    problem.hidden = true;
    if (!company.value.trim()) { problem.textContent = "Add the company name."; problem.hidden = false; company.focus(); return; }
    add.disabled = true;
    try {
      const made = await api.addInterest({ company: company.value, roleTitle: role.value, url: link.value, note: note.value });
      items = [made, ...items];
      link.value = company.value = role.value = note.value = "";
      paint();
      link.focus();
    } catch (err) { problem.textContent = describeError(err); problem.hidden = false; }
    add.disabled = false;
  });

  paint();
  return h("div", {},
    h("div", { class: "head" }, h("div", {}, h("h1", { class: "title", text: "Interested" }), count)),
    h("p", { class: "note-line", text: "Jobs you might apply to. Paste the link, add a note if you like, and press Start application when you are ready: it becomes a real application with the link and note carried over." }),
    h("section", { class: "panel" }, form),
    list);
}

function card(item, { remove, replace }) {
  const stored = { ...item }; // what the server last confirmed, so a failed save can put it back
  const save = (key, input) => async () => {
    const value = input.value.trim();
    if ((stored[key] ?? "") === value) return;
    try {
      const updated = await api.editInterest(item.id, { [key]: value === "" ? null : value });
      Object.assign(stored, updated);
      replace(updated);
      toast("Saved");
      if (key === "url") openRow.replaceChildren(...openContent());
    } catch (e) {
      input.value = stored[key] ?? "";
      toast(describeError(e), true);
    }
  };

  const url = h("input", { type: "url", id: `int-u-${item.id}`, value: item.url ?? "", placeholder: "Paste the link to the job posting", spellcheck: "false", "aria-label": `Link to the ${item.company} posting` });
  url.addEventListener("change", save("url", url));
  url.addEventListener("paste", () => setTimeout(() => url.dispatchEvent(new Event("change")), 0)); // saved the moment you paste it
  const openRow = h("span", { class: "int-open" });
  const openContent = () => (stored.url ? [externalLink(stored.url, "Open posting", anyHost)] : []);
  openRow.append(...openContent());

  const role = h("input", { type: "text", id: `int-r-${item.id}`, value: item.roleTitle ?? "", maxlength: "200", placeholder: "Role (needed to start the application)", "aria-label": `Role at ${item.company}` });
  role.addEventListener("change", save("roleTitle", role));
  const company = h("input", { type: "text", class: "inline-input int-name", value: item.company, maxlength: "200", "aria-label": "Company" });
  company.addEventListener("change", () => (company.value.trim() ? save("company", company)() : (company.value = stored.company)));
  const note = h("textarea", { rows: "3", maxlength: "5000", placeholder: "Notes: why it caught your eye, who to ask, what to prepare…", "aria-label": `Notes about ${item.company}` });
  note.value = item.note;
  note.addEventListener("change", save("note", note));

  const problem = h("div", { class: "err", role: "alert", hidden: true });
  const startBtn = h("button", { class: "btn primary", type: "button", "aria-haspopup": "menu", text: "Start application" });
  const start = async (status) => {
    problem.hidden = true;
    if (!role.value.trim()) { problem.textContent = "Add the role first: an application needs one."; problem.hidden = false; role.focus(); return; }
    startBtn.disabled = true;
    try {
      const app = await api.startInterest(item.id, { status, roleTitle: role.value });
      remove(item.id);
      toast(`${app.company} is now ${status === "drafting" ? "in Drafting" : "Saved"}. Find it under Applications.`);
    } catch (e) { problem.textContent = describeError(e); problem.hidden = false; startBtn.disabled = false; }
  };
  startBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openMenu(startBtn, "Start it as", [
      { label: "Saved (not started)", run: () => start("saved") },
      { label: "Drafting (writing answers)", run: () => start("drafting") },
    ]);
  });
  const del = h("button", { class: "btn small", type: "button", text: "Remove", onclick: () => confirmDialog({
    title: `Remove ${stored.company}?`, body: ["This removes it from Interested, along with its note. It can't be undone."], confirmLabel: "Remove", danger: true,
    onConfirm: async () => { try { await api.removeInterest(item.id); remove(item.id); toast("Removed"); } catch (e) { toast(describeError(e), true); } },
  }) });

  return h("section", { class: "panel int-card" },
    h("div", { class: "int-top" }, logo(item.company), company, openRow),
    h("div", { class: "field" }, h("label", { for: url.id, text: "Job posting link" }), url),
    h("div", { class: "field" }, h("label", { for: role.id, text: "Role" }), role),
    note, problem,
    h("div", { class: "int-actions" }, del, startBtn));
}
