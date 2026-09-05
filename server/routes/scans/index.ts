/**
 * Scan routes, mounted under /api/v1/scans.
 *
 * Split by what the caller is doing with a scan: running it, deciding on it,
 * sharing the result, or diffing versions. No router-level middleware — each
 * handler establishes its own organization context — so the groups compose
 * without ordering constraints. Registration order is preserved anyway so the
 * route table stays byte-identical to the pre-split file, with one exception:
 * the literal `/overview` path registers before lifecycle's `GET /:id`, which
 * would otherwise capture it as a scan id.
 */
import { Hono } from "hono";
import type { Bindings, Variables } from "../../types";
import { scanCompareRoutes } from "./compare";
import { scanDecisionRoutes } from "./decisions";
import { scanLifecycleRoutes } from "./lifecycle";
import { scanOverviewRoutes } from "./overview";
import { scanSharingRoutes } from "./sharing";

export const scansRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

scansRoutes.route("/", scanOverviewRoutes);
scansRoutes.route("/", scanLifecycleRoutes);
scansRoutes.route("/", scanDecisionRoutes);
scansRoutes.route("/", scanSharingRoutes);
scansRoutes.route("/", scanCompareRoutes);
