// The search box and "New application" button at the top right of every screen.

import { $, h, icon } from "../lib/dom.js";
import { ctx } from "../lib/ctx.js";
import { state } from "../lib/state.js";

// the Applications screen registers a function here so typing filters the table without reloading it
export const table = { rerender: null };

export function toolbar() {
  const input = h("input", { id: "q", type: "search", placeholder: "Search companies and roles", "aria-label": "Search applications", autocomplete: "off", value: state.query,
    oninput: (e) => {
      state.query = e.target.value;
      if (state.view === "applications" && table.rerender) { table.rerender(); return; }
      // typing from another screen jumps to the table, keeping the cursor where it was
      ctx.navigate("applications").then(() => { const q = $("#q"); q.focus(); q.setSelectionRange(q.value.length, q.value.length); });
    } });
  return h("div", { class: "toolbar" },
    h("div", { class: "search" }, icon("search", 15), input, h("span", { class: "kbd", text: "/" })),
    h("button", { class: "btn primary", type: "button", onclick: () => ctx.openNew() }, icon("plus", 15), "New application"));
}
