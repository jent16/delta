// "Import from LinkedIn": pick the Connections.csv you downloaded from LinkedIn, see exactly what would happen,
// settle any company that is only a "maybe", then import. The file is read in this browser and sent only to this
// app on your own computer; it is not stored.
//
// Only people at companies you ALREADY HAVE are added. The rest are counted, with the biggest employers listed so
// that a company of yours spelt differently on LinkedIn is easy to notice.

import { api, describeError } from "../lib/api.js";
import { $, clear, h, icon } from "../lib/dom.js";
import { ctx } from "../lib/ctx.js";
import { plural } from "../lib/format.js";
import { closeOverlays, openOverlay } from "../lib/overlay.js";
import { label } from "../lib/state.js";
import { toast } from "../lib/ui.js";

const SHOW = 40; // rows listed before "and N more"
const TIER = { exact: "exact match", normalized: "same company (Inc., punctuation)" };

export function openLinkedInImport() {
  const modal = clear($("#modal"));
  modal.classList.add("wide");
  let csv = "";
  let accept = {}; // person key -> the company id you chose for them

  const body = h("div", { class: "form" });
  const close = h("button", { class: "btn small", type: "button", "aria-label": "Close", onclick: () => { modal.classList.remove("wide"); closeOverlays(); } }, icon("x", 14), "Close");
  modal.append(h("header", {}, h("h2", { text: "Import from LinkedIn" }), close), body);

  // ---- step 1: choose the file ----
  function chooseStep(error) {
    const file = h("input", { id: "li-file", type: "file", accept: ".csv,text/csv", "aria-describedby": "li-help" });
    file.addEventListener("change", async () => {
      const f = file.files?.[0];
      if (!f) return;
      if (f.size > 7_500_000) { chooseStep("That file is larger than 7 MB, so it probably isn't the Connections file."); return; }
      csv = await f.text();
      accept = {};
      await previewStep();
    });
    clear(body).append(
      h("ol", { class: "steps", id: "li-help" },
        h("li", { text: "On LinkedIn: Settings, Data privacy, Get a copy of your data. Pick Connections and request it." }),
        h("li", { text: "LinkedIn emails you a link when it's ready. Download the zip and open it." }),
        h("li", { text: "Choose Connections.csv here." })),
      h("div", { class: "field" }, h("label", { for: "li-file", text: "Connections.csv" }), file),
      h("p", { class: "note-line", text: "Only people who work at a company you already have are added. Nothing is sent anywhere except this app on your computer, and the file isn't kept." }),
      error ? h("div", { class: "err", role: "alert", text: error }) : null);
    file.focus();
  }

  // ---- step 2: what would happen ----
  async function previewStep() {
    clear(body).append(h("p", { class: "muted", role: "status", text: "Reading the file…" }));
    let r;
    try { r = await api.previewLinkedIn(csv, accept); }
    catch (e) { chooseStep(describeError(e)); return; }
    const s = r.summary;
    const toAdd = s.create; // the server already counts the ones you confirmed
    const pending = r.items.filter((i) => i.action === "needs_confirmation");
    const adding = r.items.filter((i) => i.action === "create");

    const importBtn = h("button", { class: "btn primary", type: "button", disabled: toAdd === 0, text: toAdd ? `Import ${plural(toAdd, "person", "people")}` : "Nothing to import", onclick: () => commit(importBtn) });
    const children = [
      h("p", { class: "li-headline" }, h("b", { text: `${plural(s.total, "connection")} in the file. ` }), toAdd ? `${plural(toAdd, "person", "people")} work at companies you have.` : "No one works at a company you have yet."),
    ];

    if (pending.length) {
      children.push(h("h3", { class: "li-h", text: `Is this the same company? (${pending.length})` }),
        h("p", { class: "note-line", text: "These are close to a company you have, but not close enough to assume. Choose one, or leave it to skip." }));
      for (const p of pending.slice(0, SHOW)) {
        const pick = h("select", { "aria-label": `Company for ${p.name}` }, h("option", { value: "", text: "Skip" }), p.match.candidates.map((c) => h("option", { value: String(c.id), text: `Yes, ${c.name}`, selected: accept[p.key] === c.id })));
        pick.addEventListener("change", () => { if (pick.value) accept[p.key] = Number(pick.value); else delete accept[p.key]; previewStep(); });
        children.push(h("div", { class: "card li-row" }, h("div", {}, h("b", { text: p.name }), h("small", { text: [p.position, `LinkedIn says: ${p.company}`].filter(Boolean).join(" · ") })), pick));
      }
      if (pending.length > SHOW) children.push(h("p", { class: "muted", text: `…and ${pending.length - SHOW} more (not shown; they will be skipped).` }));
    }

    if (adding.length) {
      children.push(h("h3", { class: "li-h", text: `Will be added (${adding.length})` }));
      const list = h("div", { class: "li-list" });
      for (const p of adding.slice(0, SHOW)) {
        list.append(h("div", { class: "li-line" }, h("b", { text: p.name }), h("span", { class: "dim", text: p.position ?? "" }),
          h("span", { class: "mini me", text: p.addTo.name }), h("span", { class: "mini", text: p.reason ? "you confirmed" : TIER[p.match.tier] ?? p.match.tier }),
          p.relationshipGuessed ? h("span", { class: "mini dym", text: `guess: ${label(p.relationship)}` }) : null));
      }
      if (adding.length > SHOW) list.append(h("p", { class: "muted", text: `…and ${adding.length - SHOW} more.` }));
      children.push(list);
    }

    const skipped = [
      [s.untracked, "work at a company you don't have"], [s.alreadyImported, "were imported before"], [s.alreadyInPeople, "are already in People"],
      [s.duplicateInFile, "appear twice in the file"], [s.noCompany, "have no company on their profile"], [s.invalid, "couldn't be read"], [s.unreadable, "lines were unreadable"],
    ].filter(([n]) => n > 0);
    if (skipped.length) children.push(h("h3", { class: "li-h", text: "Skipped" }), h("ul", { class: "li-skipped" }, skipped.map(([n, why]) => h("li", { text: `${n} ${why}` }))));
    if (r.untrackedTop.length) {
      children.push(h("p", { class: "note-line" }, "Most common employers you don't have: ", r.untrackedTop.slice(0, 8).map((u) => `${u.company} (${u.count})`).join(", "),
        ". If one of these is a company you do have under another name, rename it on the Companies screen and import again."));
    }
    children.push(h("div", { class: "form-actions" }, h("button", { class: "btn", type: "button", onclick: () => chooseStep(), text: "Choose another file" }), importBtn));
    clear(body).append(...children);
  }

  // ---- step 3: do it ----
  async function commit(button) {
    button.disabled = true;
    button.textContent = "Importing…";
    try {
      const r = await api.commitLinkedIn(csv, accept);
      modal.classList.remove("wide");
      closeOverlays();
      csv = ""; // the text of your network is not kept around
      toast(r.created ? `Added ${plural(r.created, "person", "people")} from LinkedIn` : "No one was added");
      await ctx.refresh();
    } catch (e) { button.disabled = false; toast(describeError(e), true); }
  }

  chooseStep();
  openOverlay(modal, $("#li-file"));
}
