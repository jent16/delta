// Domain errors describe what went wrong in the app's own terms. They know
// nothing about HTTP; the API layer is the only place that decides
// "ValidationError means status 400". Keeping that mapping out of the domain
// is what lets the same rules sit behind a CLI or an importer later.

export interface ValidationIssue {
  field: string;
  message: string;
}

export class ValidationError extends Error {
  readonly issues: ValidationIssue[];
  constructor(issues: ValidationIssue[]) {
    super(issues.map((i) => `${i.field}: ${i.message}`).join("; "));
    this.name = "ValidationError";
    this.issues = issues;
  }
}

/** Renaming a company to a name that another of your companies already has. The caller can offer to merge them. */
export class CompanyExistsError extends Error {
  readonly existingId: number;
  readonly existingName: string;
  constructor(existingId: number, existingName: string) {
    super(`you already have a company called "${existingName}"`);
    this.name = "CompanyExistsError";
    this.existingId = existingId;
    this.existingName = existingName;
  }
}

export class NotFoundError extends Error {
  readonly what: string;
  constructor(what: string) {
    super(`${what} not found`);
    this.name = "NotFoundError";
    this.what = what;
  }
}

export class InvalidTransitionError extends Error {
  readonly from: string;
  readonly to: string;
  readonly allowed: readonly string[];
  constructor(from: string, to: string, allowed: readonly string[]) {
    super(`cannot move an application from "${from}" to "${to}"`);
    this.name = "InvalidTransitionError";
    this.from = from;
    this.to = to;
    this.allowed = allowed;
  }
}

export class DuplicateError extends Error {
  readonly existingId: number;
  constructor(existingId: number, what = "application") {
    super(`you already have this ${what} (#${existingId})`);
    this.name = "DuplicateError";
    this.existingId = existingId;
  }
}

/** An outside system (e.g. Notion) refused or failed. The message is safe to show the user. */
export class SourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceError";
  }
}

/** Not signed in, or the email/password didn't match. The message never says which, so it can't be used to find out who has an account. */
export class AuthError extends Error {
  constructor(message = "not signed in") {
    super(message);
    this.name = "AuthError";
  }
}

/** Too many wrong passwords for one email in a short time. */
export class RateLimitedError extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super(`too many attempts; try again in ${Math.ceil(retryAfterSeconds / 60)} minute(s)`);
    this.name = "RateLimitedError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The server was set up not to accept new accounts. */
export class SignupsClosedError extends Error {
  constructor() {
    super("new accounts are turned off on this server");
    this.name = "SignupsClosedError";
  }
}
