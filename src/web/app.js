// Start-up and the frame around every screen: the top bar, which screen is showing, and the keyboard shortcuts.
// Screens live in views/. Shared pieces live in lib/. Nothing in those folders imports this file.

import { api, describeError, whenSignedOut } from "./lib/api.js";
import { $, clear, h, icon } from "./lib/dom.js";
import { ctx } from "./lib/ctx.js";
import { crossfade, placeKnobs, reduced, reveal, revealColor, staggerIn } from "./lib/motion.js";
import { DURATION, STAGGER } from "./lib/motion-math.js";
import { closeOverlays, overlayIsOpen } from "./lib/overlay.js";
import { resetState, setVocab, state } from "./lib/state.js";
import { applyLook, DESIGNS, look, MODES, setLook } from "./lib/theme.js";
import { closeMenu, menuIsOpen, openMenu, showMessage } from "./lib/ui.js";
import { applicationsView, leaveApplications } from "./views/applications.js";
import { showAuth } from "./views/auth.js";
import { showWelcome } from "./views/welcome.js";
import { profileView } from "./views/profile.js";
import { companiesLeave, companiesView } from "./views/companies.js";
import { dashboardView } from "./views/dashboard.js";
import { insightsView } from "./views/insights.js";
import { openDrawer } from "./views/drawer.js";
import { openNewApplication } from "./views/new-application.js";
import { openNewPerson, openPerson } from "./views/person.js";
import { peopleLeave, peopleView } from "./views/people.js";
import { remindersView } from "./views/reminders.js";

const SCREENS = { dashboard: dashboardView, applications: applicationsView, companies: companiesView, people: peopleView, insights: insightsView, reminders: remindersView, profile: profileView };

let badgeCount = 0;
let renderToken = 0;

// ---------- the top bar ----------
function renderTop() {
  const brand = h("div", { class: "brand" }, h("span", { class: "brand-mark" }, icon("delta", 16)), "Delta");
  if (!state.account) { clear($("#topbar")).append(brand); return; } // signed out: nothing but the name
  const nav = (ic, name, view) => h("button", { class: "nav-item", type: "button", "aria-current": state.view === view ? "page" : null, onclick: () => navigate(view, view === "applications" ? "all" : undefined) },
    icon(ic, 15), name, view === "reminders" ? h("span", { class: "badge", id: "badge", text: String(badgeCount), hidden: badgeCount === 0 }) : null);
  clear($("#topbar")).append(
    brand,
    h("nav", { class: "nav", "aria-label": "Main", "data-knob": "nav" }, nav("grid", "Dashboard", "dashboard"), nav("rows", "Applications", "applications"), nav("building", "Companies", "companies"), nav("person", "People", "people"), nav("chart", "Insights", "insights"), nav("bell", "Reminders", "reminders")),
    h("button", { class: "btn small appearance", type: "button", "aria-haspopup": "menu", "aria-label": "Appearance: mode and design", onclick: (e) => { e.stopPropagation(); appearanceMenu(e.currentTarget); } }, icon("palette", 15), "Appearance"),
    h("button", { class: "btn small account-btn", type: "button", "aria-haspopup": "menu", "aria-label": `Account: ${state.account.name}`, "aria-current": state.view === "profile" ? "page" : null, onclick: (e) => { e.stopPropagation(); accountMenu(e.currentTarget); } },
      h("span", { class: "avatar", text: (state.account.name.trim()[0] ?? "?").toUpperCase(), "aria-hidden": "true" }), h("span", { class: "acct-name", text: state.account.name })));
}

function accountMenu(anchor) {
  openMenu(anchor, state.account.email, [
    { label: "Profile", run: () => navigate("profile") },
    { label: "Sign out", run: async () => { try { await api.signOut(); } catch { /* back to sign-in either way */ } signedOut(); } },
  ]);
}

function appearanceMenu(anchor) {
  const choose = (key, value) => () => revealColor(anchor, () => setLook(key, value)); // the new colours spread out from the button
  openMenu(anchor, null, [
    { heading: "Mode" }, ...MODES.map(([value, name]) => ({ label: name, checked: look.mode === value, run: choose("mode", value) })),
    { heading: "Design" }, ...DESIGNS.map(([value, name]) => ({ label: name, checked: look.design === value, run: choose("design", value) })),
  ]);
}

// the red number on "Reminders": follow-ups due plus deadlines close; fetched on its own so a slow screen doesn't hold it up
async function refreshBadge() {
  try {
    const { reminders } = await api.reminders();
    badgeCount = reminders.followUps.length + reminders.deadlines.length + (reminders.contactFollowUps?.length ?? 0);
    const el = $("#badge");
    if (el) { el.textContent = String(badgeCount); el.hidden = badgeCount === 0; }
  } catch { /* the badge is a nicety; the screens report their own errors */ }
}

// ---------- screens ----------
// mode: "none"  a refresh after a change: swap in place, no animation (it would flicker)
//       "swap"  a tab change within a screen: old and new overlap briefly
//       "enter" a different screen: old and new overlap, and the new content arrives piece by piece
async function render(mode = "none") {
  const token = ++renderToken; // if you click around quickly, only the newest request is allowed to draw
  renderTop();
  placeKnobs($("#topbar"));
  const container = $("#view");
  if (state.view !== "applications") leaveApplications();
  if (state.view !== "companies") companiesLeave();
  if (state.view !== "people") peopleLeave();
  if (!container.firstChild) showMessage(container, "Loading…");
  try {
    const node = await SCREENS[state.view]();
    if (token !== renderToken) return;
    const hadContent = container.firstChild && !container.querySelector(":scope > .state-msg");
    if (mode === "none" || !hadContent || reduced()) clear(container).append(node);
    else crossfade(container, () => container.append(node), { duration: mode === "enter" ? DURATION.screen : DURATION.swap });
    placeKnobs(container);
    if (mode === "enter" || !hadContent) playEntrance(node);
  } catch (e) {
    if (token !== renderToken) return;
    showMessage(container, describeError(e), { error: true, retry: () => render() });
  }
  refreshBadge();
}

/** A screen arrives piece by piece (30 ms apart, only the first few), and bars and fills are uncovered by a mask. */
function playEntrance(node) {
  staggerIn(node.querySelectorAll(":scope > .head, .tiles > .tile, .grid-2 > .panel, .stack > .panel, .seg, .chips, .tablewrap tbody tr"));
  node.querySelectorAll("[data-reveal]").forEach((el, i) => reveal(el, el.dataset.reveal, { delay: 180 + Math.min(i, STAGGER.max) * STAGGER.step }));
}

function navigate(view, list) {
  const mode = view !== state.view ? "enter" : list !== undefined && list !== state.list ? "swap" : "none";
  if (view !== state.view || list !== undefined) state.selected.clear();
  state.view = view;
  if (list !== undefined) state.list = list;
  if (location.hash.slice(1) !== view) history.replaceState(null, "", `#${view}`);
  return render(mode);
}

ctx.refresh = (mode) => render(mode);
ctx.navigate = navigate;
ctx.openApplication = openDrawer;
ctx.openNew = openNewApplication;
ctx.openPerson = openPerson;
ctx.openNewPerson = openNewPerson;

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
  if (state.account && view in SCREENS && view !== state.view) navigate(view);
});

// ---------- signing in and out ----------
/** What a signed-out visitor sees: the welcome page, then the sign-in / sign-up card (with a way back). */
function showSignedOut(info) {
  const welcome = () => showWelcome(info, (mode) => showAuth(info, async (account) => { state.account = account; await boot(); }, { mode, onBack: welcome }));
  welcome();
}
let leaving = false;
/** Back to the sign-in page, forgetting everything about whoever was here. (Called after sign-out, account deletion, or the session ending.) */
async function signedOut() {
  if (leaving) return;
  leaving = true;
  try {
    renderToken++; // anything still loading for the old screen is thrown away
    closeOverlays();
    closeMenu();
    resetState();
    leaveApplications(); companiesLeave(); peopleLeave();
    clear($("#bulk")).hidden = true;
    renderTop();
    const info = await api.authState().catch(() => ({ account: null, canSignUp: true, claimsExistingData: false }));
    if (info.account) { state.account = info.account; await boot(); } // still signed in after all (e.g. the 401 was a blip)
    else showSignedOut(info);
  } finally { leaving = false; }
}
ctx.signedOut = signedOut;
whenSignedOut(() => { if (state.account) signedOut(); });

async function boot() {
  const start = location.hash.slice(1);
  state.view = start in SCREENS ? start : "dashboard";
  renderTop();
  try {
    setVocab(await api.vocab()); // the status rules and closed lists come from the server, so they can never disagree with it
    clear($("#view"));
    await render("enter");
  } catch (e) {
    showMessage($("#view"), describeError(e), { error: true, retry: () => location.reload() });
  }
}

// ---------- start ----------
applyLook();
renderTop();
try {
  const info = await api.authState();
  if (info.account) { state.account = info.account; await boot(); }
  else showSignedOut(info);
} catch (e) {
  showMessage($("#view"), describeError(e), { error: true, retry: () => location.reload() });
}
