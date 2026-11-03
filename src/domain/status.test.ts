import test from "node:test";
import assert from "node:assert/strict";
import { canTransition, isClosed, nextStatuses, STATUSES, type Status } from "./status.ts";

// The state machine is small enough to pin down completely, so we do: every
// one of the 64 (from, to) pairs is asserted, not just a few spot checks.
const ALLOWED: Record<Status, Status[]> = {
  saved: ["applied", "withdrawn"],
  applied: ["assessment", "interview", "offer", "rejected", "withdrawn", "ghosted"],
  assessment: ["interview", "offer", "rejected", "withdrawn", "ghosted"],
  interview: ["offer", "rejected", "withdrawn", "ghosted"],
  offer: ["rejected", "withdrawn"],
  rejected: [],
  withdrawn: [],
  ghosted: ["assessment", "interview", "offer", "rejected", "withdrawn"],
};

test("every (from, to) pair behaves as specified", () => {
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      assert.equal(canTransition(from, to), ALLOWED[from].includes(to), `${from} -> ${to}`);
    }
  }
});

test("pipeline stages never move backwards", () => {
  const order: Status[] = ["saved", "applied", "assessment", "interview", "offer"];
  for (let i = 0; i < order.length; i++) {
    for (let j = 0; j <= i; j++) assert.equal(canTransition(order[i]!, order[j]!), false, `${order[i]} -> ${order[j]}`);
  }
});

test("rejected and withdrawn are final; ghosted is not", () => {
  assert.equal(isClosed("rejected"), true);
  assert.equal(isClosed("withdrawn"), true);
  assert.equal(isClosed("ghosted"), false); // they sometimes reply months later
  assert.deepEqual(nextStatuses("rejected"), []);
  assert.equal(canTransition("ghosted", "interview"), true);
});

test("a status can't transition to itself", () => {
  for (const s of STATUSES) assert.equal(canTransition(s, s), false);
});
