// Building blocks the dashboard and reminders screens share.

import { h, icon } from "../lib/dom.js";
import { ctx } from "../lib/ctx.js";
import { logo } from "../lib/ui.js";

export function tile(cls, ic, name, number, caption) {
  return h("div", { class: `tile ${cls}` },
    h("div", { class: "tile-top" }, icon(ic, 18), h("span", { class: "label", text: name })),
    h("div", {}, h("div", { class: "num", text: String(number) }), h("div", { class: "cap", text: caption })));
}

export function panel(cls, ic, title, count, viewAll, ...kids) {
  return h("section", { class: `panel ${cls}` },
    h("div", { class: "ph" }, icon(ic, 16), h("h2", { text: title }), count != null ? h("span", { class: "cnt", text: String(count) }) : null,
      viewAll ? h("button", { class: "all", type: "button", onclick: viewAll, text: "View all" }) : null),
    kids);
}

export function attentionItem(application, tagText, tone) {
  return h("button", { class: "attn-item", type: "button", "data-app-id": String(application.id), onclick: (e) => ctx.openApplication(application.id, e.currentTarget) },
    logo(application.company),
    h("span", { class: "who" }, h("b", { text: application.company }), h("small", { text: application.roleTitle })),
    h("span", { class: `tag ${tone}`, text: tagText }));
}

/** Turns the server's reminders into the three labelled groups both screens show. */
export function attentionGroups(reminders) {
  return {
    follow: reminders.followUps.map((f) => ({
      application: f.application,
      text: f.daysOverdue > 0 ? `Follow up · ${f.daysOverdue}d overdue` : f.daysOverdue === 0 ? "Follow up today" : `Follow up in ${-f.daysOverdue}d`,
      long: f.daysOverdue > 0 ? `${f.daysOverdue}d overdue` : f.daysOverdue === 0 ? "Due today" : `In ${-f.daysOverdue}d`,
      tone: f.daysOverdue > 0 ? "crit" : "warn",
    })),
    deadline: reminders.deadlines.map((d) => ({
      application: d.application,
      text: d.daysLeft < 0 ? "Deadline passed" : d.daysLeft === 0 ? "Deadline today" : `Deadline in ${d.daysLeft}d`,
      long: d.daysLeft < 0 ? "Passed" : d.daysLeft === 0 ? "Today" : `In ${d.daysLeft}d`,
      tone: d.daysLeft <= 1 ? "crit" : "warn",
    })),
    quiet: reminders.stale.map((s) => ({ application: s.application, text: `Quiet for ${s.daysSince}d`, long: `${s.daysSince}d quiet`, tone: "quiet" })),
  };
}
