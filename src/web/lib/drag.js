// Drag a panel's header to dismiss it. While held it follows the hand exactly (nothing is tweened); pulled the
// wrong way (past where it rests) it resists like a rubber band; let go and it either leaves, carrying on from
// where the hand let go, or eases home. Shared by every panel that slides in from the edge.

import { $ } from "./dom.js";
import { cancelMotion, reduced, settle } from "./motion.js";
import { rubberBand } from "./motion-math.js";
import { closeOverlays } from "./overlay.js";

export function attachDrag(drawer, head) {
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
