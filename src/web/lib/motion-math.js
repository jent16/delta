// The house rules for motion, as numbers and pure functions (no DOM, so they can be unit-tested).
// lib/motion.js turns these into actual animations. Change a rule HERE and it changes everywhere.
//
//   entrances ease OUT; moves ease IN-OUT; exits ease IN
//   dropdowns/popovers 150-250 ms; exits are 20% shorter than their entrances
//   popovers start at .95 scale and grow from the thing that opened them
//   rows stagger by 30 ms; presses scale to .97
//   a moving knob stretches 12% in flight; things that travel go along an arc
//   NO bounce or overshoot anywhere in everyday UI (every curve stays inside 0..1)

/** Entrance durations in ms. Exits are derived (see exitDuration), never typed in by hand. */
export const DURATION = {
  swap: 150,      // small crossfades, tab changes
  dropdown: 180,  // menus and popovers
  modal: 220,
  screen: 220,    // a whole screen's content arriving
  toast: 220,
  move: 250,      // things travelling (the knob, a logo flying to the panel)
  drawer: 250,
};

export const EXIT_FACTOR = 0.8; // "make exits 20% shorter than entries"
export const exitDuration = (enterMs) => Math.round(enterMs * EXIT_FACTOR);

// All control points stay within 0..1 on the y axis, so none of these can overshoot (no bounce).
export const EASE = {
  out: "cubic-bezier(0.22, 1, 0.36, 1)",    // entrances: fast start, soft landing
  inOut: "cubic-bezier(0.65, 0, 0.35, 1)",  // moves
  in: "cubic-bezier(0.5, 0, 0.75, 0)",      // exits: gather, then leave
};

export const SCALE = { popover: 0.95, press: 0.97 };
export const STRETCH = 1.12; // a moving knob is 12% longer at the middle of its trip
export const STAGGER = { step: 30, max: 12 };

/**
 * Delay for the nth item of a staggered list, or null once the list is long enough that
 * animating the rest would only make the screen feel slow (they simply appear).
 */
export function staggerDelay(index, { step, max } = STAGGER) {
  return index < max ? index * step : null;
}

/**
 * Resistance when you pull something past its limit: it follows the pointer, but less and less,
 * and never further than `limit`. 0 or less means "not past the bound", so no stretch.
 */
export function rubberBand(distance, limit = 48, resistance = 0.55) {
  if (distance <= 0) return 0;
  return (1 - 1 / ((distance * resistance) / limit + 1)) * limit;
}

/** Where a popover should grow from: the centre of the thing that opened it, in the popover's own coordinates. */
export function originFor(trigger, panel) {
  return {
    x: Math.round(trigger.left + trigger.width / 2 - panel.left),
    y: Math.round(trigger.top + trigger.height / 2 - panel.top),
  };
}

/** Points along a curved path (a quadratic Bezier) from `from` to the origin (0,0), bowing upward. */
export function arcPoints(from, steps = 10, lift) {
  const dist = Math.hypot(from.x, from.y);
  if (dist < 1) return [{ x: from.x, y: from.y }, { x: 0, y: 0 }];
  const bow = lift ?? Math.min(48, dist * 0.25);
  let px = -from.y / dist;
  let py = from.x / dist; // perpendicular to the straight line between the two points
  if (py > 0 || (py === 0 && px < 0)) { px = -px; py = -py; } // choose the side that bows upward
  const control = { x: from.x / 2 + px * bow, y: from.y / 2 + py * bow };
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, u = 1 - t;
    points.push({ x: u * u * from.x + 2 * u * t * control.x, y: u * u * from.y + 2 * u * t * control.y });
  }
  points[steps] = { x: 0, y: 0 }; // land exactly, not at -0.0000001
  return points;
}

/** Keyframes for an object that travels from `from` (an offset from where it ends up) to rest, along an arc, resizing as it goes. */
export function arcKeyframes(from, fromScale = 1, steps = 10) {
  return arcPoints(from, steps).map((p, i, all) => {
    const t = i / (all.length - 1);
    return { transform: `translate(${p.x.toFixed(2)}px, ${p.y.toFixed(2)}px) scale(${(fromScale + (1 - fromScale) * t).toFixed(4)})`, offset: t };
  });
}

/**
 * Keyframes for a knob (the highlight behind the active tab) sliding from where it was to where it is now.
 * It stretches 12% at the middle of the trip and lifts a hair, so it reads as one object travelling.
 * `prev` and `next` are { x, w }: left edge and width. The element sits at `next`; we animate FROM `prev`.
 */
export function knobKeyframes(prev, next) {
  const dx = prev.x - next.x;
  const sx = prev.w / next.w;
  const midScale = ((sx + 1) / 2) * STRETCH;
  return [
    { transform: `translateX(${dx}px) scaleX(${sx})`, offset: 0 },
    { transform: `translateX(${dx / 2}px) translateY(-2px) scaleX(${midScale.toFixed(4)})`, offset: 0.5 },
    { transform: "translateX(0) scaleX(1)", offset: 1 },
  ];
}
