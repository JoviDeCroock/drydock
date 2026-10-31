import { Hono } from "hono";
import { readJsonObject } from "../lib/platform/http";
import { guardRateLimit } from "../lib/rate-limit";
import { requireVerifiedEmail } from "../lib/auth/email-verification";
import { recordScanEvent } from "../db/events";
import {
  deletePyPiProjectToken,
  findPyPiProjectToken,
  getPyPiProjectToken,
  insertPyPiProjectToken,
  listPyPiProjectTokens,
  markTokenSessionsRemoved,
  publicPyPiProjectToken,
  updatePyPiProjectToken,
} from "../db/pypi-stage-sessions";
import {
  requireActiveOrganization,
  requireOrganizationRole,
} from "../lib/auth/active-organization";
import { roleCanManageIntegrations } from "../lib/auth/roles";
import { isValidPyPiProjectName, normalizePyPiProjectName } from "../lib/ecosystems/pypi/manifest";
import {
  openPyPiToken,
  pyPiTokenProblem,
  sealPyPiToken,
} from "../lib/ecosystems/pypi/project-token";
import { PYPI_STAGE_INDEX_ORIGINS } from "../lib/ecosystems/pypi/types";
import type { Bindings, Variables } from "../types";

/**
 * PEP 694 mode B (preview): per-project PyPI API tokens an organization opts
 * into so Drydock can hold, publish, and cancel staged sessions. Session-only
 * and organization-scoped; the token is write-only from the browser's side and
 * never appears in a response, event, or log.
 */
export const pypiProjectTokenRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

pypiProjectTokenRoutes.get("/", async (c) => {
  const db = c.var.db;
  const organizationId = await requireActiveOrganization(c, db);
  const rows = await listPyPiProjectTokens(db, organizationId);
  return c.json({ tokens: rows.map(publicPyPiProjectToken), indexes: PYPI_STAGE_INDEX_ORIGINS });
});

pypiProjectTokenRoutes.post("/", async (c) => {
  const unverified = requireVerifiedEmail(c);
  if (unverified) return unverified;
  const body = await readJsonObject<{ project?: unknown; index?: unknown; token?: unknown }>(c);
  const project = typeof body.project === "string" ? body.project.trim() : "";
  const index = typeof body.index === "string" ? body.index.trim() : "https://pypi.org";
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!isValidPyPiProjectName(project)) {
    return c.json({ error: "project must be a valid PyPI project name" }, 400);
  }
  if (!PYPI_STAGE_INDEX_ORIGINS.includes(index)) {
    return c.json({ error: `index must be one of ${PYPI_STAGE_INDEX_ORIGINS.join(", ")}` }, 400);
  }
  const normalized = normalizePyPiProjectName(project);
  const problem = pyPiTokenProblem(token, normalized);
  if (problem) return c.json({ error: problem, code: "pypi_token_not_project_scoped" }, 400);

  const db = c.var.db;
  const session = c.get("authSession");
  const { organizationId } = await requireOrganizationRole(c, db, roleCanManageIntegrations);
  const limited = await guardRateLimit(c, tokenWriteLimit(organizationId), TOKEN_LIMIT_MESSAGE);
  if (limited) return limited;
  if (await findPyPiProjectToken(db, organizationId, index, normalized)) {
    return c.json({ error: "a token for this project is already stored; rotate it instead" }, 409);
  }
  const row = await insertPyPiProjectToken(db, {
    organizationId,
    projectName: normalized,
    indexOrigin: index,
    ...(await sealPyPiToken(c.env, token)),
    validatedAt: new Date(),
    lastUsedAt: null,
    createdByUserId: session.userId,
  });
  if (!row) {
    return c.json({ error: "a token for this project is already stored; rotate it instead" }, 409);
  }
  await recordTokenEvent(db, organizationId, session.userId, "pypi_token.added", row);
  return c.json({ token: publicPyPiProjectToken(row) }, 201);
});

pypiProjectTokenRoutes.put("/:id", async (c) => {
  const unverified = requireVerifiedEmail(c);
  if (unverified) return unverified;
  const body = await readJsonObject<{ token?: unknown }>(c);
  const token = typeof body.token === "string" ? body.token.trim() : "";
  const db = c.var.db;
  const session = c.get("authSession");
  const { organizationId } = await requireOrganizationRole(c, db, roleCanManageIntegrations);
  const limited = await guardRateLimit(c, tokenWriteLimit(organizationId), TOKEN_LIMIT_MESSAGE);
  if (limited) return limited;
  const existing = await getPyPiProjectToken(db, organizationId, c.req.param("id"));
  if (!existing) return c.json({ error: "not found" }, 404);
  const problem = pyPiTokenProblem(token, existing.projectName);
  if (problem) return c.json({ error: problem, code: "pypi_token_not_project_scoped" }, 400);
  const row = await updatePyPiProjectToken(db, organizationId, existing.id, {
    ...(await sealPyPiToken(c.env, token)),
    validatedAt: new Date(),
  });
  if (!row) return c.json({ error: "not found" }, 404);
  await recordTokenEvent(db, organizationId, session.userId, "pypi_token.rotated", row);
  return c.json({ token: publicPyPiProjectToken(row) });
});

// Offline check: the stored token still decrypts and is still scoped to its
// project. PEP 694 exposes no credential probe, so nothing is sent to PyPI.
pypiProjectTokenRoutes.post("/:id/validate", async (c) => {
  const unverified = requireVerifiedEmail(c);
  if (unverified) return unverified;
  const db = c.var.db;
  const session = c.get("authSession");
  const { organizationId } = await requireOrganizationRole(c, db, roleCanManageIntegrations);
  const limited = await guardRateLimit(c, tokenWriteLimit(organizationId), TOKEN_LIMIT_MESSAGE);
  if (limited) return limited;
  const existing = await getPyPiProjectToken(db, organizationId, c.req.param("id"));
  if (!existing) return c.json({ error: "not found" }, 404);
  let problem: string | null;
  try {
    problem = pyPiTokenProblem(await openPyPiToken(c.env, existing), existing.projectName);
  } catch {
    problem = "the stored token can no longer be decrypted; rotate it";
  }
  if (problem) {
    return c.json({ token: publicPyPiProjectToken(existing), ok: false, error: problem });
  }
  const row =
    (await updatePyPiProjectToken(db, organizationId, existing.id, { validatedAt: new Date() })) ??
    existing;
  await recordTokenEvent(db, organizationId, session.userId, "pypi_token.validated", row);
  return c.json({ token: publicPyPiProjectToken(row), ok: true });
});

pypiProjectTokenRoutes.delete("/:id", async (c) => {
  const unverified = requireVerifiedEmail(c);
  if (unverified) return unverified;
  const db = c.var.db;
  const session = c.get("authSession");
  const { organizationId } = await requireOrganizationRole(c, db, roleCanManageIntegrations);
  const limited = await guardRateLimit(c, tokenWriteLimit(organizationId), TOKEN_LIMIT_MESSAGE);
  if (limited) return limited;
  const existing = await getPyPiProjectToken(db, organizationId, c.req.param("id"));
  if (!existing) return c.json({ error: "not found" }, 404);
  // Sessions held with this token can never be acted on again; settle them
  // visibly instead of leaving them to poll without a credential.
  const stranded = await markTokenSessionsRemoved(db, organizationId, existing.id);
  const row = await deletePyPiProjectToken(db, organizationId, existing.id);
  if (!row) return c.json({ error: "not found" }, 404);
  await recordTokenEvent(db, organizationId, session.userId, "pypi_token.deleted", row);
  for (const held of stranded) {
    await recordScanEvent(db, {
      organizationId,
      actorUserId: session.userId,
      type: "pypi_session.token_removed",
      metadata: { gateId: held.gateId, projectName: held.projectName, version: held.version },
    });
  }
  return c.json({ ok: true });
});

const TOKEN_LIMIT_MESSAGE = "PyPI token rate limit exceeded";

function tokenWriteLimit(organizationId: string) {
  return { key: `pypi-project-token:write:${organizationId}`, limit: 20, windowMs: 60 * 60 * 1000 };
}

async function recordTokenEvent(
  db: Parameters<typeof recordScanEvent>[0],
  organizationId: string,
  actorUserId: string,
  type: string,
  row: { projectName: string; indexOrigin: string },
): Promise<void> {
  await recordScanEvent(db, {
    organizationId,
    actorUserId,
    type,
    metadata: { projectName: row.projectName, index: row.indexOrigin },
  });
}
