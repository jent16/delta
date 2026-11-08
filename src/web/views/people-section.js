// The "People" section of an application's panel: who is linked to it (and as what), other people you know at
// that company who could be, the alumni search links, and a shortcut to add someone and link them in one step.

import { api, describeError } from "../lib/api.js";
import { clear, h, icon } from "../lib/dom.js";
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
    h("div", { class: "log-form" }, h("button", { class: "btn small", type: "button", onclick: () => ctx.openNewPerson({ company: application.company, applicationId: application.id }) }, icon("plus", 14), `Add someone at ${application.company}`)),
    h("div", { class: "alumni-links" }, view.alumni.map((a) => externalLink(a.url, a.label, SEARCH_HOSTS))),
    h("p", { class: "note-line", text: "Searches open in your own browser. Nothing is scraped or sent anywhere." }));
}
