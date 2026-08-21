/**
 * GitHub App routes, mounted under /api/v1/github-app.
 *
 * Split by resource: installing the app, the release targets it watches, and
 * the gate decisions reviewers make against it. There is no router-level
 * middleware — each handler establishes its own organization context — so the
 * groups compose without ordering constraints.
 */
import { Hono } from "hono";
import type { Bindings, Variables } from "../../types";
import { installationRoutes } from "./installations";
import { releaseTargetRoutes } from "./release-targets";
import { workflowGateRoutes } from "./workflow-gates";

export const githubAppRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

githubAppRoutes.route("/", installationRoutes);
githubAppRoutes.route("/", releaseTargetRoutes);
githubAppRoutes.route("/", workflowGateRoutes);
