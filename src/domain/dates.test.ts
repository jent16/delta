import test from "node:test";
import assert from "node:assert/strict";
import { addDays, daysBetween, isIsoDate, weekStart } from "./dates.ts";

test("weekStart is the Monday of that week, for every day of the week", () => {
  // 2026-09-14 is a Monday
  const expect: [string, string][] = [
    ["2026-09-14", "2026-09-14"], // Monday
    ["2026-09-15", "2026-09-14"],
    ["2026-09-16", "2026-09-14"],
    ["2026-09-17", "2026-09-14"],
    ["2026-09-18", "2026-09-14"],
    ["2026-09-19", "2026-09-14"], // Saturday
    ["2026-09-20", "2026-09-14"], // Sunday belongs to the week that STARTED on Monday the 14th
    ["2026-09-21", "2026-09-21"], // the next Monday starts a new week
  ];
  for (const [day, monday] of expect) assert.equal(weekStart(day), monday, day);
});

test("weekStart crosses month and year boundaries", () => {
  assert.equal(weekStart("2026-03-01"), "2026-02-23"); // a Sunday, in the previous month
  assert.equal(weekStart("2027-01-01"), "2026-12-28"); // a Friday, in the previous year
  assert.equal(weekStart("2024-03-01"), "2024-02-26"); // leap year
});

test("addDays and daysBetween agree, across a daylight-saving change", () => {
  assert.equal(addDays("2026-03-07", 2), "2026-03-09"); // US clocks change on the 8th
  assert.equal(daysBetween("2026-03-07", "2026-03-09"), 2);
  assert.equal(addDays("2026-12-30", 3), "2027-01-02");
  assert.equal(addDays("2026-09-15", -15), "2026-08-31");
  assert.ok(isIsoDate(addDays("2026-01-31", 1)));
});
