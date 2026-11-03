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
  constructor(existingId: number) {
    super(`you already have this application (#${existingId})`);
    this.name = "DuplicateError";
    this.existingId = existingId;
  }
}
