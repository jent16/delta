// The HTTP layer. A route does exactly three things: pull values out of the
// request, call a service, shape the response. Business rules do NOT live here
// — if you find yourself writing an `if` about applications in this file, it
// belongs in a service or the domain.

import express from "express";
import type { ErrorRequestHandler, Request } from "express";
import { AuthError, CompanyExistsError, DuplicateError, InvalidTransitionError, NotFoundError, RateLimitedError, SignupsClosedError, SourceError, ValidationError } from "../domain/errors.ts";
import type { AuthService, ProfileService } from "../services/accounts.ts";
import type { ApplicationService } from "../services/applications.ts";
import type { CompanyService } from "../services/companies.ts";
import type { ContactService, SettingsService } from "../services/contacts.ts";
import type { ExportService } from "../services/export.ts";
import type { ImportService } from "../services/import.ts";
import type { LinkedInImportService } from "../services/linkedin-import.ts";
import type { InsightsService } from "../services/insights.ts";
import type { ListService } from "../services/lists.ts";
import { describeVocabulary } from "../domain/vocab.ts";

export interface AppDeps {
  applications: ApplicationService;
  lists: ListService;
  imports: ImportService;
  exports: ExportService;
  companies: CompanyService;
  contacts: ContactService;
  linkedin: LinkedInImportService;
  settings: SettingsService;
  insights: InsightsService;
  /**
   * Who is making this request. Production passes `auth`: every route except sign-in and the two public
   * read-only ones then needs a valid session cookie, and the user is whoever the session belongs to.
   * `currentUserId` is the test-only alternative (a fixed user, no sign-in); passing neither is a mistake.
   */
  auth?: AuthService;
  profile?: ProfileService;
  currentUserId?: (req: Request) => number;
  /** Mark the session cookie Secure (browsers then send it only over https). Turn on when the server is reached over https. */
  secureCookies?: boolean;
  /** Folder of the web UI's static files (index.html, JS, CSS). Omitted in API-only tests. */
  webRoot?: string;
}

const idParam = (req: Request): number => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw new ValidationError([{ field: "id", message: "must be a positive integer" }]);
  return id;
};

// Domain errors -> HTTP. This mapping is the API layer's job and nobody else's.
const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AuthError) return void res.status(401).json({ error: "unauthenticated", message: err.message });
  if (err instanceof RateLimitedError) {
    res.setHeader("Retry-After", String(err.retryAfterSeconds));
    return void res.status(429).json({ error: "rate_limited", message: err.message, retryAfterSeconds: err.retryAfterSeconds });
  }
  if (err instanceof SignupsClosedError) return void res.status(403).json({ error: "signups_closed", message: err.message });
  if (err instanceof ValidationError) return void res.status(400).json({ error: "validation", issues: err.issues });
  if (err instanceof NotFoundError) return void res.status(404).json({ error: "not_found", what: err.what });
  if (err instanceof InvalidTransitionError) {
    return void res.status(409).json({ error: "invalid_transition", message: err.message, from: err.from, to: err.to, allowed: err.allowed });
  }
  if (err instanceof CompanyExistsError) return void res.status(409).json({ error: "company_exists", message: err.message, existingId: err.existingId, existingName: err.existingName });
  if (err instanceof DuplicateError) return void res.status(409).json({ error: "duplicate", message: err.message, existingId: err.existingId });
  if (err instanceof SourceError) return void res.status(502).json({ error: "source_error", message: err.message });
  if ((err as { type?: string }).type === "entity.too.large") return void res.status(413).json({ error: "too_large", message: "that request is too large" });
  if (err instanceof SyntaxError) return void res.status(400).json({ error: "validation", issues: [{ field: "(body)", message: "not valid JSON" }] });
  console.error(err); // an unexpected bug: log the detail, never leak it to the client
  res.status(500).json({ error: "internal" });
};

export function createApp(deps: AppDeps) {
  const { applications, lists, imports, exports: exporter, companies, contacts, settings, linkedin, insights, auth, profile, webRoot } = deps;
  if (!auth && !deps.currentUserId) throw new Error("createApp needs `auth` (production) or `currentUserId` (tests)");
  const signedIn = new WeakMap<Request, { userId: number; tokenHash: string }>();
  const currentUserId = (req: Request): number => {
    if (!auth) return (deps.currentUserId as (r: Request) => number)(req);
    const who = signedIn.get(req);
    if (!who) throw new AuthError(); // a route that forgot to sit behind the sign-in check fails closed, never open
    return who.userId;
  };
  const app = express();
  // a connections file is a few hundred KB, past the default 100 KB limit: allow it on its own routes only (a parser
  // registered first handles the body, so the general one below skips these paths and everything else stays small)
  app.use("/api/import/linkedin", express.json({ limit: "8mb" }));
  app.use(express.json());

  // nothing from the API may be kept by a browser or a shared cache: it is one person's data
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  if (auth) {
    const COOKIE = "delta_session";
    const cookieToken = (req: Request): string | undefined => {
      for (const part of (req.headers.cookie ?? "").split(";")) {
        const i = part.indexOf("=");
        if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim() || undefined;
      }
      return undefined;
    };
    const setCookie = (res: express.Response, token: string) =>
      res.cookie(COOKIE, token, { httpOnly: true, sameSite: "lax", path: "/", secure: deps.secureCookies === true, maxAge: 30 * 86_400_000 });
    const clearCookie = (res: express.Response) => res.clearCookie(COOKIE, { httpOnly: true, sameSite: "lax", path: "/", secure: deps.secureCookies === true });

    // A page on another site can make your browser send a request here WITH your cookie. SameSite=Lax already
    // stops most of that; this refuses what is left: a state-changing request whose Origin is not this server.
    app.use("/api", (req, res, next) => {
      if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
      const origin = req.headers.origin;
      let originHost: string | null = null;
      try { originHost = origin && origin !== "null" ? new URL(origin).host : null; } catch { /* malformed: treated as foreign below */ }
      if (origin && originHost !== req.headers.host) return void res.status(403).json({ error: "bad_origin" });
      if (req.headers["sec-fetch-site"] === "cross-site") return void res.status(403).json({ error: "bad_origin" });
      next();
    });

    // --- public: who am I, sign up, sign in, sign out ---
    app.get("/api/auth/state", (req, res) => {
      const me = auth.authenticate(cookieToken(req));
      res.json({ account: me?.account ?? null, ...auth.state() });
    });
    app.post("/api/auth/signup", (req, res) => {
      const { account, token, claimed } = auth.signUp(req.body);
      setCookie(res, token);
      res.status(201).json({ account, claimed });
    });
    app.post("/api/auth/signin", (req, res) => {
      const { account, token } = auth.signIn(req.body);
      const old = cookieToken(req);
      if (old) auth.signOut(old);
      setCookie(res, token);
      res.json({ account });
    });
    app.post("/api/auth/signout", (req, res) => {
      const token = cookieToken(req);
      if (token) auth.signOut(token);
      clearCookie(res);
      res.status(204).end();
    });

    // --- everything below this line needs a session ---
    app.use("/api", (req, res, next) => {
      if (req.path === "/health" || req.path === "/vocab") return next(); // fixed text, no personal data
      const me = auth.authenticate(cookieToken(req));
      if (!me) {
        clearCookie(res);
        return void res.status(401).json({ error: "unauthenticated", message: "sign in to continue" });
      }
      signedIn.set(req, { userId: me.account.id, tokenHash: me.tokenHash });
      next();
    });

    app.post("/api/auth/change-password", (req, res) => {
      auth.changePassword(currentUserId(req), req.body, signedIn.get(req)!.tokenHash);
      res.status(204).end();
    });
    app.post("/api/auth/delete-account", (req, res) => {
      auth.deleteAccount(currentUserId(req), req.body);
      clearCookie(res);
      res.status(204).end();
    });
  }

  if (profile) {
    app.get("/api/profile", (req, res) => void res.json(profile.get(currentUserId(req))));
    app.patch("/api/profile", (req, res) => void res.json({ profile: profile.edit(currentUserId(req), req.body) }));
    app.post("/api/resume-versions", (req, res) => void res.status(201).json(profile.addResumeVersion(currentUserId(req), req.body)));
    app.patch("/api/resume-versions/:id", (req, res) => void res.json(profile.editResumeVersion(currentUserId(req), idParam(req), req.body)));
    app.delete("/api/resume-versions/:id", (req, res) => {
      profile.removeResumeVersion(currentUserId(req), idParam(req));
      res.status(204).end();
    });
  }

  // the closed lists and the status rules, so a client never keeps its own copy
  app.get("/api/vocab", (_req, res) => void res.json(describeVocabulary()));

  app.get("/api/health", (_req, res) => void res.json({ ok: true }));

  app.post("/api/applications", (req, res) => {
    res.status(201).json(applications.add(currentUserId(req), req.body));
  });

  app.get("/api/applications", (req, res) => {
    res.json({ applications: applications.list(currentUserId(req), req.query as Record<string, unknown>) });
  });

  // before the :id routes, so "bulk" is never read as an id
  app.post("/api/applications/bulk", (req, res) => {
    res.json(applications.editMany(currentUserId(req), req.body));
  });

  app.post("/api/applications/bulk/status", (req, res) => {
    res.json(applications.changeStatusMany(currentUserId(req), req.body));
  });

  // the people linked to an application, other people at its company, and the alumni search links
  app.get("/api/applications/:id/contacts", (req, res) => {
    res.json(contacts.forApplication(currentUserId(req), idParam(req)));
  });

  app.get("/api/applications/:id", (req, res) => {
    res.json(applications.get(currentUserId(req), idParam(req)));
  });

  app.patch("/api/applications/:id", (req, res) => {
    res.json(applications.edit(currentUserId(req), idParam(req), req.body));
  });

  app.post("/api/applications/:id/status", (req, res) => {
    res.json(applications.changeStatus(currentUserId(req), idParam(req), req.body));
  });

  app.post("/api/applications/:id/status/undo", (req, res) => {
    res.json(applications.undoStatusChange(currentUserId(req), idParam(req)));
  });

  // "delete" archives — see the applications table for why
  app.delete("/api/applications/:id", (req, res) => {
    applications.archive(currentUserId(req), idParam(req));
    res.status(204).end();
  });

  // --- people: contacts, the log of what you did with them, and their links to applications ---
  app.get("/api/contacts", (req, res) => {
    res.json({ contacts: contacts.list(currentUserId(req), req.query as Record<string, unknown>) });
  });

  app.post("/api/contacts", (req, res) => {
    res.status(201).json(contacts.add(currentUserId(req), req.body));
  });

  // paste a LinkedIn profile link: adds (or finds) the person and links them to an application. Declared before :id routes.
  app.post("/api/contacts/from-profile", (req, res) => {
    const r = contacts.addFromProfile(currentUserId(req), req.body);
    res.status(r.created ? 201 : 200).json(r);
  });

  app.get("/api/contacts/:id", (req, res) => {
    res.json(contacts.get(currentUserId(req), idParam(req)));
  });

  app.patch("/api/contacts/:id", (req, res) => {
    res.json(contacts.edit(currentUserId(req), idParam(req), req.body));
  });

  // permanent: it removes a person, their log and their links (unlike applications, which archive)
  app.delete("/api/contacts/:id", (req, res) => {
    contacts.remove(currentUserId(req), idParam(req));
    res.status(204).end();
  });

  app.post("/api/contacts/:id/events", (req, res) => {
    res.status(201).json(contacts.addEvent(currentUserId(req), idParam(req), req.body));
  });

  app.post("/api/contacts/:id/links", (req, res) => {
    res.json({ people: contacts.link(currentUserId(req), idParam(req), req.body) });
  });

  app.delete("/api/contacts/:id/links/:applicationId", (req, res) => {
    const applicationId = Number(req.params.applicationId);
    if (!Number.isInteger(applicationId) || applicationId < 1) throw new ValidationError([{ field: "applicationId", message: "must be a positive integer" }]);
    contacts.unlink(currentUserId(req), idParam(req), applicationId);
    res.status(204).end();
  });

  // --- preferences (today: the school the alumni helper searches for) ---
  app.get("/api/settings", (req, res) => {
    res.json(settings.get(currentUserId(req)));
  });

  app.patch("/api/settings", (req, res) => {
    res.json(settings.edit(currentUserId(req), req.body));
  });

  // --- saved lists (filters over the applications table) ---
  app.get("/api/lists", (req, res) => {
    res.json({ lists: lists.all(currentUserId(req)) });
  });

  app.post("/api/lists", (req, res) => {
    res.status(201).json(lists.create(currentUserId(req), req.body));
  });

  app.get("/api/lists/:id", (req, res) => {
    res.json(lists.get(currentUserId(req), idParam(req)));
  });

  app.get("/api/lists/:id/applications", (req, res) => {
    res.json(lists.applications(currentUserId(req), idParam(req), req.query as Record<string, unknown>));
  });

  app.patch("/api/lists/:id", (req, res) => {
    res.json(lists.edit(currentUserId(req), idParam(req), req.body));
  });

  // a list is only a view, so deleting one really deletes it — no application is touched
  app.delete("/api/lists/:id", (req, res) => {
    lists.remove(currentUserId(req), idParam(req));
    res.status(204).end();
  });

  // --- import from Notion: preview changes nothing, commit writes ---
  app.post("/api/import/notion/preview", async (req, res) => {
    res.json(await imports.preview(currentUserId(req), req.body));
  });

  app.post("/api/import/notion/commit", async (req, res) => {
    res.json(await imports.commit(currentUserId(req), req.body));
  });

  // --- import your LinkedIn connections: preview changes nothing, commit writes ---
  app.post("/api/import/linkedin/preview", (req, res) => {
    res.json(linkedin.preview(currentUserId(req), req.body));
  });

  app.post("/api/import/linkedin/commit", (req, res) => {
    res.json(linkedin.commit(currentUserId(req), req.body));
  });

  // --- companies: the name and sector, stored once and shared by every application there ---
  // "search" is declared before ":id" so it is never read as an id
  app.get("/api/companies/search", async (req, res) => {
    res.json(await companies.search(currentUserId(req), req.query as Record<string, unknown>));
  });

  app.get("/api/companies", (req, res) => {
    res.json({ companies: companies.list(currentUserId(req)) });
  });

  app.patch("/api/companies/:id", (req, res) => {
    res.json(companies.edit(currentUserId(req), idParam(req), req.body));
  });

  app.post("/api/companies/:id/merge", (req, res) => {
    res.json(companies.merge(currentUserId(req), idParam(req), req.body));
  });

  // --- how it's going, and what needs attention ---
  app.get("/api/pipeline", (req, res) => {
    res.json(insights.pipeline(currentUserId(req), req.query as Record<string, unknown>));
  });

  app.get("/api/breakdowns", (req, res) => {
    res.json(insights.breakdowns(currentUserId(req), req.query as Record<string, unknown>));
  });

  app.get("/api/stats", (req, res) => {
    res.json(insights.stats(currentUserId(req), req.query as Record<string, unknown>));
  });

  app.get("/api/reminders", (req, res) => {
    res.json(insights.reminders(currentUserId(req), req.query as Record<string, unknown>));
  });

  // --- export: your data as a file you can open anywhere (not the backup; see db/backup.ts) ---
  app.get("/api/export", (req, res) => {
    const { filename, body } = exporter.json(currentUserId(req));
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.json(body);
  });

  app.get("/api/export.csv", (req, res) => {
    const { filename, body } = exporter.csv(currentUserId(req));
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.type("text/csv; charset=utf-8").send(body);
  });

  // --- the web UI: plain static files ---
  if (webRoot) {
    // Everything on screen is text from your own data (some of it imported from elsewhere), so the page may
    // only run scripts from this server and may not send data anywhere else. Belt and braces with the UI
    // never using innerHTML.
    app.use((req, res, next) => {
      if (!req.path.startsWith("/api/")) {
        res.setHeader(
          "Content-Security-Policy",
          "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        );
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Referrer-Policy", "no-referrer");
      }
      next();
    });
    app.use(express.static(webRoot, { index: "index.html" }));
  }

  app.use(errorHandler);
  return app;
}
