// Your profile: who you are, what you are looking for, the resume versions you send, and your account's
// security. Each field saves by itself when you leave it, like the person panel.

import { api, describeError } from "../lib/api.js";
import { clear, h, icon } from "../lib/dom.js";
import { ctx } from "../lib/ctx.js";
import { passwordDialog } from "../lib/confirm.js";
import { plural } from "../lib/format.js";
import { state, vocab } from "../lib/state.js";
import { toast } from "../lib/ui.js";

const memberSince = (iso) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

export async function profileView() {
  const { profile, resumeVersions, unlisted } = await api.profile();
  state.account = { ...state.account, name: profile.name };
  state.resumeNames = resumeVersions.map((v) => v.name);

  const saves = (input, key, read, { after } = {}) => {
    let stored = JSON.stringify(read());
    input.addEventListener("change", async () => {
      const value = read();
      if (JSON.stringify(value) === stored) return;
      try {
        const saved = await api.editProfile({ [key]: value });
        stored = JSON.stringify(read());
        toast("Saved");
        after?.(saved);
      } catch (e) {
        toast(describeError(e), true);
        input.value = input.dataset.was ?? "";
      }
    });
    input.dataset.was = input.value;
    input.addEventListener("focus", () => { input.dataset.was = input.value; });
  };
  const field = (id, name, input, hint) => h("div", { class: "field" }, h("label", { for: id, text: name }), input, hint ? h("span", { class: "hint", text: hint }) : null);

  // ---- about you ----
  const name = h("input", { id: "pf-name", type: "text", value: profile.name, maxlength: "100", autocomplete: "name" });
  name.addEventListener("change", async () => {
    const value = name.value.trim();
    if (!value) { name.value = profile.name; toast("Your name can't be empty.", true); return; }
    try { const saved = await api.editProfile({ name: value }); profile.name = saved.name; state.account = { ...state.account, name: saved.name }; toast("Saved"); ctx.refresh(); }
    catch (e) { name.value = profile.name; toast(describeError(e), true); }
  });
  const about = h("section", { class: "panel" }, h("h2", { class: "panel-title", text: "About you" }),
    h("div", { class: "edit-grid" },
      field("pf-name", "Name", name),
      field("pf-email", "Email", h("input", { id: "pf-email", type: "email", value: profile.email ?? "", readonly: true }), `Member since ${memberSince(profile.createdAt)}`)));

  // ---- school and goals ----
  const school = h("input", { id: "pf-school", type: "text", value: profile.school, maxlength: "100" });
  saves(school, "school", () => school.value.trim());
  const program = h("input", { id: "pf-program", type: "text", value: profile.program, maxlength: "100", placeholder: "e.g. Computer Science" });
  saves(program, "program", () => program.value.trim());
  const year = h("input", { id: "pf-year", type: "number", min: "2000", max: "2100", step: "1", value: profile.gradYear ?? "", placeholder: "e.g. 2028" });
  saves(year, "gradYear", () => (year.value === "" ? null : Number(year.value)));
  const terms = h("input", { id: "pf-terms", type: "text", value: profile.targetTerms.join(", "), placeholder: "Summer 2027, Fall 2027" });
  saves(terms, "targetTerms", () => terms.value.split(",").map((t) => t.trim()).filter(Boolean));

  let roles = [...profile.targetRoles];
  const roleRow = h("div", { class: "chips", role: "group", "aria-label": "Roles you are looking for" });
  const drawRoles = () => {
    clear(roleRow);
    for (const r of vocab.roleFunctions) {
      roleRow.append(h("button", { class: "fchip", type: "button", "aria-pressed": String(roles.includes(r)), text: r, onclick: async () => {
        const next = roles.includes(r) ? roles.filter((x) => x !== r) : [...roles, r];
        try { await api.editProfile({ targetRoles: next }); roles = next; drawRoles(); toast("Saved"); } catch (e) { toast(describeError(e), true); }
      } }));
    }
  };
  drawRoles();
  const goals = h("section", { class: "panel" }, h("h2", { class: "panel-title", text: "School and what you're looking for" }),
    h("div", { class: "edit-grid" },
      field("pf-school", "School", school, "The alumni search on the People screen looks for people from here."),
      field("pf-program", "Program", program),
      field("pf-year", "Graduation year", year),
      field("pf-terms", "Terms you're applying for", terms, "Separate with commas."),
      h("div", { class: "field wide" }, h("label", { text: "Roles you're after" }), roleRow)));

  // ---- resume versions ----
  const list = h("div", { class: "rv-list" });
  const reload = async () => { await ctx.refresh("none"); };
  const addVersion = async (n) => {
    try { await api.addResumeVersion(n); toast(`Added ${n}`); await reload(); } catch (e) { toast(describeError(e), true); }
  };
  for (const v of resumeVersions) {
    const vName = h("input", { class: "inline-input", type: "text", value: v.name, maxlength: "100", "aria-label": `Name of ${v.name}` });
    const vNote = h("input", { class: "inline-input rv-note", type: "text", value: v.note ?? "", maxlength: "300", placeholder: "Note (optional)", "aria-label": `Note for ${v.name}` });
    vName.addEventListener("change", async () => {
      const value = vName.value.trim();
      if (!value || value === v.name) { vName.value = v.name; return; }
      try { await api.editResumeVersion(v.id, { name: value }); toast(v.uses ? `Renamed, and ${plural(v.uses, "application")} followed` : "Renamed"); await reload(); }
      catch (e) { vName.value = v.name; toast(describeError(e), true); }
    });
    vNote.addEventListener("change", async () => {
      try { await api.editResumeVersion(v.id, { note: vNote.value.trim() || null }); toast("Saved"); } catch (e) { toast(describeError(e), true); }
    });
    list.append(h("div", { class: "rv-row" }, vName, vNote,
      h("span", { class: "dim small rv-uses", text: v.uses ? plural(v.uses, "application") : "not used yet" }),
      h("button", { class: "btn small", type: "button", "aria-label": `Remove ${v.name} from the list`, title: "Remove from the list (your applications keep the text)", onclick: async () => {
        try { await api.removeResumeVersion(v.id); toast(`Removed ${v.name} from the list`); await reload(); } catch (e) { toast(describeError(e), true); }
      } }, icon("x", 13))));
  }
  if (!resumeVersions.length) list.append(h("p", { class: "empty", text: "No resume versions listed yet." }));
  const newName = h("input", { id: "rv-new", type: "text", maxlength: "100", placeholder: "e.g. SWE-v3", "aria-label": "New resume version name" });
  const addForm = h("form", { class: "rv-add" }, newName, h("button", { class: "btn small", type: "submit" }, icon("plus", 13), "Add"));
  addForm.addEventListener("submit", (e) => { e.preventDefault(); if (newName.value.trim()) addVersion(newName.value.trim()); });
  const resumes = h("section", { class: "panel" }, h("h2", { class: "panel-title", text: "Resume versions" }),
    h("p", { class: "note-line", text: "Just the names you use for your resumes, no files. They show up as suggestions in an application's “Resume version” box, and Insights compares how each one does." }),
    list, addForm,
    unlisted.length ? h("div", { class: "rv-found" }, h("span", { class: "dim small", text: "Already on your applications:" }),
      ...unlisted.map((u) => h("button", { class: "fchip", type: "button", title: "Add to the list", onclick: () => addVersion(u.name) }, `+ ${u.name}`, h("span", { class: "n", text: String(u.uses) })))) : null);

  // ---- account ----
  const current = h("input", { id: "pw-current", type: "password", autocomplete: "current-password", maxlength: "200" });
  const next = h("input", { id: "pw-next", type: "password", autocomplete: "new-password", maxlength: "200" });
  const changeBtn = h("button", { class: "btn", type: "submit", text: "Change password" });
  const pwForm = h("form", { class: "pw-form" },
    h("div", { class: "edit-grid" }, field("pw-current", "Current password", current), field("pw-next", "New password", next, "At least 10 characters.")), changeBtn);
  pwForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    changeBtn.disabled = true;
    try { await api.changePassword(current.value, next.value); current.value = ""; next.value = ""; toast("Password changed. Other browsers were signed out."); }
    catch (err) { toast(describeError(err), true); }
    changeBtn.disabled = false;
  });
  const account = h("section", { class: "panel" }, h("h2", { class: "panel-title", text: "Account" }), pwForm,
    h("div", { class: "account-actions" },
      h("button", { class: "btn", type: "button", text: "Sign out", onclick: async () => { try { await api.signOut(); } catch { /* the page returns to sign-in either way */ } ctx.signedOut(); } }),
      h("button", { class: "btn danger-outline", type: "button", text: "Delete account…", onclick: () => passwordDialog({
        title: "Delete your account?",
        body: ["This permanently deletes your account and everything in it: applications, people, lists and notes.", "A backup is saved on this computer first, but it can't be undone from here."],
        confirmLabel: "Delete everything", danger: true,
        onSubmit: async (password) => {
          try { await api.deleteAccount(password); } catch (e) { throw new Error(describeError(e)); }
          ctx.signedOut();
        },
      }) })));

  return h("div", {}, h("div", { class: "head" }, h("div", {}, h("h1", { class: "title", text: "Profile" }), h("span", { class: "muted", text: profile.email ?? "" }))),
    h("div", { class: "stack profile-stack" }, about, goals, resumes, account));
}
