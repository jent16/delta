// What the page remembers between renders. One object, so "what does the UI know?" has one answer.

export const state = {
  view: "dashboard",         // dashboard | applications | reminders
  list: "all",               // "all" or a saved list's id (as a string)
  statusFilter: "all",       // the chip row above the table
  query: "",                 // the search box
  sort: { key: "updated", dir: "desc" },
  selected: new Set(),       // ids ticked in the table
  flash: null,               // id of a just-added row, so it can be highlighted once
};

// Filled once at start-up from /api/vocab: the closed lists and the status rules, straight from the server.
export const vocab = { statuses: [], transitions: {}, roleFunctions: [], sectors: [], progressStages: [] };
export function setVocab(v) { Object.assign(vocab, v); }

export const label = (status) => status.charAt(0).toUpperCase() + status.slice(1);
export const movesFrom = (status) => vocab.transitions[status] ?? [];
