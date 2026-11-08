// Turns the rules in motion-math.js into real animations. Everything here is decoration: if animation is
// off (the "reduce motion" setting, or an old browser) each function does nothing and resolves at once, and
// the interface still works, because state changes never wait on an animation EXCEPT hiding something after
// its exit, which hideWith() guarantees happens.
//
// Uses the Web Animations API (el.animate), which the page's strict policy allows, and sets style through
// the CSSOM (el.style.x = ...), never through a style attribute.

import { arcKeyframes, DURATION, EASE, exitDuration, knobKeyframes, originFor, SCALE, staggerDelay } from "./motion-math.js";

const reduceQuery = matchMedia("(prefers-reduced-motion: reduce)");
export const reduced = () => reduceQuery.matches;

/** Play keyframes; resolve when done (or at once if motion is off). Never rejects. */
function play(el, keyframes, { duration, easing = EASE.out, delay = 0, fill = "backwards" } = {}) {
  if (reduced() || !el?.animate) return Promise.resolve();
  const animation = el.animate(keyframes, { duration, easing, delay, fill });
  // Resolve when it finishes, OR shortly after it should have: a page in a background tab doesn't render, so its
  // animation clock stands still and `finished` would never arrive, leaving a closed panel invisible but still
  // there. The timer guarantees whatever waits on an exit (hiding, removing) always happens.
  return new Promise((resolve) => {
    animation.finished.then(resolve, resolve); // a cancelled animation is not an error
    setTimeout(resolve, delay + duration + 120);
  });
}

/** Stop everything running on an element and forget any pending "hide me when the exit is done". */
export function cancelMotion(el) {
  el._leaving = null;
  el.getAnimations?.().forEach((a) => a.cancel());
}

/**
 * Run an exit, then hide the element, unless it was shown again in the meantime.
 * (The 'dead close button' lesson: something that has exited must really be hidden, not just invisible.)
 */
export async function hideWith(el, exit) {
  const token = Symbol("leaving");
  el._leaving = token;
  await exit();
  if (el._leaving !== token) return false;
  el.hidden = true;
  el._leaving = null;
  el.getAnimations?.().forEach((a) => a.cancel());
  return true;
}

// ---------- popovers: grow from the trigger, shrink back into it ----------
const rectOf = (el) => el.getBoundingClientRect();

function setOrigin(el, trigger) {
  if (trigger?.isConnected) {
    const o = originFor(rectOf(trigger), rectOf(el));
    el.style.transformOrigin = `${o.x}px ${o.y}px`;
  } else el.style.transformOrigin = "50% 0";
}

export function popIn(el, trigger, duration = DURATION.dropdown) {
  setOrigin(el, trigger);
  return play(el, [{ opacity: 0, transform: `scale(${SCALE.popover})` }, { opacity: 1, transform: "scale(1)" }], { duration, easing: EASE.out });
}

export function popOut(el, trigger, duration = DURATION.dropdown) {
  setOrigin(el, trigger);
  return play(el, [{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: `scale(${SCALE.popover})` }], { duration: exitDuration(duration), easing: EASE.in, fill: "forwards" });
}

// ---------- edges: the drawer, the bulk bar, the toast ----------
export function slideIn(el, { x = 0, y = 0, duration = DURATION.drawer } = {}) {
  return play(el, [{ opacity: 0, transform: `translate(${x}px, ${y}px)` }, { opacity: 1, transform: "none" }], { duration, easing: EASE.out });
}

export function slideOut(el, { x = 0, y = 0, duration = DURATION.drawer, from = "none" } = {}) {
  return play(el, [{ opacity: 1, transform: from }, { opacity: 0, transform: `translate(${x}px, ${y}px)` }], { duration: exitDuration(duration), easing: EASE.in, fill: "forwards" });
}

export function fade(el, to, duration = DURATION.drawer) {
  const start = Number(getComputedStyle(el).opacity); // an exit that begins mid-entrance (or mid-drag) leaves from where it is
  const keyframes = to === 1 ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: Number.isFinite(start) ? start : 1 }, { opacity: 0 }];
  return play(el, keyframes, to === 1 ? { duration, easing: EASE.out } : { duration: exitDuration(duration), easing: EASE.in, fill: "forwards" });
}

// ---------- lists: rows arrive 30 ms apart; details settle in order ----------
export function staggerIn(elements, { duration = DURATION.screen, dy = 8, base = 0 } = {}) {
  [...elements].forEach((el, i) => {
    const delay = staggerDelay(i);
    if (delay === null) return; // a long list: the rest simply appear
    play(el, [{ opacity: 0, transform: `translateY(${dy}px)` }, { opacity: 1, transform: "none" }], { duration, delay: base + delay, easing: EASE.out });
  });
}

// ---------- masks: reveal by uncovering, not by fading ----------
export function reveal(el, axis = "x", { delay = 0, duration = DURATION.screen } = {}) {
  const covered = axis === "y" ? "inset(100% 0 0 0)" : "inset(0 100% 0 0)"; // y: grow up from the baseline; x: wipe left to right
  return play(el, [{ clipPath: covered }, { clipPath: "inset(0 0 0 0)" }], { duration, delay, easing: EASE.out });
}

/** A colour change (light/dark, or a new design) that spreads outward from the button that caused it. */
export async function revealColor(trigger, change) {
  if (reduced() || !document.startViewTransition || !trigger?.isConnected) { change(); return; }
  const r = rectOf(trigger);
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const transition = document.startViewTransition(change);
  try {
    await transition.ready;
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      { duration: DURATION.move, easing: EASE.out, pseudoElement: "::view-transition-new(root)" });
  } catch { /* the change itself already happened */ }
}

// ---------- icons: crossfade with a touch of blur ----------
export function crossfadeIcon(oldIcon, newIcon) {
  if (reduced()) return newIcon;
  const wrap = document.createElement("span");
  wrap.className = "icon-swap";
  wrap.append(oldIcon, newIcon);
  const d = DURATION.swap;
  play(oldIcon, [{ opacity: 1, filter: "blur(0)" }, { opacity: 0, filter: "blur(4px)" }], { duration: exitDuration(d), easing: EASE.in, fill: "forwards" }).then(() => oldIcon.remove());
  play(newIcon, [{ opacity: 0, filter: "blur(4px)" }, { opacity: 1, filter: "blur(0)" }], { duration: d, easing: EASE.out });
  return wrap;
}

// ---------- overlapping old and new ----------
/**
 * Swap a container's content so the old and the new are on screen together: the old content lifts into a
 * ghost layer and fades out while the new content fades in, instead of old-out-then-new-in.
 * Returns the newly added elements, so the caller can add its own entrance to them.
 */
export function crossfade(container, fill, { duration = DURATION.swap } = {}) {
  const old = [...container.childNodes].filter((n) => !(n.classList?.contains("ghost")));
  container.querySelectorAll(":scope > .ghost").forEach((g) => g.remove());
  if (!old.length || reduced()) {
    while (container.firstChild) container.removeChild(container.firstChild);
    fill();
    return [...container.children];
  }
  const ghost = document.createElement("div");
  ghost.className = "ghost";
  ghost.setAttribute("aria-hidden", "true");
  ghost.inert = true;
  old.forEach((n) => ghost.append(n));
  ghost.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id")); // so a lookup by id finds the live one, not this copy
  container.append(ghost);
  fill();
  const added = [...container.children].filter((n) => n !== ghost);
  play(ghost, [{ opacity: 1 }, { opacity: 0 }], { duration: exitDuration(duration), easing: EASE.in, fill: "forwards" }).then(() => ghost.remove());
  added.forEach((n) => play(n, [{ opacity: 0 }, { opacity: 1 }], { duration, easing: EASE.out }));
  return added;
}

// ---------- the knob: one highlight that travels between tabs ----------
const knobMemory = new Map();

/** Put (or move) the knob behind the active item of every `[data-knob]` container inside `root`. */
export function placeKnobs(root) {
  root.querySelectorAll("[data-knob]").forEach((container) => {
    const key = container.dataset.knob;
    const active = container.querySelector('[aria-pressed="true"], [aria-current="page"]');
    container.querySelectorAll(":scope > .knob").forEach((k) => k.remove());
    if (!active) { knobMemory.delete(key); return; }
    const knob = document.createElement("span");
    knob.className = "knob";
    knob.setAttribute("aria-hidden", "true");
    container.prepend(knob);
    const next = { x: active.offsetLeft, w: active.offsetWidth };
    knob.style.left = `${next.x}px`;
    knob.style.top = `${active.offsetTop}px`;
    knob.style.width = `${next.w}px`;
    knob.style.height = `${active.offsetHeight}px`;
    const prev = knobMemory.get(key);
    knobMemory.set(key, next);
    if (prev && (prev.x !== next.x || prev.w !== next.w)) play(knob, knobKeyframes(prev, next), { duration: DURATION.move, easing: EASE.inOut, fill: "none" });
  });
}

// ---------- one object, two places: a logo flies between the row and the panel ----------
/**
 * Fly a copy of `fromEl` to `toEl` along an arc, resizing as it goes, so the logo in the table row
 * visibly BECOMES the logo in the panel (and back). `toEl` is hidden until the copy lands on it.
 */
export function flyBetween(fromEl, toEl, { duration = DURATION.move, hideTarget = true, hideSource = false } = {}) {
  if (reduced() || !fromEl?.isConnected || !toEl?.isConnected) return Promise.resolve();
  const a = rectOf(fromEl), b = rectOf(toEl);
  if (!b.width || !a.width) return Promise.resolve();
  const copy = fromEl.cloneNode(true);
  Object.assign(copy.style, { position: "fixed", left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px`, margin: "0", zIndex: "60", pointerEvents: "none", transformOrigin: "top left" });
  document.body.append(copy);
  if (hideTarget) toEl.style.visibility = "hidden";
  if (hideSource) fromEl.style.visibility = "hidden";
  const frames = arcKeyframes({ x: a.left - b.left, y: a.top - b.top }, a.width / b.width);
  return play(copy, frames, { duration, easing: EASE.inOut, fill: "both" }).then(() => { copy.remove(); toEl.style.visibility = ""; fromEl.style.visibility = ""; });
}

/** Return something you let go of to its resting place: ease out, no bounce. */
export function settle(el, fromX, duration = DURATION.swap + 50) {
  return play(el, [{ transform: `translateX(${fromX}px)` }, { transform: "translateX(0)" }], { duration, easing: EASE.out });
}
