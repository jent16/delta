// Best-effort sector guesses for well-known employers, used ONLY by importers
// when a row has no sector and the caller didn't supply one. They exist so a
// freshly imported tracker isn't invisible to the "Fintech-adjacent" list.
//
// These are guesses, shown as guesses in every import preview, and editable
// afterwards. The table is deliberately short and unambiguous: a missing entry
// just leaves the sector blank, while a wrong one quietly mislabels your data.

import { normalizeCompany } from "./company.ts";
import type { Sector } from "./vocab.ts";

// "Finance" = firms that are the market; "Fintech" = software serving it.
const HINTS: Record<string, Sector> = {
  // trading firms, funds, banks, insurers
  "jane street": "Finance", "two sigma": "Finance", "citadel": "Finance", "citadel securities": "Finance",
  "point72": "Finance", "schonfeld": "Finance", "schonfield": "Finance", "hudson river trading": "Finance",
  "jump trading": "Finance", "optiver": "Finance", "imc trading": "Finance", "drw": "Finance",
  "susquehanna": "Finance", "d e shaw": "Finance", "goldman sachs": "Finance", "jpmorgan": "Finance",
  "jp morgan": "Finance", "morgan stanley": "Finance", "blackrock": "Finance", "capital one": "Finance",
  "fidelity": "Finance", "american express": "Finance", "amex": "Finance", "assured guaranty": "Finance",
  "guardian life": "Finance", "j p morgan": "Finance", "sig": "Finance", "sig susquehanna": "Finance",
  "susquehann": "Finance", "citadel citadel securities": "Finance", "deutsche": "Finance", "deutsche bank": "Finance",
  "dv trading": "Finance", "five rings": "Finance", "tower research": "Finance", "tower research capital": "Finance",
  "walleye capital": "Finance", "brevan howard": "Finance", "capstone investment advisors": "Finance",
  // software companies serving finance
  "stripe": "Fintech", "coinbase": "Fintech", "robinhood": "Fintech", "affirm": "Fintech", "plaid": "Fintech",
  "ramp": "Fintech", "brex": "Fintech", "block": "Fintech", "paypal": "Fintech", "chime": "Fintech",
  "sofi": "Fintech", "klarna": "Fintech", "marqeta": "Fintech", "talos": "Fintech", "bloomberg": "Fintech",
};

export function guessSector(company: string): Sector | null {
  return HINTS[normalizeCompany(company)] ?? null;
}
