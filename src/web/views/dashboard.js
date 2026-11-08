// The overview: four headline numbers, how far applications get, what needs attention, and a week-by-week chart.
// Every figure comes from the server (/api/stats, /api/reminders); this file only lays them out.

import { api } from "../lib/api.js";
import { h } from "../lib/dom.js";
import { ctx } from "../lib/ctx.js";
import { addDays, longToday, plural, shortDate, today, weekStart } from "../lib/format.js";
import { emptyNote } from "../lib/ui.js";
import { attentionGroups, attentionItem, panel, tile } from "./parts.js";
import { toolbar } from "./toolbar.js";

const WEEKS_SHOWN = 12;

export async function dashboardView() {
  const [lists, all, reminders] = await Promise.all([api.lists(), api.stats(), api.reminders()]);
  const perList = await Promise.all(lists.map((l) => api.stats(l.id)));
  const s = all.stats;
  const now = today();

  const sent = s.funnel.applied;
  const inFlight = s.byStatus.applied + s.byStatus.assessment + s.byStatus.interview;
  const rate = s.response.rate === null ? 0 : Math.round(s.response.rate * 100);

  const view = h("div", {});
  view.append(h("div", { class: "head" },
    h("div", {}, h("div", { class: "eyebrow", text: longToday(now) }), h("h1", { class: "greeting", text: "Welcome back" })),
    toolbar()));

  view.append(h("div", { class: "tiles" },
    tile("t-salmon", "send", "Sent", sent, `${inFlight} still in flight`),
    tile("t-butter", "reply", "Responses", s.response.responded, `${rate}% of applications heard back`),
    tile("t-pink", "users", "Interviews", s.funnel.interview, "reached at least one round"),
    tile("t-blue", "star", "Offers", s.funnel.offer, s.funnel.offer ? "in hand. Decide by the deadline." : "keep going")));

  // ---- how far applications get ----
  const funnel = h("div", { class: "funnel" });
  [["Applied", s.funnel.applied, "var(--h-applied)"], ["Assessment", s.funnel.assessment, "var(--h-assessment)"], ["Interview", s.funnel.interview, "var(--h-interview)"], ["Offer", s.funnel.offer, "var(--h-offer)"]]
    .forEach(([name, n, color]) => {
      const pct = sent ? Math.round((n / sent) * 100) : 0;
      funnel.append(h("div", { class: "card f-row" }, h("div", { class: "f-label", text: name }),
        h("div", { class: "f-track" }, h("div", { class: "f-fill", "data-reveal": "x", vars: { "--c": color, width: `${pct}%` } })),
        h("div", { class: "f-val" }, String(n), h("span", { text: ` · ${pct}%` }))));
    });
  const median = s.daysToFirstResponse.median;
  const waitCard = h("div", { class: "card wait" }, h("span", { class: "wl", text: "Median wait for a reply" }),
    h("span", { class: "wv" }, median === null ? "–" : plural(median, "day"), h("small", { text: ` · from ${plural(s.daysToFirstResponse.samples, "reply", "replies")}` })));
  const p1 = panel("p-blue", "rows", "How far applications get", null, null, funnel, waitCard,
    h("p", { class: "panel-note", text: "Each bar counts everything that got at least this far. Skipping a stage still counts: Applied straight to Interview means it got past the assessment." }));

  // ---- needs attention (top five; the full list is on the Reminders screen) ----
  const groups = attentionGroups(reminders.reminders);
  const attention = h("div", { class: "attn" });
  [...groups.follow, ...groups.deadline, ...groups.quiet].slice(0, 5).forEach((x) => attention.append(attentionItem(x.application, x.text, x.tone)));
  const totalAttention = groups.follow.length + groups.deadline.length + groups.quiet.length;
  if (!totalAttention) attention.append(emptyNote("Nothing needs you right now."));
  const p2 = panel("p-salmon", "bell", "Needs attention", totalAttention, () => ctx.navigate("reminders"), attention);
  view.append(h("div", { class: "grid-2" }, p1, p2));

  // ---- sent per week ----
  const counts = new Map(s.appliedByWeek.map((w) => [w.weekStart, w.count]));
  const thisWeek = weekStart(now);
  const weeks = Array.from({ length: WEEKS_SHOWN }, (_, i) => addDays(thisWeek, -7 * (WEEKS_SHOWN - 1 - i)));
  const shown = weeks.reduce((sum, w) => sum + (counts.get(w) ?? 0), 0);
  const max = Math.max(1, ...weeks.map((w) => counts.get(w) ?? 0));
  const bars = h("div", { class: "bars", vars: { "--n": String(weeks.length) } });
  const labels = h("div", { class: "xlabels", vars: { "--n": String(weeks.length) } });
  weeks.forEach((w, i) => {
    const n = counts.get(w) ?? 0;
    bars.append(h("div", { class: `bar${i === weeks.length - 1 ? " now" : ""}${n ? "" : " zero"}`, title: `Week of ${shortDate(w)}: ${n} sent` },
      h("b", { text: String(n) }), h("i", { "data-reveal": "y", vars: { height: `${Math.round((n / max) * 100)}%` } })));
    labels.append(h("span", { text: i % 2 === 0 ? shortDate(w) : "" }));
  });
  const earlier = sent - shown;
  const p3 = panel("p-butter", "send", "Applications sent per week", sent, null, h("div", { class: "card" }, bars, labels),
    h("p", { class: "panel-note", text: `Last ${WEEKS_SHOWN} weeks. Weeks start Monday.${earlier > 0 ? ` ${earlier} more were sent before that.` : ""}` }));

  // ---- by list ----
  const rows = h("div", { class: "listrows" }, h("div", { class: "lr-head" }, h("span", { text: "List" }), h("span", { text: "Sent" }), h("span", { text: "Heard back" }), h("span", { text: "Interviews" })));
  const entry = (name, st, listId) => {
    const heard = st.funnel.applied ? `${Math.round((st.response.responded / st.funnel.applied) * 100)}%` : "–";
    rows.append(h("button", { class: "lr", type: "button", onclick: () => ctx.navigate("applications", listId) },
      h("b", { text: name }), h("span", { text: String(st.funnel.applied) }), h("span", { text: heard }), h("span", { text: String(st.funnel.interview) })));
  };
  entry("All applications", s, "all");
  lists.forEach((l, i) => entry(l.name, perList[i].stats, String(l.id)));
  const p4 = panel("", "grid", "By list", lists.length + 1, null, rows, h("p", { class: "panel-note", text: "A list is a saved filter, not a folder. Click one to open it." }));
  view.append(h("div", { class: "grid-2" }, p3, p4));
  return view;
}
