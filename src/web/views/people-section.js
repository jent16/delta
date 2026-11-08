// The "People" section of an application's panel: who is linked to it (and as what), other people you know at
// that company who could be, the alumni search links, and a shortcut to add someone and link them in one step.

import { api, ApiError, describeError } from "../lib/api.js";
import { clear, h, icon } from "../lib/dom.js";
import { plural } from "../lib/format.js";
import { ctx } from "../lib/ctx.js";
import { vocab } from "../lib/state.js";
import { externalLink, logo, SEARCH_HOSTS, toast } from "../lib/ui.js";

const ROLE_LABEL = { referrer: "Referrer", recruiter: "Recruiter", interviewer: "Interviewer", "hiring-manager": "Hiring manager", other: "Other" };

/** Fills `container` with the people for `application`. Safe to call again after a change. */
export async function fillPeople(application, container) {
  let view;
  try {
    view = await api.applicationPeople(application.id);
  } catch (e) {
    if (container.isConnected) clear(container).append(h("p", { class: "muted", text: describeError(e) }));
    return;
  }
  if (!container.isConnected) return; // the panel was closed or redrawn while this was loading
  const again = () => fillPeople(application, container);
  const act = async (promise, message) => { try { await promise; toast(message); await again(); } catch (e) { toast(describeError(e), true); } };

  clear(container);
  if (view.people.length) {
    container.append(h("div", { class: "linked" }, view.people.map(({ contact: p, role }) =>
      h("div", { class: "card link-row" }, logo(p.name),
        h("button", { class: "cell-link", type: "button", text: p.name, onclick: (e) => ctx.openPerson(p.id, e.currentTarget) }),
        h("span", { class: "dim small", text: p.title ?? "" }),
        h("span", { class: "mini", text: ROLE_LABEL[role] }),
        h("button", { class: "iconbtn", type: "button", "aria-label": `Unlink ${p.name}`, onclick: () => act(api.unlinkContact(p.id, application.id), `${p.name} unlinked`) }, icon("x", 14))))));
  } else {
    container.append(h("p", { class: "muted", text: "No one linked yet." }));
  }

  if (view.atCompany.length) {
    container.append(h("p", { class: "note-line", text: `People you know at ${application.company}:` }));
    for (const p of view.atCompany) {
      const role = h("select", { "aria-label": `${p.name}'s role for this application` }, vocab.linkRoles.map((r) => h("option", { value: r, text: ROLE_LABEL[r] })));
      container.append(h("div", { class: "link-row" }, h("span", { text: p.name }), role,
        h("button", { class: "btn small", type: "button", text: "Link", onclick: () => act(api.linkContact(p.id, application.id, role.value), `${p.name} linked`) })));
    }
  }

  container.append(
    h("div", { class: "alumni-links" }, view.alumni.map((a) => externalLink(a.url, a.label, SEARCH_HOSTS))),
    h("p", { class: "note-line", text: "Searches open in your own browser. Nothing is scraped or sent anywhere." }),
    pasteBox(application, again, view.alumni.some((a) => a.id === "linkedin-alumni")),
    h("div", { class: "log-form" }, h("button", { class: "btn small", type: "button", onclick: () => ctx.openNewPerson({ company: application.company, applicationId: application.id }) }, icon("plus", 14), `Or add someone by hand`)));
}

// Found someone on LinkedIn? Paste their profile address (or several, one per line) and they are added at this
// company and linked here. Only the text of the link is read: nothing is fetched from LinkedIn.
function pasteBox(application, again, schoolSet) {
  const links = h("textarea", { class: "paste", rows: "2", "aria-label": "LinkedIn profile links", placeholder: "Paste profile links here, one per line" });
  const kind = h("select", { "aria-label": "How you know them" }, vocab.relationships.map((r) => h("option", { value: r, text: r.charAt(0).toUpperCase() + r.slice(1), selected: r === (schoolSet ? "alumni" : "other") })));
  const add = h("button", { class: "btn small", type: "button", text: "Add" });

  async function run() {
    const urls = links.value.split(/[\s,]+/).map((u) => u.trim()).filter(Boolean);
    if (!urls.length) { toast("Paste at least one profile link.", true); links.focus(); return; }
    add.disabled = true;
    const tally = { added: [], linked: [], already: [], bad: [] };
    for (const url of urls) {
      try {
        const r = await api.addFromProfile({ url, applicationId: application.id, relationship: kind.value });
        if (r.created) tally.added.push(r.contact.name); else if (r.linked) tally.linked.push(r.contact.name); else tally.already.push(r.contact.name);
      } catch (e) {
        tally.bad.push(e instanceof ApiError && e.status === 400 ? describeError(e) : "something went wrong");
      }
    }
    add.disabled = false;
    const said = [];
    if (tally.added.length) said.push(`Added ${tally.added.join(", ")}`);
    if (tally.linked.length) said.push(`Linked ${tally.linked.join(", ")}`);
    if (tally.already.length) said.push(`${tally.already.join(", ")} already here`);
    if (tally.bad.length) said.push(`${plural(tally.bad.length, "link")} not added (${tally.bad[0]})`);
    toast(said.join(". ") + (tally.added.length ? ". Names come from the link, so click one to correct it." : ""), tally.bad.length > 0 && !tally.added.length && !tally.linked.length);
    if (tally.added.length || tally.linked.length) { links.value = ""; await again(); }
  }
  add.addEventListener("click", run);
  links.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run(); } });
  return h("div", { class: "paste-box" }, h("label", { class: "paste-label", text: "Found someone on LinkedIn? Paste their profile link" }), links, h("div", { class: "log-form" }, kind, add));
}
