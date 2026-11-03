// The application pipeline, as a state machine.
//
//   saved -> applied -> assessment -> interview -> offer
//   any open stage can also end as: rejected / withdrawn / ghosted
//
// A status is a closed set, so it is a union type (not free text): the
// compiler rejects a typo, the database CHECK rejects a bad row, and "which
// statuses mean applied?" has one answer for every stat we compute later.
//
// (A string-literal union instead of a TypeScript `enum`: enums generate
// runtime code, which Node's built-in type stripping can't run.)

export const STATUSES = ["saved", "applied", "assessment", "interview", "offer", "rejected", "withdrawn", "ghosted"] as const;
export type Status = (typeof STATUSES)[number];

// The rules, written as data so they can be read, tested exhaustively, and
// changed in exactly one place.
//   - stages only move forward (skipping is fine: many roles have no assessment)
//   - rejected and withdrawn are final
//   - ghosted is *stalled*, not final: they sometimes reply months later
const TRANSITIONS: Readonly<Record<Status, readonly Status[]>> = {
  saved: ["applied", "withdrawn"],
  applied: ["assessment", "interview", "offer", "rejected", "withdrawn", "ghosted"],
  assessment: ["interview", "offer", "rejected", "withdrawn", "ghosted"],
  interview: ["offer", "rejected", "withdrawn", "ghosted"],
  offer: ["rejected", "withdrawn"], // rescinded, or you declined
  rejected: [],
  withdrawn: [],
  ghosted: ["assessment", "interview", "offer", "rejected", "withdrawn"],
};

export function isStatus(value: unknown): value is Status {
  return typeof value === "string" && (STATUSES as readonly string[]).includes(value);
}

export function nextStatuses(from: Status): readonly Status[] {
  return TRANSITIONS[from];
}

export function canTransition(from: Status, to: Status): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Final states: nothing further can happen to this application. */
export function isClosed(status: Status): boolean {
  return TRANSITIONS[status].length === 0;
}
