// The first page a signed-out visitor sees: what Delta is and how it works, before the sign-in form.
// Plain text and a few cards; nothing here talks to the server. `choose("in" | "up")` moves on to the form.

import { $, clear, h, icon } from "../lib/dom.js";
import { reduced, staggerIn } from "../lib/motion.js";

const WHAT = [
  ["rows", "Every application, one list", "Saved, drafting, applied, assessment, interview, offer. Each change is dated, so you can see how long things sit."],
  ["chart", "See what is working", "Replies by role, sector, where you found it and which resume you sent, always with how many applications each number rests on."],
  ["users", "The people behind the company", "Keep the people you know at a company, log when you spoke, and open a ready-made LinkedIn search. Nothing is scraped."],
  ["bell", "Do not miss a follow-up", "Set a date on an application or a person and it shows up under Reminders when it is due."],
];

const STEPS = [
  ["Create an account", "An email and a password. Your applications and contacts are private to your account."],
  ["Add what you are applying to", "Type a company and a role, or paste a posting link. Change several at once when you hear back."],
  ["Update it as you hear back", "Move the status, set a follow-up date, note who helped. The dashboard and Insights fill in from that."],
];

/** `info` is /api/auth/state; `choose(mode)` is called with "in" or "up" when the visitor picks one. */
export function showWelcome(info, choose) {
  const up = info.canSignUp;
  const actions = (extra = "") => h("div", { class: `welcome-actions ${extra}`.trim() },
    up ? h("button", { class: "btn primary", type: "button", text: "Create an account", onclick: () => choose("up") }) : null,
    h("button", { class: up ? "btn" : "btn primary", type: "button", text: "Sign in", onclick: () => choose("in") }));

  const hero = h("section", { class: "welcome-hero" },
    h("p", { class: "eyebrow", text: "Internship tracker" }),
    h("h1", { class: "title", text: "Keep every internship application in one place." }),
    h("p", { class: "welcome-lead", text: "Delta is a private tracker for your internship search: what you applied to, where each one stands, and who you know there." }),
    actions());

  const what = h("section", { class: "welcome-block", "aria-labelledby": "w-what" },
    h("h2", { id: "w-what", class: "panel-title", text: "What it does" }),
    h("div", { class: "welcome-cards" }, WHAT.map(([ic, title, body]) =>
      h("div", { class: "welcome-card" },
        h("span", { class: "welcome-icon", "aria-hidden": "true" }, icon(ic, 18)),
        h("h3", { text: title }),
        h("p", { text: body })))));

  const how = h("section", { class: "welcome-block", "aria-labelledby": "w-how" },
    h("h2", { id: "w-how", class: "panel-title", text: "How it works" }),
    h("ol", { class: "welcome-steps" }, STEPS.map(([title, body]) =>
      h("li", {}, h("strong", { text: title }), h("span", { text: body })))));

  const privacy = h("p", { class: "welcome-foot", text: "Delta never contacts anyone for you and never reads your LinkedIn. You can delete your account, and everything in it, whenever you like." });
  const closing = actions("welcome-end");

  const page = h("div", { class: "welcome" }, hero, what, how, privacy, closing);
  clear($("#view")).append(page);
  if (!reduced()) staggerIn([hero, what, how, privacy, closing]);
}
