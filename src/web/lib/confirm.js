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

/**
 * Like confirmDialog, but asks for the password. `onSubmit(password)` may throw: its message is shown in the dialog
 * and the dialog stays open, so a mistyped password can be retried without starting over.
 */
export function passwordDialog({ title, body, confirmLabel, danger = false, onSubmit }) {
  const modal = clear($("#modal"));
  const input = h("input", { id: "confirm-password", type: "password", autocomplete: "current-password", required: true, maxlength: "200" });
  const problem = h("div", { class: "err", role: "alert", hidden: true });
  const cancel = h("button", { class: "btn", type: "button", onclick: closeOverlays, text: "Cancel" });
  const go = h("button", { class: `btn primary${danger ? " danger" : ""}`, type: "submit", text: confirmLabel });
  const form = h("form", { class: "form", novalidate: true }, body.map((p) => h("p", { text: p })),
    h("div", { class: "field" }, h("label", { for: "confirm-password", text: "Your password" }), input, problem),
    h("div", { class: "form-actions" }, cancel, go));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!input.value) { problem.textContent = "Enter your password."; problem.hidden = false; input.focus(); return; }
    go.disabled = true;
    try { await onSubmit(input.value); closeOverlays(); }
    catch (err) { problem.textContent = err?.message ?? "That didn't work."; problem.hidden = false; go.disabled = false; input.select(); }
  });
  modal.append(h("header", {}, h("h2", { text: title }), h("button", { class: "btn small", type: "button", "aria-label": "Close", onclick: closeOverlays }, icon("x", 14), "Close")), form);
  openOverlay(modal, input);
}
