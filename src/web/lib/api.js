// The only file that talks to the server. Views call these functions and never build URLs or read
// raw responses, so if an endpoint changes there is one place to fix.

export class ApiError extends Error {
  constructor(status, body, message) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** A sentence a person can read, from whatever went wrong. */
export function describeError(err) {
  if (!(err instanceof ApiError)) return "Something went wrong.";
  const b = err.body;
  if (err.status === 0) return "Can't reach the tracker. Is it still running?";
  if (b?.error === "validation" && (b.issues ?? []).some((i) => (i.field === "password" || i.field === "current") && i.message === "is not right")) return "That password isn't right.";
  if (b?.error === "validation") return (b.issues ?? []).map((i) => (i.field && i.field !== "(body)" ? `${i.field}: ${i.message}` : i.message)).join(". ") || "That wasn't valid.";
  if (b?.error === "invalid_transition" || b?.error === "duplicate" || b?.error === "company_exists") return b.message;
  if (b?.error === "unauthenticated" || b?.error === "rate_limited" || b?.error === "signups_closed") return b.message;
  if (b?.error === "bad_origin") return "That request didn't come from this page, so it was refused.";
  if (b?.error === "not_found") return `That ${b.what ?? "item"} no longer exists.`;
  return "The tracker had a problem with that. Nothing was changed.";
}

// When the server says "sign in" (the session ended, or was ended from another browser), the app shows the sign-in page.
// The sign-in calls themselves are exempt: a wrong password is a normal answer, not a lost session.
let onUnauthorized = () => {};
export const whenSignedOut = (fn) => { onUnauthorized = fn; };

async function request(method, path, body, signal) {
  let res;
  try {
    res = await fetch(path, {
      method,
      signal,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    throw new ApiError(0, null, "network");
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (res.status === 401 && !path.startsWith("/api/auth/sign")) onUnauthorized();
  if (!res.ok) throw new ApiError(res.status, data, `${method} ${path} -> ${res.status}`);
  return data;
}

const query = (params) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
};
const scope = (listId) => (listId && listId !== "all" ? { list: listId } : {});

export const api = {
  vocab: () => request("GET", "/api/vocab"),
  authState: () => request("GET", "/api/auth/state"),
  signUp: (body) => request("POST", "/api/auth/signup", body),
  signIn: (body) => request("POST", "/api/auth/signin", body),
  signOut: () => request("POST", "/api/auth/signout"),
  changePassword: (current, next) => request("POST", "/api/auth/change-password", { current, next }),
  deleteAccount: (password) => request("POST", "/api/auth/delete-account", { password }),
  profile: () => request("GET", "/api/profile"),
  editProfile: (patch) => request("PATCH", "/api/profile", patch).then((r) => r.profile),
  addResumeVersion: (name, note) => request("POST", "/api/resume-versions", { name, ...(note ? { note } : {}) }),
  editResumeVersion: (id, patch) => request("PATCH", `/api/resume-versions/${id}`, patch),
  removeResumeVersion: (id) => request("DELETE", `/api/resume-versions/${id}`),
  lists: () => request("GET", "/api/lists").then((r) => r.lists),
  pipeline: (listId) => request("GET", `/api/pipeline${query(scope(listId))}`),
  stats: (listId) => request("GET", `/api/stats${query(scope(listId))}`),
  applications: (params = {}) => request("GET", `/api/applications${query(params)}`).then((r) => r.applications),
  contacts: (params = {}) => request("GET", `/api/contacts${query(params)}`).then((r) => r.contacts),
  contact: (id) => request("GET", `/api/contacts/${id}`),
  createContact: (body) => request("POST", "/api/contacts", body),
  editContact: (id, patch) => request("PATCH", `/api/contacts/${id}`, patch),
  deleteContact: (id) => request("DELETE", `/api/contacts/${id}`),
  addContactEvent: (id, body) => request("POST", `/api/contacts/${id}/events`, body),
  linkContact: (id, applicationId, role) => request("POST", `/api/contacts/${id}/links`, { applicationId, role }),
  unlinkContact: (id, applicationId) => request("DELETE", `/api/contacts/${id}/links/${applicationId}`),
  applicationPeople: (id) => request("GET", `/api/applications/${id}/contacts`),
  previewLinkedIn: (csv, accept) => request("POST", "/api/import/linkedin/preview", { csv, ...(accept && Object.keys(accept).length ? { accept } : {}) }),
  commitLinkedIn: (csv, accept) => request("POST", "/api/import/linkedin/commit", { csv, ...(accept && Object.keys(accept).length ? { accept } : {}) }),
  addFromProfile: (body) => request("POST", "/api/contacts/from-profile", body),
  settings: () => request("GET", "/api/settings"),
  editSettings: (patch) => request("PATCH", "/api/settings", patch),
  breakdowns: (listId) => request("GET", `/api/breakdowns${query(scope(listId))}`),
  reminders: () => request("GET", "/api/reminders"),
  application: (id) => request("GET", `/api/applications/${id}`),
  create: (body) => request("POST", "/api/applications", body),
  edit: (id, patch) => request("PATCH", `/api/applications/${id}`, patch),
  changeStatus: (id, status, note) => request("POST", `/api/applications/${id}/status`, { status, ...(note ? { note } : {}) }),
  undo: (id) => request("POST", `/api/applications/${id}/status/undo`),
  archive: (id) => request("DELETE", `/api/applications/${id}`),
  bulkEdit: (ids, set) => request("POST", "/api/applications/bulk", { ids, set }),
  bulkStatus: (ids, status, note) => request("POST", "/api/applications/bulk/status", { ids, status, ...(note ? { note } : {}) }),
  companies: () => request("GET", "/api/companies").then((r) => r.companies),
  editCompany: (id, patch) => request("PATCH", `/api/companies/${id}`, patch),
  mergeCompany: (id, into) => request("POST", `/api/companies/${id}/merge`, { into }),
  searchCompanies: (q, signal) => request("GET", `/api/companies/search${query({ q })}`, undefined, signal),
};
