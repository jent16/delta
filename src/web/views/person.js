// One person's panel: details you can edit, the dated log of what you did with them, the applications they are
// linked to, and the alumni search links for their company. Also the "add a person" form.

import { api, describeError } from "../lib/api.js";
import { $, clear, h, icon } from "../lib/dom.js";
import { ctx } from "../lib/ctx.js";
import { confirmDialog } from "../lib/confirm.js";
import { attachDrag } from "../lib/drag.js";
import { shortDate, today } from "../lib/format.js";
import { crossfade, flyBetween, staggerIn } from "../lib/motion.js";
import { closeOverlays, openOverlay } from "../lib/overlay.js";
import { label, vocab } from "../lib/state.js";
import { externalLink, logo, SEARCH_HOSTS, toast } from "../lib/ui.js";

let currentId = null;

export async function openPerson(id, from) {
  try {
    draw(await api.contact(id), from);
  } catch (e) { toast(describeError(e), true); }
}

const EVENT_LABEL = { messaged: "Messaged", replied: "Replied", call: "Call", met: "Met", "referral-asked": "Asked for a referral", referred: "Referred me", note: "Note" };
const ROLE_LABEL = { referrer: "Referrer", recruiter: "Recruiter", interviewer: "Interviewer", "hiring-manager": "Hiring manager", other: "Other" };

const FIELDS = [
  { key: "title", name: "Title", kind: "text", placeholder: "e.g. Software Engineer" },
  { key: "company", name: "Company", kind: "text", placeholder: "Where they work now" },
  { key: "relationship", name: "How you know them", kind: "select", options: () => vocab.relationships.map((r) => [r, label(r)]) },
  { key: "followUpOn", name: "Follow up on", kind: "date" },
  { key: "email", name: "Email", kind: "email", wide: true },
  { key: "linkedinUrl", name: "LinkedIn profile", kind: "url", wide: true, placeholder: "Paste the profile link" },
];

function draw({ contact: p, events, applications, alumni }, from) {
  currentId = p.id;
  const drawer = $("#drawer");
  const refreshHere = async () => { await ctx.refresh(); openPerson(p.id); };
  const act = async (promise, message) => { try { await promise; if (message) toast(message); await refreshHere(); } catch (e) { toast(describeError(e), true); } };

  // ---- details: each field saves by itself when you leave it ----
  const grid = h("div", { class: "edit-grid" });
  const nameInput = h("input", { id: "p-name", type: "text", value: p.name, maxlength: "200" });
  grid.append(h("div", { class: "field wide" }, h("label", { for: "p-name", text: "Name" }), nameInput));
  const inputs = [[nameInput, "name", p.name]];
  for (const f of FIELDS) {
    const id = `p-${f.key}`;
    const stored = p[f.key] ?? "";
    const input = f.kind === "select"
      ? h("select", { id }, f.options().map(([v, t]) => h("option", { value: v, text: t, selected: v === stored })))
      : h("input", { id, type: f.kind, value: stored, placeholder: f.placeholder });
    inputs.push([input, f.key, stored]);
    grid.append(h("div", { class: `field${f.wide ? " wide" : ""}` }, h("label", { for: id, text: f.name }), input));
  }
  for (const [input, key, initial] of inputs) {
    let stored = initial;
    input.addEventListener("change", async () => {
      const value = input.value.trim();
      if (value === stored) return;
      if (key === "name" && !value) { input.value = stored; toast("A person needs a name.", true); return; }
      try {
        await api.editContact(p.id, { [key]: value === "" ? null : value });
        stored = value;
        toast("Saved");
        await ctx.refresh();
      } catch (e) { input.value = stored; toast(describeError(e), true); }
    });
  }

  const notes = h("textarea", { "aria-label": "Notes", placeholder: "How you met, what they offered, what to ask…", value: p.notes });
  notes.addEventListener("change", async () => { try { await api.editContact(p.id, { notes: notes.value }); toast("Notes saved"); } catch (e) { toast(describeError(e), true); } });

  // ---- the log ----
  const kind = h("select", { "aria-label": "What happened" }, vocab.eventKinds.map((k) => h("option", { value: k, text: EVENT_LABEL[k] })));
  const on = h("input", { type: "date", value: today(), "aria-label": "Date" });
  const note = h("input", { type: "text", placeholder: "Optional note", "aria-label": "Note", maxlength: "1000" });
  const add = h("button", { class: "btn small", type: "button", text: "Add to log", onclick: () => act(api.addContactEvent(p.id, { kind: kind.value, on: on.value || undefined, note: note.value }), "Logged") });
  const log = h("ol", { class: "timeline" });
  for (const e of [...events].reverse()) {
    log.append(h("li", {}, h("span", { class: "pt" }), h("div", {}, h("b", { text: EVENT_LABEL[e.kind] }), e.note ? h("div", { class: "tl-note", text: e.note }) : null), h("span", { class: "date", text: shortDate(e.occurredOn) })));
  }
  if (!events.length) log.append(h("li", { class: "empty", text: "Nothing logged yet." }));

  // ---- linked applications ----
  const linked = h("div", { class: "linked" });
  for (const l of applications) {
    linked.append(h("div", { class: "card link-row" },
      h("button", { class: "cell-link", type: "button", text: `${l.company}, ${l.roleTitle}`, onclick: () => ctx.openApplication(l.applicationId) }),
      h("span", { class: "mini", text: ROLE_LABEL[l.role] }),
      h("button", { class: "iconbtn", type: "button", "aria-label": `Unlink from ${l.company}`, onclick: () => act(api.unlinkContact(p.id, l.applicationId), "Unlinked") }, icon("x", 14))));
  }
  if (!applications.length) linked.append(h("p", { class: "muted", text: "Not linked to any application yet." }));
  const pick = h("select", { "aria-label": "Application to link" }, h("option", { value: "", text: "Link to an application…" }));
  const role = h("select", { "aria-label": "Their role for it" }, vocab.linkRoles.map((r) => h("option", { value: r, text: ROLE_LABEL[r] })));
  const linkBtn = h("button", { class: "btn small", type: "button", text: "Link", onclick: () => { if (pick.value) act(api.linkContact(p.id, Number(pick.value), role.value), "Linked"); } });
  // offer this person's own company's applications first; the rest after
  api.applications({ q: p.company ?? undefined }).then((apps) => {
    const already = new Set(applications.map((a) => a.applicationId));
    for (const a of apps.filter((x) => !already.has(x.id))) pick.append(h("option", { value: String(a.id), text: `${a.company}, ${a.roleTitle}` }));
  }).catch(() => {});

  const close = h("button", { class: "btn small closebtn", type: "button", "aria-label": "Close", onclick: closeOverlays }, icon("x", 14), "Close");
  const head = h("div", { class: "drawer-head" },
    h("div", { class: "dh-top" }, close),
    h("div", { class: "dh-main" }, logo(p.name), h("div", { class: "drawer-title" }, h("h2", { text: p.name }), h("p", { text: [p.title, p.company].filter(Boolean).join(" at ") || label(p.relationship) }))));

  const body = h("div", { class: "drawer-body" },
    h("div", { class: "sect" }, h("h3", { text: "Details" }), grid, p.linkedinUrl ? h("p", { class: "note-line" }, externalLink(p.linkedinUrl, "Open LinkedIn profile")) : null),
    h("div", { class: "sect" }, h("h3", { text: "Log" }), h("div", { class: "log-form" }, kind, on, note, add), log),
    h("div", { class: "sect" }, h("h3", { text: "Applications" }), linked, h("div", { class: "log-form" }, pick, role, linkBtn)),
    alumni.length ? h("div", { class: "sect" }, h("h3", { text: `Find more people at ${p.company}` }), h("div", { class: "alumni-links" }, alumni.map((a) => externalLink(a.url, a.label, SEARCH_HOSTS))),
      h("p", { class: "note-line", text: "These open a normal search in your own browser. Nothing is scraped or sent anywhere." })) : null,
    h("div", { class: "sect" }, h("h3", { text: "Notes" }), notes),
    h("div", { class: "sect" }, h("button", { class: "btn small danger-outline", type: "button", text: "Delete person…", onclick: () => confirmDialog({
      title: `Delete ${p.name}?`,
      body: [`This permanently removes ${p.name}, their log and their links to applications. The applications themselves are not touched.`, "This can't be undone."],
      confirmLabel: "Delete", danger: true,
      onConfirm: async () => { try { await api.deleteContact(p.id); toast(`${p.name} deleted`); await ctx.refresh(); } catch (e) { toast(describeError(e), true); } } }) })));

  const wasOpen = !drawer.hidden && drawer._leaving == null;
  if (wasOpen) crossfade(drawer, () => drawer.append(head, body));
  else clear(drawer).append(head, body);
  const newlyOpened = openOverlay(drawer, close);
  if (newlyOpened) {
    const rowLogo = from?.closest?.("tr")?.querySelector(".logo") ?? document.querySelector(`[data-person-id="${p.id}"] .logo`);
    flyBetween(rowLogo, $(".drawer-head .logo", drawer));
    staggerIn(body.children, { base: 90 });
  }
  attachDrag(drawer, head);
}

// ---------------- add a person ----------------
/** prefill: { company?, applicationId?, role? }: with an applicationId the new person is linked to it straight away. */
export async function openNewPerson(prefill = {}) {
  const modal = clear($("#modal"));
  const companies = await api.companies().catch(() => []);
  const list = h("datalist", { id: "company-names" }, companies.map((c) => h("option", { value: c.name })));
  const name = h("input", { id: "n-name", type: "text", maxlength: "200", placeholder: "Full name" });
  const company = h("input", { id: "n-company", type: "text", list: "company-names", value: prefill.company ?? "", placeholder: "Where they work", autocomplete: "off" });
  const title = h("input", { id: "n-title", type: "text", placeholder: "e.g. University Recruiter" });
  const rel = h("select", { id: "n-rel" }, vocab.relationships.map((r) => h("option", { value: r, text: label(r), selected: r === (prefill.relationship ?? "other") })));
  const email = h("input", { id: "n-email", type: "email", placeholder: "Optional" });
  const url = h("input", { id: "n-url", type: "url", placeholder: "Paste the profile link" });
  const follow = h("input", { id: "n-follow", type: "date" });
  const error = h("div", { class: "err", role: "alert", hidden: true });
  const submit = h("button", { class: "btn primary", type: "submit", text: prefill.applicationId ? "Add and link" : "Add person" });

  async function onSubmit(e) {
    e.preventDefault();
    if (!name.value.trim()) { error.textContent = "Add a name."; error.hidden = false; name.focus(); return; }
    const body = { name: name.value, relationship: rel.value };
    for (const [key, el] of [["company", company], ["title", title], ["email", email], ["linkedinUrl", url], ["followUpOn", follow]]) if (el.value.trim()) body[key] = el.value.trim();
    submit.disabled = true;
    try {
      const created = await api.createContact(body);
      if (prefill.applicationId) await api.linkContact(created.id, prefill.applicationId, prefill.role ?? "other");
      closeOverlays();
      toast(`${created.name} added`);
      await ctx.refresh();
      if (prefill.applicationId) ctx.openApplication(prefill.applicationId); else openPerson(created.id);
    } catch (err) { submit.disabled = false; error.textContent = describeError(err); error.hidden = false; }
  }

  modal.append(
    h("header", {}, h("h2", { text: "Add a person" }), h("button", { class: "btn small", type: "button", "aria-label": "Close", onclick: closeOverlays }, icon("x", 14), "Close")),
    h("form", { class: "form", onsubmit: onSubmit },
      h("div", { class: "field" }, h("label", { for: "n-name", text: "Name" }), name),
      h("div", { class: "row2" }, h("div", { class: "field" }, h("label", { for: "n-company", text: "Company" }), company, list), h("div", { class: "field" }, h("label", { for: "n-title", text: "Title" }), title)),
      h("div", { class: "row2" }, h("div", { class: "field" }, h("label", { for: "n-rel", text: "How you know them" }), rel), h("div", { class: "field" }, h("label", { for: "n-follow", text: "Follow up on" }), follow)),
      h("div", { class: "row2" }, h("div", { class: "field" }, h("label", { for: "n-email", text: "Email" }), email), h("div", { class: "field" }, h("label", { for: "n-url", text: "LinkedIn profile" }), url)),
      error,
      h("div", { class: "form-actions" }, h("button", { class: "btn", type: "button", onclick: closeOverlays, text: "Cancel" }), submit)));
  openOverlay(modal, name);
}
