// The HTTP layer. A route does exactly three things: pull values out of the
// request, call a service, shape the response. Business rules do NOT live here
// — if you find yourself writing an `if` about applications in this file, it
// belongs in a service or the domain.

import express from "express";
import type { ErrorRequestHandler, Request } from "express";
import { DuplicateError, InvalidTransitionError, NotFoundError, SourceError, ValidationError } from "../domain/errors.ts";
import type { ApplicationService } from "../services/applications.ts";
import type { CompanyService } from "../services/companies.ts";
import type { ExportService } from "../services/export.ts";
import type { ImportService } from "../services/import.ts";
import type { InsightsService } from "../services/insights.ts";
import type { ListService } from "../services/lists.ts";

export interface AppDeps {
  applications: ApplicationService;
  lists: ListService;
  imports: ImportService;
  exports: ExportService;
  companies: CompanyService;
  insights: InsightsService;
  /**
   * The one place "who is making this request" is decided. Today there is a
   * single local user. When login exists, this reads a session instead —
   * and nothing below it changes, because every service call already takes a userId.
   */
  currentUserId: (req: Request) => number;
}

const idParam = (req: Request): number => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw new ValidationError([{ field: "id", message: "must be a positive integer" }]);
  return id;
};

// Domain errors -> HTTP. This mapping is the API layer's job and nobody else's.
const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ValidationError) return void res.status(400).json({ error: "validation", issues: err.issues });
  if (err instanceof NotFoundError) return void res.status(404).json({ error: "not_found", what: err.what });
  if (err instanceof InvalidTransitionError) {
    return void res.status(409).json({ error: "invalid_transition", message: err.message, from: err.from, to: err.to, allowed: err.allowed });
  }
  if (err instanceof DuplicateError) return void res.status(409).json({ error: "duplicate", message: err.message, existingId: err.existingId });
  if (err instanceof SourceError) return void res.status(502).json({ error: "source_error", message: err.message });
  if (err instanceof SyntaxError) return void res.status(400).json({ error: "validation", issues: [{ field: "(body)", message: "not valid JSON" }] });
  console.error(err); // an unexpected bug: log the detail, never leak it to the client
  res.status(500).json({ error: "internal" });
};

export function createApp(deps: AppDeps) {
  const { applications, lists, imports, exports: exporter, companies, insights, currentUserId } = deps;
  const app = express();
  app.use(express.json());

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

  // --- company search, for the quick-add box ---
  app.get("/api/companies/search", async (req, res) => {
    res.json(await companies.search(currentUserId(req), req.query as Record<string, unknown>));
  });

  // --- how it's going, and what needs attention ---
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

  app.use(errorHandler);
  return app;
}
