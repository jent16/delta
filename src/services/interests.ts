import { NotFoundError, ValidationError } from "../domain/errors.ts";
import type { Interest } from "../domain/interest.ts";
import { parseInterestPatch, parseNewInterest, parseStart } from "../domain/interest.ts";
import type { Application } from "../domain/application.ts";
import type { InterestRepository } from "../domain/ports.ts";
import type { ApplicationService, Clock } from "./applications.ts";

export interface InterestService {
  list(userId: number): Interest[];
  add(userId: number, raw: unknown): Interest;
  edit(userId: number, id: number, raw: unknown): Interest;
  remove(userId: number, id: number): void;
  /**
   * Turns an interest into a real application (stage "saved" or "drafting"), carrying over the company, role, link and
   * note, then removes the interest. It goes through the normal application service, so every usual rule applies
   * (the role is required; a duplicate is refused). If that refuses, the interest is left exactly as it was.
   */
  start(userId: number, id: number, raw: unknown): Application;
}

export function createInterestService(deps: { interests: InterestRepository; applications: ApplicationService; clock: Clock }): InterestService {
  const { interests, applications, clock } = deps;
  const now = () => clock().toISOString();
  const mustFind = (userId: number, id: number) => {
    const i = interests.findById(userId, id);
    if (!i) throw new NotFoundError("interest");
    return i;
  };
  return {
    list: (userId) => interests.all(userId),
    add: (userId, raw) => interests.insert(userId, parseNewInterest(raw), now()),
    edit(userId, id, raw) {
      const patch = parseInterestPatch(raw);
      mustFind(userId, id);
      return interests.update(userId, id, patch, now()) as Interest;
    },
    remove(userId, id) {
      mustFind(userId, id);
      interests.remove(userId, id);
    },
    start(userId, id, raw) {
      const interest = mustFind(userId, id);
      const { status, roleTitle } = parseStart(raw);
      const role = roleTitle ?? interest.roleTitle;
      if (!role) throw new ValidationError([{ field: "roleTitle", message: "is required to start an application" }]);
      const application = applications.add(userId, {
        company: interest.company, roleTitle: role, status,
        ...(interest.url ? { url: interest.url } : {}),
        ...(interest.note ? { notes: interest.note } : {}),
      });
      interests.remove(userId, id); // only after the application exists, so a refusal above loses nothing
      return application;
    },
  };
}
