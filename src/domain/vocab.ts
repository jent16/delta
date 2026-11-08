// Closed lists for the two dimensions a "list" filters on.
//
// A role's function (SWE, PM) and its sector (Fintech) are independent
// properties of one application — a Fintech SWE role is both. Modelling them
// separately is what lets "SWE", "PM" and "Fintech-adjacent" be saved filters
// over one table instead of three tables holding copies.
//
// Deliberately NOT imported from the legacy lib/industries.js: the tracker
// owns its vocabulary, so changing the old scoring module can't break it.

import { EVENT_KINDS, LINK_ROLES, RELATIONSHIPS } from "./contact.ts";
import { PROGRESS_STAGES } from "./progress.ts";
import { nextStatuses, STATUSES } from "./status.ts";
import type { Status } from "./status.ts";

export const ROLE_FUNCTIONS = ["SWE", "PM", "Data", "Quant", "Design", "Other"] as const;
export type RoleFunction = (typeof ROLE_FUNCTIONS)[number];

// "Finance" is the firms that ARE the market (quant/trading firms, banks,
// private equity, asset managers); "Fintech" is software companies serving it
// (payments, neobanks, trading apps). An SWE role at either is "fintech-adjacent"
// — the saved list matches both — but they are different employers.
export const SECTORS = [
  "Fintech",
  "Finance",
  "Healthcare",
  "E-commerce/Retail",
  "Enterprise Software",
  "Consumer Tech",
  "Gaming/Entertainment",
  "Automotive/Transportation",
  "Aerospace/Defense",
  "Telecom",
  "Energy",
  "Government/Public Sector",
  "Consulting",
  "Education",
  "Media",
  "General Technology",
] as const;
export type Sector = (typeof SECTORS)[number];

/**
 * Everything a client needs to draw pickers and legal "move to" menus, taken from the domain itself.
 * The web UI asks for this instead of keeping its own copy of the status rules, so the two can never disagree.
 */
export function describeVocabulary() {
  const transitions = Object.fromEntries(STATUSES.map((s) => [s, [...nextStatuses(s)]])) as Record<Status, Status[]>;
  return {
    statuses: [...STATUSES],
    transitions,
    roleFunctions: [...ROLE_FUNCTIONS],
    sectors: [...SECTORS],
    progressStages: [...PROGRESS_STAGES],
    relationships: [...RELATIONSHIPS],
    linkRoles: [...LINK_ROLES],
    eventKinds: [...EVENT_KINDS],
  };
}
