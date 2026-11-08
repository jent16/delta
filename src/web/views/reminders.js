// Everything that needs a nudge, worked out from your dates. Nothing here is stored separately.

import { api } from "../lib/api.js";
import { h } from "../lib/dom.js";
import { emptyNote } from "../lib/ui.js";
import { attentionGroups, attentionItem, panel } from "./parts.js";
import { toolbar } from "./toolbar.js";

export async function remindersView() {
  const { reminders } = await api.reminders();
  const groups = attentionGroups(reminders);
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
      group("p-blue", "rows", "Gone quiet", groups.quiet)));
}
