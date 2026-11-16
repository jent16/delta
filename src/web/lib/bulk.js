// The floating bar for "these rows are ticked": Applications, Companies and Interested all use it.
// A screen calls `renderBulkBar` whenever its ticks change; the bar rises when something is ticked and sinks away
// (a little quicker than it rose) when nothing is.

import { $, clear, h, icon } from "./dom.js";
import { cancelMotion, hideWith, slideIn, slideOut } from "./motion.js";
import { DURATION } from "./motion-math.js";

/** Gone at once, no animation: for when the screen itself is leaving. */
export function hideBulk() {
  const el = $("#bulk");
  cancelMotion(el);
  el.hidden = true;
  clear(el);
}

/** `buttons` are the screen's own actions (already built); `onClear` unticks everything. */
export function renderBulkBar({ count, buttons = [], onClear }) {
  const el = $("#bulk");
  if (!count) {
    if (!el.hidden && el._leaving == null) hideWith(el, () => slideOut(el, { y: 16, duration: DURATION.toast }));
    return;
  }
  clear(el);
  el.className = "bulk";
  el.append(h("b", { text: `${count} selected` }), ...buttons,
    h("button", { class: "iconbtn", type: "button", "aria-label": "Clear selection", onclick: onClear }, icon("x", 15)));
  if (el.hidden || el._leaving != null) { cancelMotion(el); el.hidden = false; slideIn(el, { y: 16, duration: DURATION.toast }); }
}

/** A short list of names for a confirmation: "Stripe, Ramp, Figma and 2 more". */
export function nameList(names, show = 3) {
  const shown = names.slice(0, show).join(", ");
  return names.length > show ? `${shown} and ${names.length - show} more` : shown;
}
