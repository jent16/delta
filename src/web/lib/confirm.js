// A small "are you sure?" dialog for things that can't be undone (it uses the same overlay as the other forms).

import { $, clear, h, icon } from "./dom.js";
import { closeOverlays, openOverlay } from "./overlay.js";

/** `body` is a list of paragraphs. `onConfirm` runs when the person agrees; the dialog then closes. */
export function confirmDialog({ title, body, confirmLabel, danger = false, onConfirm }) {
  const modal = clear($("#modal"));
  const cancel = h("button", { class: "btn", type: "button", onclick: closeOverlays, text: "Cancel" });
  const go = h("button", { class: `btn primary${danger ? " danger" : ""}`, type: "button", text: confirmLabel, onclick: async () => { go.disabled = true; closeOverlays(); await onConfirm(); } });
  modal.append(
    h("header", {}, h("h2", { text: title }), h("button", { class: "btn small", type: "button", "aria-label": "Close", onclick: closeOverlays }, icon("x", 14), "Close")),
    h("div", { class: "form" }, body.map((p) => h("p", { text: p })), h("div", { class: "form-actions" }, cancel, go)));
  openOverlay(modal, danger ? cancel : go); // for a destructive action focus starts on Cancel, so Enter can't delete by accident
}
