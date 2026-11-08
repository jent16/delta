// The drawer and the "new application" form are both overlays: they sit above the page, dim it, trap the
// keyboard inside themselves, and give focus back to whatever opened them when they close.

import { $ } from "./dom.js";
import { closeMenu } from "./ui.js";

let opener = null;
const panels = () => [$("#drawer"), $("#modal")];
export const overlayIsOpen = () => panels().some((p) => !p.hidden);

export function openOverlay(panel, focusTarget) {
  closeMenu();
  if (!overlayIsOpen()) opener = document.activeElement; // remember who to hand focus back to
  for (const p of panels()) p.hidden = p !== panel;
  $("#scrim").hidden = false;
  focusTarget?.focus();
}

export function closeOverlays() {
  for (const p of panels()) p.hidden = true;
  $("#scrim").hidden = true;
  closeMenu();
  if (opener && document.contains(opener)) opener.focus();
  opener = null;
}

$("#scrim").addEventListener("click", closeOverlays);

// keep Tab inside the open overlay
document.addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  const panel = panels().find((p) => !p.hidden);
  if (!panel) return;
  const items = [...panel.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter((el) => !el.disabled && !el.closest("[hidden]"));
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  else if (!panel.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
});
