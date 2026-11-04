// Closed lists for the two dimensions a "list" filters on.
//
// A role's function (SWE, PM) and its sector (Fintech) are independent
// properties of one application — a Fintech SWE role is both. Modelling them
// separately is what lets "SWE", "PM" and "Fintech-adjacent" be saved filters
// over one table instead of three tables holding copies.
//
// Deliberately NOT imported from the legacy lib/industries.js: the tracker
// owns its vocabulary, so changing the old scoring module can't break it.

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
