// The detail panel for one application: its status and legal next moves, the editable details,
// the dated history, notes, and archive. Every change goes to the server first; the screen then
// shows what the server says, so what you see is always what is stored.

import { api, describeError } from "../lib/api.js";
import { $, clear, h, icon } from "../lib/dom.js";
import { ctx } from "../lib/ctx.js";
import { shortDate } from "../lib/format.js";
import { cancelMotion, crossfade, flyBetween, reduced, settle, staggerIn } from "../lib/motion.js";
import { DURATION, exitDuration, rubberBand } from "../lib/motion-math.js";
import { closeOverlays, onClosing, openOverlay } from "../lib/overlay.js";
import { label, movesFrom, vocab } from "../lib/state.js";
import { chip, logo, progressBar, toast } from "../lib/ui.js";

let currentId = null;

// the logo in the table row (or attention card) that was clicked, so it can fly into the panel
const logoNear = (from) => from?.closest?.("tr, .attn-item")?.querySelector(".logo") ?? from?.querySelector?.(".logo") ?? null;
const logoForApp = (id) => document.querySelector(`[data-app-id="${id}"] .logo`);
const onScreen = (el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth; };

/** `from` is the element that was clicked (optional): the panel grows out of it. */
export async function openDrawer(id, from) {
  try {
    const detail = await api.application(id);
    draw(detail, from);
  } catch (e) {
    toast(describeError(e), true);
  }
}

// The fields you can change from here. Company, role and term are left alone on purpose:
// they define what counts as a duplicate, so they are not casually editable.
const FIELDS = [
  { key: "roleFunction", name: "Function", kind: "select", options: () => vocab.roleFunctions.map((f) => [f, f]) },
  { key: "sector", name: "Sector (the company's)", kind: "select", options: () => [["", "Not set"], ...vocab.sectors.map((s) => [s, s])], hint: (a) => `Shared by every ${a.company} application.`, wide: true },
  { key: "location", name: "Location", kind: "text" },
  { key: "term", name: "Term", kind: "text", placeholder: "e.g. Summer 2027" },
  { key: "followUpOn", name: "Follow up on", kind: "date" },
  { key: "deadlineOn", name: "Deadline", kind: "date" },
  { key: "url", name: "Link to the posting", kind: "url", wide: true, placeholder: "https://…" },
];

function draw({ application: a, events, progress }, from) {
  currentId = a.id;
  const drawer = clear($("#drawer"));
  const next = movesFrom(a.status);

  const refreshHere = async () => { await ctx.refresh(); openDrawer(a.id); }; // redrawn in place: old and new overlap
  const change = async (promise, message) => {
    try { await promise; toast(message); await refreshHere(); } catch (e) { toast(describeError(e), true); }
  };

  const moves = h("div", { class: "moves" });
  for (const s of next) {
    const c = chip(s, () => change(api.changeStatus(a.id, s), `${a.company} moved to ${label(s)}`));
    c.removeAttribute("aria-haspopup");
    c.setAttribute("title", `Move to ${label(s)}`);
    moves.append(c);
  }
  if (!next.length) moves.append(h("span", { class: "dim", text: `${label(a.status)} is final.` }));
  if (events.length > 1) moves.append(h("button", { class: "btn small", type: "button", text: "Undo last", onclick: () => change(api.undo(a.id), "Undid the last change") }));

  // history, newest first
  const timeline = h("ol", { class: "timeline" });
  for (const e of [...events].reverse()) {
    timeline.append(h("li", {}, h("span", { class: "pt", vars: { "--h": `var(--h-${e.status})` } }),
      h("div", {}, h("b", { text: label(e.status) }), e.note ? h("div", { class: "tl-note", text: e.note }) : null),
      h("span", { class: "date", text: shortDate(e.occurredOn) })));
  }

  // editable details: each field saves by itself when you leave it
  const grid = h("div", { class: "edit-grid" });
  for (const f of FIELDS) {
    const id = `d-${f.key}`;
    let stored = a[f.key] ?? ""; // what the server last confirmed; updated after each successful save
    const input = f.kind === "select"
      ? h("select", { id }, f.options().map(([value, text]) => h("option", { value, text, selected: value === stored })))
      : h("input", { id, type: f.kind, value: stored, placeholder: f.placeholder });
    input.addEventListener("change", async () => {
      const value = input.value.trim();
      if (value === stored) return;
      try {
        await api.edit(a.id, { [f.key]: value === "" ? null : value });
        stored = value;
        toast(f.key === "sector" ? `Sector saved for every ${a.company} application` : "Saved");
        await ctx.refresh();
      } catch (e) {
        input.value = stored; // put back what is actually stored
        toast(describeError(e), true);
      }
    });
    grid.append(h("div", { class: `field${f.wide ? " wide" : ""}` }, h("label", { for: id, text: f.name }), input, f.hint ? h("span", { class: "hint", text: f.hint(a) }) : null));
  }
  const firstApplied = events.find((e) => e.status === "applied");
  const appliedOn = a.appliedOn ?? firstApplied?.occurredOn ?? null;

  const notes = h("textarea", { "aria-label": "Notes", placeholder: "Recruiter names, questions to prepare, links…", value: a.notes });
  notes.addEventListener("change", async () => {
    try { await api.edit(a.id, { notes: notes.value }); toast("Notes saved"); } catch (e) { toast(describeError(e), true); }
  });

  const archive = async () => {
    try {
      await api.archive(a.id);
      closeOverlays();
      toast(`${a.company} archived. Your data is kept; it just leaves the lists.`);
      await ctx.refresh();
    } catch (e) { toast(describeError(e), true); }
  };

  const close = h("button", { class: "btn small closebtn", type: "button", "aria-label": "Close details", onclick: closeOverlays }, icon("x", 14), "Close");
  const head = h("div", { class: "drawer-head" },
    h("div", { class: "dh-top" }, close),
    h("div", { class: "dh-main" }, logo(a.company), h("div", { class: "drawer-title" }, h("h2", { text: a.company }), h("p", { text: a.roleTitle }))));
  const body = h("div", { class: "drawer-body" },
    h("div", { class: "sect" }, h("h3", { text: "Status" }),
      h("div", { class: "status-row" }, chip(a.status), h("div", {}, progressBar(progress, true), h("div", { class: "stage-names" }, vocab.progressStages.map((s) => h("span", { text: s }))))),
      next.length ? h("h3", { text: "Move to" }) : null, moves),
    h("div", { class: "sect" }, h("h3", { text: "Details" }), h("p", { class: "note-line", text: appliedOn ? `Applied ${shortDate(appliedOn)}.` : "Not applied yet." }), grid),
    h("div", { class: "sect" }, h("h3", { text: "History" }), timeline),
    h("div", { class: "sect" }, h("h3", { text: "Notes" }), notes),
    h("div", { class: "sect" }, h("button", { class: "btn small", type: "button", text: "Archive", onclick: archive })));

  const wasOpen = !drawer.hidden && drawer._leaving == null;
  const scrolled = drawer.querySelector(".drawer-body")?.scrollTop ?? 0;
  if (wasOpen) {
    crossfade(drawer, () => drawer.append(head, body)); // a redraw (after a status change): old and new share the screen for a moment
    body.scrollTop = scrolled;
  } else {
    clear(drawer).append(head, body);
  }
  const newlyOpened = openOverlay(drawer, close);
  if (newlyOpened) {
    // the logo in the row you clicked travels into the panel's header, and the details settle in one after another
    flyBetween(logoNear(from) ?? logoForApp(a.id), $(".drawer-head .logo", drawer));
    staggerIn(body.children, { base: 90 });
  }
  attachDrag(drawer, head);
}

// closing: the panel's logo travels back to its row (if that row is still on screen)
onClosing("drawer", () => {
  const mine = $(".drawer-head .logo", $("#drawer"));
  const row = currentId == null ? null : logoForApp(currentId);
  if (mine && row && onScreen(row)) flyBetween(mine, row, { duration: exitDuration(DURATION.move), hideTarget: false, hideSource: true });
});

// ---- drag the header to dismiss. While held it follows the hand exactly (no tweening); pulled the
// wrong way (past where it rests) it resists like a rubber band; let go and it either leaves or eases home.
function attachDrag(drawer, head) {
  let drag = null;
  const scrim = $("#scrim");
  head.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest("button")) return;
    cancelMotion(drawer);
    drag = { id: e.pointerId, x0: e.clientX, last: e.clientX, lastT: e.timeStamp, v: 0 };
    drawer._dragX = 0;
    head.setPointerCapture(e.pointerId);
    head.classList.add("held");
  });
  head.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const raw = e.clientX - drag.x0;
    const offset = raw >= 0 ? raw : -rubberBand(-raw, 48);
    drawer._dragX = offset;
    drawer.style.transform = `translateX(${offset}px)`;
    scrim.style.opacity = String(Math.max(0, 1 - Math.max(0, offset) / drawer.offsetWidth));
    drag.v = (e.clientX - drag.last) / Math.max(1, e.timeStamp - drag.lastT); // px per ms, to tell a flick from a slow drag
    drag.last = e.clientX; drag.lastT = e.timeStamp;
  });
  const release = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const flick = drag.v; // read before forgetting the drag
    drag = null;
    head.classList.remove("held");
    const offset = drawer._dragX ?? 0;
    // dragged more than 30% of the way, or flicked to the right: it leaves, carrying on from where the hand let go
    if (offset > 0 && e.type === "pointerup" && (offset > drawer.offsetWidth * 0.3 || flick > 0.6)) { closeOverlays(); return; }
    drawer.style.transform = "";
    drawer._dragX = 0;
    scrim.style.opacity = "";
    if (offset && !reduced()) settle(drawer, offset); // otherwise it eases home: ease-out, no bounce
  };
  head.addEventListener("pointerup", release);
  head.addEventListener("pointercancel", release);
}
