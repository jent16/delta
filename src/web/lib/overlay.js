// The drawer and the "new application" form are both overlays: they sit above the page, dim it, trap the
// keyboard inside themselves, and give focus back to whatever opened them when they close.
//
// Motion: the form grows out of the button that opened it and shrinks back into it; the drawer slides in
// from the edge. Exits are 20% shorter than entrances. If you reopen something while it is still leaving,
// the exit is cancelled and it simply comes back.

import { $ } from "./dom.js";
import { cancelMotion, fade, hideWith, popIn, popOut, slideIn, slideOut } from "./motion.js";
import { DURATION } from "./motion-math.js";
import { closeMenu } from "./ui.js";

let opener = null;
const closeHooks = new Map(); // panel id -> function to run just before that panel starts closing
const panels = () => [$("#drawer"), $("#modal")];
export const overlayIsOpen = () => panels().some((p) => !p.hidden && p._leaving == null);

/** Let a panel do something as it begins to close (the drawer flies its logo back to the row). */
export function onClosing(panelId, fn) { closeHooks.set(panelId, fn); }

/** Shows `panel`. Returns true when it was newly opened (false when it was already open and is just being redrawn). */
export function openOverlay(panel, focusTarget) {
  closeMenu();
  const wasOpen = overlayIsOpen();
  if (!wasOpen) opener = document.activeElement;
  for (const p of panels()) if (p !== panel && !p.hidden) { cancelMotion(p); p.hidden = true; }

  const newlyOpened = panel.hidden || panel._leaving != null;
  const scrim = $("#scrim");
  if (scrim.hidden || scrim._leaving != null) { cancelMotion(scrim); scrim.hidden = false; fade(scrim, 1, panel.id === "drawer" ? DURATION.drawer : DURATION.modal); }
  if (newlyOpened) {
    cancelMotion(panel);
    panel.style.transform = ""; // never inherit a leftover drag offset from the last time
    panel._dragX = 0;
    scrim.style.opacity = "";
    panel.hidden = false;
    if (panel.id === "drawer") slideIn(panel, { x: 32, duration: DURATION.drawer });
    else popIn(panel, opener, DURATION.modal);
  }
  focusTarget?.focus();
  return newlyOpened;
}

export function closeOverlays() {
  const open = panels().find((p) => !p.hidden && p._leaving == null);
  closeMenu();
  if (!open) return Promise.resolve();
  closeHooks.get(open.id)?.();
  const to = opener;
  opener = null;
  if (to && document.contains(to)) to.focus({ preventScroll: true });
  const scrim = $("#scrim");
  const duration = open.id === "drawer" ? DURATION.drawer : DURATION.modal;
  open.inert = true;
  return Promise.all([
    hideWith(open, () => {
      if (open.id !== "drawer") return popOut(open, to, duration);
      const dragged = open._dragX ?? 0; // if it was dragged away, carry on from where the hand let go
      open._dragX = 0;
      return slideOut(open, { x: Math.max(32, dragged + 32), duration, from: dragged ? `translateX(${dragged}px)` : "none" });
    }).then(() => { open.inert = false; open.style.transform = ""; open.classList.remove("wide"); }), // a wide dialog must not make the next one wide
    hideWith(scrim, () => fade(scrim, 0, duration)).then(() => { scrim.style.opacity = ""; }),
  ]);
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
