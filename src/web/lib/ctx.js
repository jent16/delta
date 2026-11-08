// The few things a screen needs from the app around it (go to another screen, reload, open a panel).
// app.js fills these in at start-up. Screens import this object instead of importing app.js, so
// the arrows between files point one way: app -> screens -> shared pieces, never back.
export const ctx = {
  refresh: async () => {},
  navigate: (_view, _list) => {},
  openApplication: (_id) => {},
  openNew: () => {},
  /** Open a person's panel. `from` is the element that was clicked (optional). */
  openPerson: (_id, _from) => {},
  /** The "add a person" form. `prefill` may carry { company, applicationId, role } to link them straight away. */
  openNewPerson: (_prefill) => {},
};
