// How "the same name" is decided when storing and looking things up.
//
// This is deliberately SIMPLE: lowercase the ASCII letters, collapse runs of spaces/tabs/newlines, trim.
// Why not smarter (drop "Inc.", punctuation, accents)? Because the database migration has to compute
// exactly the same key in plain SQL for the rows you already have, and SQLite's lower() only knows
// ASCII. A smarter key would quietly disagree with the stored one. The smarter fuzzy matching lives in
// company.ts and only ever SUGGESTS ("did you mean Stripe?"); it never decides identity.
//
// A test runs this function and the SQL migration's expression over the same awkward strings and
// requires identical answers.

export function identityKey(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/[A-Z]/g, (c) => c.toLowerCase())
    .replace(/[ \t\r\n]+/g, " ")
    .replace(/^ +| +$/g, "");
}
