import test from "node:test";
import assert from "node:assert/strict";
import { arcKeyframes, arcPoints, DURATION, EASE, exitDuration, EXIT_FACTOR, knobKeyframes, originFor, rubberBand, SCALE, staggerDelay, STAGGER, STRETCH } from "./web/lib/motion-math.js";

// The motion rules are numbers, so they are tested like numbers. (That it LOOKS right is checked by watching it.)

test("exits are 20% shorter than their entrances, for every duration we use", () => {
  assert.equal(EXIT_FACTOR, 0.8);
  for (const [name, enter] of Object.entries(DURATION)) {
    const exit = exitDuration(enter);
    assert.ok(exit < enter, name);
    assert.ok(Math.abs(exit / enter - 0.8) < 0.01, `${name}: ${exit}/${enter}`);
  }
  assert.equal(exitDuration(250), 200);
  assert.equal(exitDuration(180), 144);
});

test("dropdowns, popovers and panels open in 150-250 ms", () => {
  for (const key of ["swap", "dropdown", "modal", "screen", "toast", "move", "drawer"] as const) {
    assert.ok(DURATION[key] >= 150 && DURATION[key] <= 250, `${key} = ${DURATION[key]}`);
  }
});

test("no easing curve can overshoot: every control point stays inside 0..1 (no bounce)", () => {
  for (const [name, curve] of Object.entries(EASE)) {
    const m = /cubic-bezier\(([^)]+)\)/.exec(curve);
    assert.ok(m, name);
    const [x1, y1, x2, y2] = m![1]!.split(",").map(Number) as [number, number, number, number];
    for (const v of [x1, x2]) assert.ok(v >= 0 && v <= 1, `${name} x ${v}`);
    for (const v of [y1, y2]) assert.ok(v >= 0 && v <= 1, `${name} y ${v}`);
  }
});

test("the three easings are the right shapes: entrances decelerate, exits accelerate, moves do both", () => {
  const pts = (c: string) => /cubic-bezier\(([^)]+)\)/.exec(c)![1]!.split(",").map(Number) as [number, number, number, number];
  const out = pts(EASE.out), inn = pts(EASE.in), both = pts(EASE.inOut);
  assert.ok(out[1] > out[0] && out[3] >= out[2], "out starts fast (first handle steeper than the diagonal)");
  assert.ok(inn[1] < inn[0], "in starts slow");
  assert.ok(both[1] < both[0] && both[3] > both[2], "in-out starts slow and ends slow");
});

test("popovers start at .95 and a press scales to .97; the knob stretches 12%", () => {
  assert.equal(SCALE.popover, 0.95);
  assert.equal(SCALE.press, 0.97);
  assert.equal(STRETCH, 1.12);
});

test("rows stagger 30 ms apart, and a long list stops staggering instead of making you wait", () => {
  assert.equal(STAGGER.step, 30);
  assert.deepEqual([0, 1, 2, 3].map((i) => staggerDelay(i)), [0, 30, 60, 90]);
  assert.equal(staggerDelay(STAGGER.max - 1), (STAGGER.max - 1) * 30);
  assert.equal(staggerDelay(STAGGER.max), null);
  assert.equal(staggerDelay(500), null);
  assert.equal(staggerDelay(2, { step: 10, max: 5 }), 20);
});

test("rubber band: nothing before the bound, then it follows with growing resistance and never passes the limit", () => {
  assert.equal(rubberBand(0), 0);
  assert.equal(rubberBand(-30), 0);
  let last = 0;
  for (const d of [1, 5, 20, 50, 100, 400, 5000]) {
    const v = rubberBand(d, 48);
    assert.ok(v > last, `increasing at ${d}`);   // still follows the pointer
    assert.ok(v < d, `resists at ${d}`);          // but less than 1:1
    assert.ok(v < 48, `bounded at ${d}`);         // and never past the limit
    last = v;
  }
  assert.ok(rubberBand(5000, 48) > 47);           // close to the limit for a huge pull
  // resistance grows: the same extra pull moves it less the further it already is
  assert.ok(rubberBand(40) - rubberBand(20) < rubberBand(20) - rubberBand(0));
});

test("a popover grows from the centre of its trigger, in its own coordinates", () => {
  const trigger = { left: 700, top: 20, width: 80, height: 30 };
  assert.deepEqual(originFor(trigger, { left: 600, top: 56 }), { x: 140, y: -21 });
  assert.deepEqual(originFor({ left: 0, top: 0, width: 10, height: 10 }, { left: 0, top: 0 }), { x: 5, y: 5 });
});

test("an arc starts where the object was, ends exactly at rest, and bows away from the straight line", () => {
  const from = { x: -200, y: 120 };
  const pts = arcPoints(from, 10);
  assert.equal(pts.length, 11);
  assert.deepEqual(pts[0], from);
  assert.deepEqual(pts[10], { x: 0, y: 0 });
  // distance of each point from the straight chord: positive in the middle, zero at the ends
  const chord = (p: { x: number; y: number }) => Math.abs(from.y * p.x - from.x * p.y) / Math.hypot(from.x, from.y);
  assert.ok(chord(pts[0]!) < 1e-9 && chord(pts[10]!) < 1e-9);
  assert.ok(chord(pts[5]!) > 5, "the middle is off the straight line");
  // it bows upward: the midpoint is higher (smaller y) than the chord's midpoint
  assert.ok(pts[5]!.y < from.y / 2);
});

test("an arc is a curve in every direction, never a straight line, and a tiny move is just a move", () => {
  for (const from of [{ x: 100, y: 0 }, { x: -100, y: 0 }, { x: 0, y: 100 }, { x: 0, y: -100 }, { x: 80, y: -60 }]) {
    const pts = arcPoints(from);
    const mid = pts[5]!;
    const off = Math.abs(from.y * mid.x - from.x * mid.y) / Math.hypot(from.x, from.y);
    assert.ok(off > 3, `${JSON.stringify(from)} bows by ${off.toFixed(1)}`);
  }
  assert.equal(arcPoints({ x: 0.2, y: 0.1 }).length, 2);
});

test("arc keyframes resize the object smoothly from its old size to its new one", () => {
  const frames = arcKeyframes({ x: -120, y: 40 }, 0.6, 8);
  assert.equal(frames.length, 9);
  assert.match(frames[0]!.transform, /scale\(0\.6000\)/);
  assert.match(frames[8]!.transform, /translate\(0\.00px, 0\.00px\) scale\(1\.0000\)/);
  assert.deepEqual(frames.map((f) => f.offset), [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1]);
});

test("a knob sliding between two tabs stretches 12% in the middle and lands exactly", () => {
  const frames = knobKeyframes({ x: 10, w: 100 }, { x: 210, w: 100 });
  assert.equal(frames.length, 3);
  assert.equal(frames[0]!.transform, "translateX(-200px) scaleX(1)");            // starts on the old tab
  assert.match(frames[1]!.transform, /scaleX\(1\.1200\)/);                       // 12% longer at the middle
  assert.match(frames[1]!.transform, /translateX\(-100px\)/);                    // halfway there
  assert.equal(frames[2]!.transform, "translateX(0) scaleX(1)");                 // rests on the new one
  // moving between tabs of different widths: the stretch is 12% on top of the average width
  const uneven = knobKeyframes({ x: 0, w: 60 }, { x: 100, w: 120 });
  assert.match(uneven[1]!.transform, /scaleX\(0\.8400\)/);                       // ((0.5 + 1) / 2) * 1.12
});
