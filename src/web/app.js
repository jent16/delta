// Start-up and the frame around every screen: the top bar, which screen is showing, and the keyboard shortcuts.
// Screens live in views/. Shared pieces live in lib/. Nothing in those folders imports this file.

import { api, describeError } from "./lib/api.js";
import { $, clear, h, icon } from "./lib/dom.js";
import { ctx } from "./lib/ctx.js";
import { closeOverlays, overlayIsOpen } from "./lib/overlay.js";
import { setVocab, state } from "./lib/state.js";
import { applyLook, DESIGNS, look, MODES, setLook } from "./lib/theme.js";
import { closeMenu, menuIsOpen, openMenu, showMessage } from "./lib/ui.js";
import { applicationsView, leaveApplications } from "./views/applications.js";
import { dashboardView } from "./views/dashboard.js";
import { openDrawer } from "./views/drawer.js";
import { openNewApplication } from "./views/new-application.js";
import { remindersView } from "./views/reminders.js";

const SCREENS = { dashboard: dashboardView, applications: applicationsView, reminders: remindersView };

let badgeCount = 0;
let renderToken = 0;

// ---------- the top bar ----------
function renderTop() {
  const nav = (ic, name, view) => h("button", { class: "nav-item", type: "button", "aria-current": state.view === view ? "page" : null, onclick: () => navigate(view, view === "applications" ? "all" : undefined) },
    icon(ic, 15), name, view === "reminders" ? h("span", { class: "badge", id: "badge", text: String(badgeCount), hidden: badgeCount === 0 }) : null);
  clear($("#topbar")).append(
    h("div", { class: "brand" }, h("span", { class: "brand-mark" }, icon("delta", 16)), "Delta"),
    h("nav", { class: "nav", "aria-label": "Main" }, nav("grid", "Dashboard", "dashboard"), nav("rows", "Applications", "applications"), nav("bell", "Reminders", "reminders")),
    h("button", { class: "btn small appearance", type: "button", "aria-haspopup": "menu", "aria-label": "Appearance: mode and design", onclick: (e) => { e.stopPropagation(); appearanceMenu(e.currentTarget); } }, icon("palette", 15), "Appearance"));
}

function appearanceMenu(anchor) {
  openMenu(anchor, null, [
    { heading: "Mode" }, ...MODES.map(([value, name]) => ({ label: name, checked: look.mode === value, run: () => setLook("mode", value) })),
    { heading: "Design" }, ...DESIGNS.map(([value, name]) => ({ label: name, checked: look.design === value, run: () => setLook("design", value) })),
  ]);
}

// the red number on "Reminders": follow-ups due plus deadlines close; fetched on its own so a slow screen doesn't hold it up
async function refreshBadge() {
  try {
    const { reminders } = await api.reminders();
    badgeCount = reminders.followUps.length + reminders.deadlines.length;
    const el = $("#badge");
    if (el) { el.textContent = String(badgeCount); el.hidden = badgeCount === 0; }
  } catch { /* the badge is a nicety; the screens report their own errors */ }
}

// ---------- screens ----------
async function render() {
  const token = ++renderToken; // if you click around quickly, only the newest request is allowed to draw
  renderTop();
  const container = $("#view");
  if (state.view !== "applications") leaveApplications();
  if (!container.firstChild) showMessage(container, "Loading…");
  try {
    const node = await SCREENS[state.view]();
    if (token !== renderToken) return;
    clear(container).append(node);
  } catch (e) {
    if (token !== renderToken) return;
    showMessage(container, describeError(e), { error: true, retry: render });
  }
  refreshBadge();
}

function navigate(view, list) {
  if (view !== state.view || list !== undefined) state.selected.clear();
  state.view = view;
  if (list !== undefined) state.list = list;
  if (location.hash.slice(1) !== view) history.replaceState(null, "", `#${view}`);
  return render();
}

ctx.refresh = render;
ctx.navigate = navigate;
ctx.openApplication = openDrawer;
ctx.openNew = openNewApplication;

// ---------- keyboard ----------
document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "");
  if (e.key === "Escape") {
    if (menuIsOpen()) closeMenu();
    else if (overlayIsOpen()) closeOverlays();
  } else if (e.key === "/" && !typing && !overlayIsOpen()) {
    e.preventDefault();
    $("#q")?.focus();
  }
});
window.addEventListener("hashchange", () => {
  const view = location.hash.slice(1);
  if (view in SCREENS && view !== state.view) navigate(view);
});

// ---------- start ----------
applyLook();
const start = location.hash.slice(1);
if (start in SCREENS) state.view = start;
renderTop();
try {
  setVocab(await api.vocab()); // the status rules and closed lists come from the server, so they can never disagree with it
  await render();
} catch (e) {
  showMessage($("#view"), describeError(e), { error: true, retry: () => location.reload() });
}
