// Tiny helpers for building the page. The one rule that matters: text is only ever added with
// textContent / text nodes, never as HTML. Everything on screen is YOUR data (some imported from
// elsewhere), so a company called "<img onerror=...>" must show up as those characters and nothing more.

const SVG_NS = "http://www.w3.org/2000/svg";

export const $ = (selector, root = document) => root.querySelector(selector);

// attributes that must be set as properties for the live value to change
const PROPS = new Set(["value", "checked", "selected", "disabled", "hidden"]);

/** h("button", { class: "btn", onclick: fn, text: "Save" }, child, child) */
export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key === "vars") for (const [name, v] of Object.entries(value)) el.style.setProperty(name, v); // CSSOM, allowed under the policy (style="" attributes are not)
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (PROPS.has(key)) el[key] = value;
    else el.setAttribute(key, value === true ? "" : value);
  }
  append(el, kids);
  return el;
}

export function append(el, kid) {
  if (kid == null || kid === false) return el;
  if (Array.isArray(kid)) kid.forEach((k) => append(el, k));
  else el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

const ICONS = {
  grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  rows: "M4 6h16M4 12h16M4 18h16",
  bell: "M6 17h12l-1.5-2v-4a4.5 4.5 0 10-9 0v4L6 17zM10 20h4",
  search: "M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4",
  plus: "M12 5v14M5 12h14",
  x: "M6 6l12 12M18 6L6 18",
  down: "M6 9l6 6 6-6",
  sort: "M8 5v14M8 5L5 8M8 5l3 3M16 19V5M16 19l-3-3M16 19l3-3",
  send: "M4 12l16-8-6 16-3-7-7-1z",
  reply: "M9 14l-5-5 5-5M4 9h9a7 7 0 017 7v2",
  users: "M9 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM3 20a6 6 0 0112 0M16 4.5a3.5 3.5 0 010 6.5M18 14.5a6 6 0 013 5.5",
  star: "M12 4l2.4 5 5.6.8-4 3.9 1 5.5-5-2.7-5 2.7 1-5.5-4-3.9 5.6-.8z",
  delta: "M12 5.5l7.5 13H4.5z",
  palette: "M12 4a8 8 0 100 16c1.2 0 2-.8 2-1.8 0-.5-.2-.9-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1 .8-1.8 1.8-1.8H17a3 3 0 003-3c0-3.5-3.6-6.8-8-6.8zM7.5 12h.01M9.5 8h.01M14.5 8h.01",
  check: "M5 12.5l4.5 4.5L19 7.5",
  chart: "M5 20V10M12 20V4M19 20v-7",
  building: "M5 20V5a1 1 0 011-1h7a1 1 0 011 1v15M14 9h4a1 1 0 011 1v10M3 20h18M8 8h2M8 12h2M8 16h2",
  arrowUp: "M12 19V5M6 11l6-6 6 6",
  arrowDown: "M12 5v14M6 13l6 6 6-6",
};

export function icon(name, size = 16) {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(k, v);
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", ICONS[name]);
  svg.appendChild(path);
  return svg;
}
