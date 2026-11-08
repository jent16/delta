// Small pieces that several screens share: the status chip, the progress bar, company logos,
// the toast, and the pop-up menu.

import { $, clear, h, icon } from "./dom.js";
import { DURATION } from "./motion-math.js";
import { cancelMotion, hideWith, popIn, popOut, slideIn, slideOut } from "./motion.js";
import { label, vocab } from "./state.js";

// ---- company "logo": the first letter on a colour chosen from the name (the same name is always the same colour) ----
const LOGO_COLORS = ["#0A6C74", "#2F6FED", "#7C55E0", "#C2603A", "#1E8E55", "#B7791F", "#B8467A", "#4A5F8A"];
export function logo(name) {
  let n = 0;
  for (const ch of name) n += ch.charCodeAt(0);
  return h("span", { class: "logo", text: (name.trim()[0] ?? "?").toUpperCase(), vars: { "--lg": LOGO_COLORS[n % LOGO_COLORS.length] } });
}

/** A status pill. Give it a handler and it becomes a button that opens the "move to" menu. */
export function chip(status, onclick) {
  const el = h(onclick ? "button" : "span", { class: "chip", text: label(status), onclick, type: onclick ? "button" : undefined });
  el.dataset.s = status;
  if (onclick) { el.setAttribute("aria-haspopup", "menu"); el.setAttribute("title", "Change status"); }
  return el;
}

/** Four segments; the filled ones are the furthest stage ever reached. How it ended is shown beside it. */
export function progressBar(progress, large = false) {
  const { level, outcome } = progress;
  const stages = vocab.progressStages;
  const el = h("span", {
    class: `prog${outcome ? ` ended-${outcome}` : ""}${large ? " lg" : ""}`,
    title: (level ? `Reached: ${stages[level - 1]}` : "Not applied yet") + (outcome ? ` · ended: ${label(outcome)}` : ""),
  });
  for (let i = 1; i <= stages.length; i++) el.append(h("i", { class: i <= level ? "on" : "" }));
  if (outcome && !large) el.append(h("span", { class: "end", text: outcome === "rejected" ? "✕" : outcome === "ghosted" ? "…" : "–" }));
  return el;
}

// ---- toast ----
let toastTimer;
export function toast(message, bad = false) {
  const el = $("#toast");
  el.textContent = message;
  el.className = `toast${bad ? " bad" : ""}`;
  el.hidden = false;
  cancelMotion(el);
  slideIn(el, { y: 12, duration: DURATION.toast });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hideWith(el, () => slideOut(el, { y: 12, duration: DURATION.toast })), bad ? 6000 : 3200); // an error stays long enough to read
}

// ---- pop-up menu (the status "move to" list, set-sector, appearance) ----
let openMenuEl = null;
export const menuIsOpen = () => openMenuEl !== null;
/** Closes the open menu. It shrinks back into the thing that opened it, unless `immediate` (used when replacing one menu with another). */
export function closeMenu({ immediate = false } = {}) {
  const el = openMenuEl;
  if (!el) return;
  openMenuEl = null;
  if (immediate) { el.remove(); return; }
  el.inert = true; // no more clicks while it leaves
  popOut(el, el._anchor).then(() => el.remove());
}
document.addEventListener("click", (e) => { if (openMenuEl && !openMenuEl.contains(e.target)) closeMenu(); });

/** items: [{ status } | { label, checked?, run }]. A "group" item is a small heading. */
export function openMenu(anchor, title, items) {
  closeMenu({ immediate: true });
  const menu = h("div", { class: "menu", role: "menu" });
  if (title) menu.append(h("div", { class: "hd", text: title }));
  for (const item of items) {
    if (item.heading) { menu.append(h("div", { class: "hd", text: item.heading })); continue; }
    const button = h("button", { type: "button", role: item.checked === undefined ? "menuitem" : "menuitemradio", "aria-checked": item.checked === undefined ? undefined : String(item.checked),
      onclick: (e) => { e.stopPropagation(); closeMenu(); item.run(); } });
    if (item.checked !== undefined) button.append(h("span", { class: "tick" }, item.checked ? icon("check", 14) : null));
    button.append(item.status ? chip(item.status) : item.label);
    menu.append(button);
  }
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - menu.offsetWidth - 12))}px`;
  let top = r.bottom + 6;
  if (top + menu.offsetHeight > window.innerHeight - 12) top = Math.max(12, r.top - menu.offsetHeight - 6);
  menu.style.top = `${top}px`;
  menu._anchor = anchor;
  openMenuEl = menu;
  popIn(menu, anchor); // grows from the button that opened it
  menu.querySelector("button")?.focus();
}

/** A friendly line for a list that has nothing in it. */
export const emptyNote = (text) => h("div", { class: "empty", text });

/** Replace a container's content with a message (loading, or an error with a Retry button). */
export function showMessage(container, text, { error = false, retry } = {}) {
  clear(container).append(h("div", { class: `state-msg${error ? " err" : ""}`, role: error ? "alert" : "status" },
    text, retry ? h("div", {}, h("button", { class: "btn", type: "button", onclick: retry, text: "Try again" })) : null));
}
