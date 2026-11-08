import test from "node:test";
import assert from "node:assert/strict";
import { EVENT_KINDS, LINK_ROLES, RELATIONSHIPS } from "./contact.ts";
import { PROGRESS_STAGES } from "./progress.ts";
import { canTransition, STATUSES } from "./status.ts";
import { describeVocabulary, ROLE_FUNCTIONS, SECTORS } from "./vocab.ts";

test("the vocabulary a client sees is the domain's own lists", () => {
  const v = describeVocabulary();
  assert.deepEqual(v.statuses, [...STATUSES]);
  assert.deepEqual(v.roleFunctions, [...ROLE_FUNCTIONS]);
  assert.deepEqual(v.sectors, [...SECTORS]);
  assert.deepEqual(v.progressStages, [...PROGRESS_STAGES]);
  assert.deepEqual(v.relationships, [...RELATIONSHIPS]);
  assert.deepEqual(v.linkRoles, [...LINK_ROLES]);
  assert.deepEqual(v.eventKinds, [...EVENT_KINDS]);
});

test("transitions: for every pair of statuses the client's table agrees with canTransition", () => {
  const v = describeVocabulary();
  for (const from of STATUSES) for (const to of STATUSES) assert.equal(v.transitions[from].includes(to), canTransition(from, to), `${from} -> ${to}`);
  assert.deepEqual(v.transitions.rejected, []); // final states have no moves
});

test("it is a copy: changing what a client received cannot change the rules", () => {
  const sectorCount = SECTORS.length;
  const v = describeVocabulary();
  v.transitions.applied.push("saved");
  v.sectors.pop();
  assert.equal(canTransition("applied", "saved"), false);
  assert.equal(SECTORS.length, sectorCount);
  assert.equal(describeVocabulary().sectors.length, sectorCount);
});
