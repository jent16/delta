// Use-cases for people: add and edit them, log what you did with them, link them to applications, and
// offer the alumni search links for a company. Storage is behind ports; nothing here knows SQL or HTTP.

import { alumniLinks } from "../domain/alumni.ts";
import type { AlumniLink } from "../domain/alumni.ts";
import { parseContactPatch, parseContactQuery, parseEvent, parseLink, parseNewContact } from "../domain/contact.ts";
import type { Contact, ContactEvent, ContactSummary, LinkedApplication, LinkedContact } from "../domain/contact.ts";
import { toIsoDate } from "../domain/dates.ts";
import { NotFoundError } from "../domain/errors.ts";
import type { ApplicationRepository, ContactRepository, SettingsRepository } from "../domain/ports.ts";
import { DEFAULT_SETTINGS, parseSettingsPatch } from "../domain/settings.ts";
import type { Settings } from "../domain/settings.ts";
import type { Clock } from "./applications.ts";

export interface ContactService {
  add(userId: number, raw: unknown): Contact;
  get(userId: number, id: number): { contact: Contact; events: ContactEvent[]; applications: LinkedApplication[]; alumni: AlumniLink[] };
  list(userId: number, rawQuery: Record<string, unknown>): ContactSummary[];
  edit(userId: number, id: number, raw: unknown): Contact;
  /** Permanent: removes the person, their log and their links. */
  remove(userId: number, id: number): void;
  addEvent(userId: number, id: number, raw: unknown): ContactEvent;
  /** Links a person to an application with a role; linking again changes the role. Returns the application's people. */
  link(userId: number, id: number, raw: unknown): LinkedContact[];
  unlink(userId: number, id: number, applicationId: number): void;
  /** For an application's panel: who is linked, other people you know at that company, and the alumni search links. */
  forApplication(userId: number, applicationId: number): { people: LinkedContact[]; atCompany: Contact[]; alumni: AlumniLink[] };
}

export interface SettingsService {
  get(userId: number): Settings;
  edit(userId: number, raw: unknown): Settings;
}

export function createSettingsService(deps: { settings: SettingsRepository }): SettingsService {
  const { settings } = deps;
  const get = (userId: number): Settings => ({ school: settings.all(userId).school ?? DEFAULT_SETTINGS.school });
  return {
    get,
    edit(userId, raw) {
      const patch = parseSettingsPatch(raw);
      for (const [key, value] of Object.entries(patch)) settings.set(userId, key, value ?? null);
      return get(userId);
    },
  };
}

export function createContactService(deps: { contacts: ContactRepository; applications: ApplicationRepository; settings: SettingsService; clock: Clock }): ContactService {
  const { contacts, applications, settings, clock } = deps;
  const now = () => clock().toISOString();
  const today = () => toIsoDate(clock());
  const mustFind = (userId: number, id: number): Contact => {
    const c = contacts.findById(userId, id);
    if (!c) throw new NotFoundError("contact");
    return c;
  };

  return {
    add(userId, raw) {
      return contacts.insert(userId, parseNewContact(raw), now());
    },

    get(userId, id) {
      const contact = mustFind(userId, id);
      return {
        contact,
        events: contacts.events(userId, id),
        applications: contacts.applicationsOf(userId, id),
        alumni: contact.company ? alumniLinks(settings.get(userId).school, contact.company) : [],
      };
    },

    list(userId, rawQuery) {
      return contacts.list(userId, parseContactQuery(rawQuery, today()));
    },

    edit(userId, id, raw) {
      const patch = parseContactPatch(raw);
      mustFind(userId, id);
      return contacts.update(userId, id, patch, now()) as Contact;
    },

    remove(userId, id) {
      mustFind(userId, id);
      contacts.remove(userId, id);
    },

    addEvent(userId, id, raw) {
      const event = parseEvent(raw, today());
      mustFind(userId, id);
      return contacts.addEvent(userId, id, event, now()) as ContactEvent;
    },

    link(userId, id, raw) {
      const { applicationId, role } = parseLink(raw);
      mustFind(userId, id);
      if (!applications.findById(userId, applicationId)) throw new NotFoundError("application");
      contacts.link(userId, id, applicationId, role, now());
      return contacts.forApplication(userId, applicationId);
    },

    unlink(userId, id, applicationId) {
      mustFind(userId, id);
      if (!applications.findById(userId, applicationId)) throw new NotFoundError("application");
      contacts.unlink(userId, id, applicationId);
    },

    forApplication(userId, applicationId) {
      const application = applications.findById(userId, applicationId);
      if (!application) throw new NotFoundError("application");
      const people = contacts.forApplication(userId, applicationId);
      const linked = new Set(people.map((p) => p.contact.id));
      return {
        people,
        atCompany: contacts.list(userId, { companyId: application.companyId }).filter((c) => !linked.has(c.id)),
        alumni: alumniLinks(settings.get(userId).school, application.company),
      };
    },
  };
}
