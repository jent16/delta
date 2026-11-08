// The page shown when nobody is signed in: sign in, or create an account. One card, two modes.

import { api, describeError } from "../lib/api.js";
import { $, clear, h } from "../lib/dom.js";
import { reduced, staggerIn } from "../lib/motion.js";

/**
 * `info` is /api/auth/state. `onSignedIn(account)` runs once the server has accepted the sign-in.
 * `options.mode` ("in" | "up") says which side to open on; `options.onBack` adds a way back to the welcome page.
 */
export function showAuth(info, onSignedIn, options = {}) {
  let mode = options.mode ?? (info.claimsExistingData ? "up" : "in"); // the very first visit offers to create the account that takes over your data
  const container = $("#view");
  const canSwitch = info.canSignUp; // when sign-ups are closed there is only "sign in"
  if (!canSwitch) mode = "in";

  const draw = (animate) => {
    const signingUp = mode === "up";
    const name = h("input", { id: "a-name", type: "text", autocomplete: "name", maxlength: "100", required: true });
    const email = h("input", { id: "a-email", type: "email", autocomplete: "email", maxlength: "254", required: true, spellcheck: "false" });
    const password = h("input", { id: "a-password", type: "password", autocomplete: signingUp ? "new-password" : "current-password", maxlength: "200", required: true });
    const show = h("input", { id: "a-show", type: "checkbox", onchange: () => { password.type = show.checked ? "text" : "password"; } });
    const problem = h("div", { class: "err auth-err", role: "alert", hidden: true });
    const go = h("button", { class: "btn primary auth-go", type: "submit", text: signingUp ? "Create account" : "Sign in" });

    const form = h("form", { class: "auth-form", novalidate: true },
      signingUp ? h("div", { class: "field" }, h("label", { for: "a-name", text: "Your name" }), name) : null,
      h("div", { class: "field" }, h("label", { for: "a-email", text: "Email" }), email),
      h("div", { class: "field" }, h("label", { for: "a-password", text: "Password" }), password,
        signingUp ? h("span", { class: "hint", text: "At least 10 characters. A few random words make a good one." }) : null),
      h("label", { class: "auth-show", for: "a-show" }, show, "Show password"),
      problem, go);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      problem.hidden = true;
      if (!email.value.trim() || !password.value || (signingUp && !name.value.trim())) {
        problem.textContent = signingUp ? "Fill in your name, email and a password." : "Enter your email and password.";
        problem.hidden = false;
        return;
      }
      go.disabled = true;
      try {
        const { account } = signingUp
          ? await api.signUp({ name: name.value, email: email.value, password: password.value })
          : await api.signIn({ email: email.value, password: password.value });
        password.value = ""; // don't leave it sitting in the page
        onSignedIn(account);
      } catch (err) {
        problem.textContent = describeError(err);
        problem.hidden = false;
        go.disabled = false;
        password.focus();
      }
    });

    const card = h("div", { class: "auth-card" },
      options.onBack ? h("button", { class: "linkish auth-back", type: "button", text: "\u2190 About Delta", onclick: options.onBack }) : null,
      h("h1", { class: "title", text: signingUp ? "Create your account" : "Welcome back" }),
      h("p", { class: "note-line", text: signingUp
        ? (info.claimsExistingData ? "This tracker already holds applications. Your new account takes them over, and nobody else will see them." : "Your applications and people stay private to your account.")
        : "Sign in to your tracker." }),
      form,
      canSwitch ? h("p", { class: "auth-switch" }, signingUp ? "Already have an account? " : "New here? ",
        h("button", { class: "linkish", type: "button", text: signingUp ? "Sign in" : "Create an account", onclick: () => { mode = signingUp ? "in" : "up"; draw(false); } })) : null);

    clear(container).append(h("div", { class: "auth-wrap" }, card));
    (signingUp ? name : email).focus();
    if (animate && !reduced()) staggerIn(card.children);
  };
  draw(true);
}
