// Everything that needs a nudge, worked out from your dates. Nothing here is stored separately.

import { api } from "../lib/api.js";
import { h } from "../lib/dom.js";
import { emptyNote } from "../lib/ui.js";
import { ctx } from "../lib/ctx.js";
import { logo } from "../lib/ui.js";
import { attentionGroups, attentionItem, panel } from "./parts.js";
import { toolbar } from "./toolbar.js";

export async function remindersView() {
  const { reminders } = await api.reminders();
  const groups = attentionGroups(reminders);
  const people = reminders.contactFollowUps ?? [];
  const group = (cls, ic, title, items) => {
    const list = h("div", { class: "attn" });
    items.forEach((x) => list.append(attentionItem(x.application, x.long, x.tone)));
    if (!items.length) list.append(emptyNote("Nothing here."));
    return panel(cls, ic, title, items.length, null, list);
  };
  return h("div", {},
    h("div", { class: "head" }, h("div", {}, h("h1", { class: "title", text: "Reminders" }), h("span", { class: "muted", text: "Worked out from your dates, never stored separately." })), toolbar()),
    h("div", { class: "stack" },
      group("p-salmon", "bell", "Follow-ups due", groups.follow),
      group("p-butter", "send", "Deadlines", groups.deadline),
      group("p-blue", "rows", "Gone quiet", groups.quiet),
      peoplePanel(people)));
}

/** People whose follow-up date has come (or is coming up): the same kind of nudge as an application's. */
function peoplePanel(people) {
  const list = h("div", { class: "attn" });
  for (const x of people) {
    const text = x.daysOverdue > 0 ? `${x.daysOverdue}d overdue` : x.daysOverdue === 0 ? "Due today" : `In ${-x.daysOverdue}d`;
    list.append(h("button", { class: "attn-item", type: "button", onclick: (e) => ctx.openPerson(x.contact.id, e.currentTarget) }, logo(x.contact.name),
      h("span", { class: "who" }, h("b", { text: x.contact.name }), h("small", { text: [x.contact.title, x.contact.company].filter(Boolean).join(" at ") || x.contact.relationship })),
      h("span", { class: `tag ${x.daysOverdue > 0 ? "crit" : "warn"}`, text })));
  }
  if (!people.length) list.append(emptyNote("No one to follow up with."));
  return panel("p-salmon", "person", "People to follow up", people.length, null, list);
}
