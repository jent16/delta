import test from "node:test";
import assert from "node:assert/strict";
import { ValidationError } from "./errors.ts";
import { DEFAULT_SETTINGS, MAX_TERMS, parseNewResumeVersion, parseResumeVersionPatch, parseSettingsPatch, settingsFromStored } from "./settings.ts";

const fields = (fn: () => unknown) => {
  try { fn(); } catch (e) { if (e instanceof ValidationError) return e.issues.map((i) => i.field); throw e; }
  return [];
};

test("settings patch: text fields are tidied, empty clears, and too long is refused at 101", () => {
  assert.deepEqual(parseSettingsPatch({ school: "  Univ  of   X " }), { school: "Univ of X" });
  assert.deepEqual(parseSettingsPatch({ school: "" , program: null }), { school: null, program: null });
  assert.deepEqual(parseSettingsPatch({ program: "x".repeat(100) }), { program: "x".repeat(100) });
  assert.deepEqual(fields(() => parseSettingsPatch({ program: "x".repeat(101) })), ["program"]);
  assert.deepEqual(fields(() => parseSettingsPatch({ school: 5 })), ["school"]);
});

test("settings patch: graduation year is a whole number from 2000 to 2100", () => {
  assert.deepEqual(parseSettingsPatch({ gradYear: 2028 }), { gradYear: "2028" });
  assert.deepEqual(parseSettingsPatch({ gradYear: 2000 }), { gradYear: "2000" });
  assert.deepEqual(parseSettingsPatch({ gradYear: 2100 }), { gradYear: "2100" });
  assert.deepEqual(parseSettingsPatch({ gradYear: null }), { gradYear: null });
  for (const bad of [1999, 2101, 2027.5, "2028", NaN]) assert.deepEqual(fields(() => parseSettingsPatch({ gradYear: bad })), ["gradYear"], String(bad));
});

test("settings patch: target roles come from the closed list; target terms are short, unique and limited", () => {
  assert.deepEqual(parseSettingsPatch({ targetRoles: ["SWE", "PM", "SWE"] }), { targetRoles: JSON.stringify(["SWE", "PM"]) });
  assert.deepEqual(parseSettingsPatch({ targetRoles: [] }), { targetRoles: null });
  assert.deepEqual(fields(() => parseSettingsPatch({ targetRoles: ["Astronaut"] })), ["targetRoles"]);
  assert.deepEqual(fields(() => parseSettingsPatch({ targetRoles: "SWE" })), ["targetRoles"]);
  assert.deepEqual(parseSettingsPatch({ targetTerms: [" Summer  2027 ", "Summer 2027", "", "Fall 2027"] }), { targetTerms: JSON.stringify(["Summer 2027", "Fall 2027"]) });
  assert.deepEqual(parseSettingsPatch({ targetTerms: [] }), { targetTerms: null });
  assert.deepEqual(parseSettingsPatch({ targetTerms: ["x".repeat(30)] }), { targetTerms: JSON.stringify(["x".repeat(30)]) });
  assert.deepEqual(fields(() => parseSettingsPatch({ targetTerms: ["x".repeat(31)] })), ["targetTerms"]);
  assert.deepEqual(fields(() => parseSettingsPatch({ targetTerms: [1] })), ["targetTerms"]);
  assert.equal(Object.keys(parseSettingsPatch({ targetTerms: Array.from({ length: MAX_TERMS }, (_, i) => `T${i}`) })).length, 1);
  assert.deepEqual(fields(() => parseSettingsPatch({ targetTerms: Array.from({ length: MAX_TERMS + 1 }, (_, i) => `T${i}`) })), ["targetTerms"]);
});

test("settings patch: unknown keys, nothing to change, and non-objects are refused; a caller can narrow what is accepted", () => {
  assert.deepEqual(fields(() => parseSettingsPatch({ theme: "x" })), ["theme"]);
  assert.deepEqual(fields(() => parseSettingsPatch({})), ["(body)"]);
  assert.deepEqual(fields(() => parseSettingsPatch(null)), ["(body)"]);
  assert.deepEqual(fields(() => parseSettingsPatch([])), ["(body)"]);
  assert.deepEqual(fields(() => parseSettingsPatch({ school: "X", program: "Y" }, ["school"])), ["program"]);
});

test("reading stored settings: defaults, typed values, and a corrupt value falls back instead of breaking", () => {
  assert.deepEqual(settingsFromStored({}), DEFAULT_SETTINGS);
  assert.deepEqual(settingsFromStored({ school: "X", program: "CS", gradYear: "2028", targetRoles: '["SWE"]', targetTerms: '["Summer 2027"]' }), { school: "X", program: "CS", gradYear: 2028, targetRoles: ["SWE"], targetTerms: ["Summer 2027"] });
  const bad = settingsFromStored({ gradYear: "soon", targetRoles: "{not json", targetTerms: '"a string"' });
  assert.deepEqual([bad.gradYear, bad.targetRoles, bad.targetTerms], [null, [], []]);
  assert.deepEqual(settingsFromStored({ targetRoles: '["SWE","Astronaut",5]' }).targetRoles, ["SWE"]); // only valid roles survive
  assert.deepEqual(settingsFromStored({ targetTerms: '["a",5,"b"]' }).targetTerms, ["a", "b"]);
});

test("resume versions: a name up to 100 characters, an optional note up to 300", () => {
  assert.deepEqual(parseNewResumeVersion({ name: "  SWE   v3 " }), { name: "SWE v3", note: null });
  assert.deepEqual(parseNewResumeVersion({ name: "a", note: "  for startups " }), { name: "a", note: "for startups" });
  assert.deepEqual(parseNewResumeVersion({ name: "a", note: "   " }), { name: "a", note: null });
  assert.deepEqual(parseNewResumeVersion({ name: "x".repeat(100), note: "n".repeat(300) }).name.length, 100);
  assert.deepEqual(fields(() => parseNewResumeVersion({ name: "x".repeat(101) })), ["name"]);
  assert.deepEqual(fields(() => parseNewResumeVersion({ name: "a", note: "n".repeat(301) })), ["note"]);
  assert.deepEqual(fields(() => parseNewResumeVersion({ name: "a", note: 5 })), ["note"]);
  assert.deepEqual(fields(() => parseNewResumeVersion({})), ["name"]);
  assert.deepEqual(fields(() => parseNewResumeVersion(null)), ["(body)"]);
  assert.deepEqual(parseResumeVersionPatch({ note: null }), { note: null });
  assert.deepEqual(parseResumeVersionPatch({ name: "B" }), { name: "B" });
  assert.deepEqual(fields(() => parseResumeVersionPatch({})), ["(body)"]);
  assert.deepEqual(fields(() => parseResumeVersionPatch({ color: "red" })), ["color"]);
  assert.deepEqual(fields(() => parseResumeVersionPatch({ name: "" })), ["name"]);
  assert.deepEqual(fields(() => parseResumeVersionPatch([])), ["(body)"]);
});
