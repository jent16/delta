// Appearance: a MODE (system / light / dark) and a DESIGN (a set of colours). The choice is remembered
// in this browser only. theme-init.js applies it before first paint; this file lets you change it.

export const MODES = [["system", "System"], ["light", "Light"], ["dark", "Dark"]];
export const DESIGNS = [["soft", "Soft pastel (default)"], ["vibrant", "Vibrant"], ["ocean", "Ocean"]];

const root = document.documentElement;
export const look = { mode: "system", design: "soft" };

try {
  const saved = JSON.parse(localStorage.getItem("delta-look") || "{}");
  if (MODES.some(([m]) => m === saved.mode)) look.mode = saved.mode;
  if (DESIGNS.some(([d]) => d === saved.design)) look.design = saved.design;
} catch { /* storage blocked: the defaults are fine */ }

export function applyLook() {
  root.setAttribute("data-design", look.design);
  // "system" removes the override, so the device's own light/dark preference decides
  if (look.mode === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", look.mode);
  try { localStorage.setItem("delta-look", JSON.stringify(look)); } catch { /* ignore */ }
}

export function setLook(key, value) {
  look[key] = value;
  applyLook();
}
