import { Hono } from "hono";
import {
  readNpmPackageManagement,
  manageNpmPackageClaim,
  PackageManagementAuthorizationError,
  PackageManagementConflictError,
} from "../db/package-claims";
import { listPackageBadgeTags } from "../db/package-badge";
import { requireActiveOrganization } from "../lib/auth/active-organization";
import { getStagedAdapter } from "../lib/ecosystems";
import { npmPublicationRegistry } from "../lib/ecosystems/npm/publication-registry";
import { optionalWorkerExecutionContext } from "../lib/platform/execution-context";
import { canonicalOrigin, readJsonObject } from "../lib/platform/http";
import { isValidBadgeTag, purgePublicFeedCache } from "../lib/public-feed";
import type { Bindings, Variables } from "../types";

export const npmPackageClaimRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

npmPackageClaimRoutes.use("*", async (c, next) => {
  c.header("cache-control", "private, no-store");
  await next();
});

function coordinates(packageName: string, registryUrl: unknown, defaultRegistry: string) {
  if (registryUrl !== undefined && typeof registryUrl !== "string") return null;
  try {
    return (
      getStagedAdapter("npm").stagedClaimIdentity?.({
        registryUrl: registryUrl ?? defaultRegistry,
        packageName,
        version: "1",
      }) ?? null
    );
  } catch {
    return null;
  }
}

npmPackageClaimRoutes.get("/:name{.+}", async (c) => {
  const monitoringRegistryUrl = npmPublicationRegistry(c.env);
  const identity = coordinates(
    c.req.param("name"),
    c.req.query("registryUrl"),
    monitoringRegistryUrl,
  );
  if (!identity) return c.json({ error: "Enter a valid npm package and registry." }, 400);
  const organizationId = await requireActiveOrganization(c, c.var.db);
  return c.json(
    await readNpmPackageManagement(c.var.db, {
      ...identity,
      organizationId,
      userId: c.get("authSession").userId,
    }),
  );
});

npmPackageClaimRoutes.post("/:name{.+}", async (c) => {
  const body = await readJsonObject<{ registryUrl?: unknown; targetOrganizationId?: unknown }>(c);
  const monitoringRegistryUrl = npmPublicationRegistry(c.env);
  const identity = coordinates(c.req.param("name"), body.registryUrl, monitoringRegistryUrl);
  if (!identity || typeof body.targetOrganizationId !== "string" || !body.targetOrganizationId)
    return c.json({ error: "Choose a valid organization and npm package." }, 400);
  const organizationId = await requireActiveOrganization(c, c.var.db);
  try {
    await manageNpmPackageClaim(c.var.db, {
      ...identity,
      organizationId,
      userId: c.get("authSession").userId,
      targetOrganizationId: body.targetOrganizationId,
      monitoringRegistryUrl,
    });
  } catch (error) {
    if (error instanceof PackageManagementAuthorizationError)
      return c.json({ error: "forbidden" }, 403);
    if (error instanceof PackageManagementConflictError)
      return c.json(
        {
          error:
            "Package management changed or the destination monitoring limit was reached. Reload and try again.",
        },
        409,
      );
    throw error;
  }
  if (identity.registryUrl === "https://registry.npmjs.org") {
    const target = {
      ecosystem: "npm" as const,
      packageName: identity.packageName,
      packageKey: `npm:${identity.packageName}`,
    };
    const tags = await listPackageBadgeTags(c.var.db, target);
    const ctx = optionalWorkerExecutionContext(c);
    const origin = canonicalOrigin(c);
    purgePublicFeedCache(ctx, origin, target.packageKey, null);
    for (const tag of tags.filter(isValidBadgeTag))
      purgePublicFeedCache(ctx, origin, target.packageKey, tag);
  }
  return c.json({ managed: true, targetOrganizationId: body.targetOrganizationId });
});
