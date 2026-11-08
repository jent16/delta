// What the page remembers between renders. One object, so "what does the UI know?" has one answer.

export const state = {
  account: null,             // who is signed in: { id, name, email }, or null (then the sign-in page shows)
  resumeNames: [],           // the names on the profile's resume list, offered as suggestions in an application
  view: "dashboard",         // dashboard | applications | reminders
  list: "all",               // "all" or a saved list's id (as a string)
  insightsList: "all",       // the list the Insights screen is looking at (separate, so choosing one there does not change the table)
  statusFilter: "all",       // the chip row above the table
  query: "",                 // the search box
  sort: { key: "updated", dir: "desc" },
  selected: new Set(),       // ids ticked in the table
  flash: null,               // id of a just-added row, so it can be highlighted once
};

/** Forgets everything about the person who was here, so the next one starts clean. */
export function resetState() {
  Object.assign(state, { account: null, resumeNames: [], view: "dashboard", list: "all", insightsList: "all", statusFilter: "all", query: "", sort: { key: "updated", dir: "desc" }, flash: null });
  state.selected.clear();
}

// Filled once at start-up from /api/vocab: the closed lists and the status rules, straight from the server.
export const vocab = { statuses: [], transitions: {}, roleFunctions: [], sectors: [], progressStages: [] };
export function setVocab(v) { Object.assign(vocab, v); }

export const label = (status) => status.charAt(0).toUpperCase() + status.slice(1);
export const movesFrom = (status) => vocab.transitions[status] ?? [];
