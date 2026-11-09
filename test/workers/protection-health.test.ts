import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { createDb } from "../../server/db/client";
import * as schema from "../../server/db/schema";
import {
  claimProtectionHealth,
  getProtectionHealthRow,
  listProtectionHealthRows,
  publicProtectionHealth,
  saveProtectionHealth,
} from "../../server/db/protection-health";
import { saveDependencyReviewSettings } from "../../server/db/dependency-reviews";
import { DEFAULT_DEPENDENCY_REVIEW_POLICY } from "../../server/lib/dependency-review/types";
import {
  PROTECTION_HEALTH_BATCH_LIMIT,
  refreshProtectionHealth,
  sweepProtectionHealth,
} from "../../server/lib/github-app/protection-health-job";
import { githubAppRoutes } from "../../server/routes/github-app";
import { buildTestApp, call } from "./helpers/app";
import { seedUser } from "./helpers/seed";
import { exhaustedRateLimitBindings } from "./rate-limit-doubles";
import type { Bindings } from "../../server/types";

let key = "";
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const bytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  key = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...bytes))
    .match(/.{1,64}/g)
    ?.join("\n")}\n-----END PRIVATE KEY-----`;
});
beforeEach(async () => {
  await createDb(env.DB).delete(schema.githubReleaseTargets);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function config(): Partial<Bindings> {
  return {
    GITHUB_APP_ID: "123",
    GITHUB_APP_SLUG: "drydock-test",
    GITHUB_APP_CLIENT_ID: "client",
    GITHUB_APP_CLIENT_SECRET: "secret",
    GITHUB_APP_PRIVATE_KEY: key,
    GITHUB_APP_WEBHOOK_SECRET: "webhook-secret",
    GITHUB_APP_STATE_SECRET: "state-secret-at-least-32-characters-long",
  };
}
async function target(
  status: "active" | "suspended" | "uninstalled" = "active",
  owner?: Awaited<ReturnType<typeof seedUser>>,
) {
  const who = owner ?? (await seedUser());
  const installationId = crypto.randomUUID();
  const id = crypto.randomUUID();
  const now = new Date();
  await who.db.insert(schema.githubAppInstallations).values({
    id: installationId,
    organizationId: who.organizationId,
    installationId: crypto.randomUUID(),
    accountLogin: "octo",
    accountType: "Organization",
    status,
    installedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await who.db.insert(schema.githubReleaseTargets).values({
    id,
    organizationId: who.organizationId,
    installationRowId: installationId,
    repositoryId: 42,
    repositoryFullName: "octo/release",
    environment: owner ? `production-${id}` : "production",
    createdAt: now,
    updatedAt: now,
  });
  return { ...who, targetId: id, installationRowId: installationId };
}
function app(userId: string) {
  return buildTestApp((a) => a.route("/api/v1/github-app", githubAppRoutes), {
    userId,
    emailVerified: true,
  });
}
function mockGithub(fail = false) {
  return vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const path = new URL(req.url).pathname;
      if (fail) return new Response("unavailable", { status: 403 });
      if (path.startsWith("/app/installations/") && !path.endsWith("access_tokens"))
        return Response.json({ permissions: { administration: "read" } });
      if (path.endsWith("/access_tokens")) {
        const body = (await req.json()) as { permissions: Record<string, string> };
        expect(body.permissions.administration).toBe("read");
        expect(Object.values(body.permissions).every((p) => p === "read")).toBe(true);
        return Response.json({ token: "health-read-token" });
      }
      if (path.endsWith("/actions/runs/987654"))
        return Response.json({
          id: 987654,
          path: ".github/workflows/release.yml",
          head_sha: "a".repeat(40),
          repository: { id: 42 },
        });
      if (path.includes("/git/ref/heads/"))
        return Response.json({ object: { sha: "a".repeat(40) } });
      if (path.includes("/git/commits/"))
        return Response.json({ sha: path.split("/").at(-1), tree: { sha: "b".repeat(40) } });
      if (path.includes("/git/trees/"))
        return Response.json({
          truncated: false,
          tree: [
            { path: ".github", type: "tree", mode: "040000", sha: "b".repeat(40) },
            { path: "workflows", type: "tree", mode: "040000", sha: "b".repeat(40) },
            { path: "release.yml", type: "blob", mode: "100644", sha: "b".repeat(40) },
          ],
        });
      if (path.includes("/contents/"))
        return Response.json({
          type: "file",
          path: ".github/workflows/release.yml",
          sha: "b".repeat(40),
          encoding: "base64",
          content: "eA==",
          size: 1,
        });
      if (path === "/installation/token") return new Response(null, { status: 204 });
      if (path === "/repos/octo/release")
        return Response.json({ id: 42, full_name: "octo/release", default_branch: "main" });
      if (path.endsWith("/deployment_protection_rules"))
        return Response.json({
          total_count: 1,
          custom_deployment_protection_rules: [{ enabled: true, app: { id: 123 } }],
        });
      if (path.endsWith("/environments/production"))
        return Response.json({ can_admins_bypass: false });
      if (path.endsWith("/rules/branches/main"))
        return Response.json([
          {
            type: "required_status_checks",
            ruleset_id: 7,
            parameters: {
              required_status_checks: [
                { context: "Drydock dependency review", integration_id: 123 },
              ],
            },
          },
        ]);
      if (path.endsWith("/rulesets/7"))
        return Response.json({ enforcement: "active", bypass_actors: [] });
      throw new Error(`unexpected GitHub request ${path}`);
    }),
  );
}

test("GET serves saved snapshots without network; tenant targets are withheld", async () => {
  const mine = await target();
  const other = await target();
  const network = vi.fn();
  vi.stubGlobal("fetch", network);
  const res = await call(app(mine.userId), "GET", "/api/v1/github-app/protection-health");
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    targets: { releaseTargetId: string; status: string; stale: boolean }[];
    canRefresh: boolean;
  };
  expect(body.targets).toEqual([
    expect.objectContaining({ releaseTargetId: mine.targetId, status: "at_risk", stale: true }),
  ]);
  expect(body.canRefresh).toBe(true);
  const foreign = await call(
    app(mine.userId),
    "POST",
    `/api/v1/github-app/protection-health/${other.targetId}/refresh`,
  );
  expect(foreign.status).toBe(404);
  expect(network).not.toHaveBeenCalled();
});
test("members can read but only integration managers can refresh", async () => {
  const mine = await target();
  const member = await seedUser();
  await mine.db.insert(schema.organizationMembers).values({
    id: crypto.randomUUID(),
    organizationId: mine.organizationId,
    userId: member.userId,
    role: "member",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const read = await call(app(member.userId), "GET", "/api/v1/github-app/protection-health", {
    activeOrganizationId: mine.organizationId,
  });
  expect(read.status).toBe(200);
  expect(((await read.json()) as { canRefresh: boolean }).canRefresh).toBe(false);
  expect(
    (
      await call(
        app(member.userId),
        "POST",
        `/api/v1/github-app/protection-health/${mine.targetId}/refresh`,
        { activeOrganizationId: mine.organizationId },
      )
    ).status,
  ).toBe(403);
});
test("refreshes are rate limited", async () => {
  const mine = await target();
  const limited = exhaustedRateLimitBindings();
  expect(
    (
      await call(
        app(mine.userId),
        "POST",
        `/api/v1/github-app/protection-health/${mine.targetId}/refresh`,
        { envOverride: limited.overrides },
      )
    ).status,
  ).toBe(429);
});
test("refresh persists source-pinned controls but stays unknown before a real workflow baseline", async () => {
  const mine = await target();
  mockGithub();
  await saveDependencyReviewSettings(
    mine.db,
    mine.organizationId,
    { enabled: true, policy: DEFAULT_DEPENDENCY_REVIEW_POLICY, extraBotLogins: [] },
    mine.userId,
  );
  const res = await call(
    app(mine.userId),
    "POST",
    `/api/v1/github-app/protection-health/${mine.targetId}/refresh`,
    { envOverride: config() },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    target: {
      status: string;
      stale: boolean;
      checkedAt: string;
      checks: { id: string; status: string }[];
    };
  };
  expect(body.target).toMatchObject({
    status: "unknown",
    stale: false,
    checkedAt: expect.any(String),
  });
  expect(body.target.checks).toContainEqual(
    expect.objectContaining({ id: "dependency-required-check", status: "passed" }),
  );
  expect(body.target.checks).toContainEqual(
    expect.objectContaining({ id: "workflow-continuity", status: "unknown" }),
  );
});
test("failed refresh invalidates previous green evidence; stale snapshots and inactive installs never stay green", async () => {
  const mine = await target();
  await saveDependencyReviewSettings(
    mine.db,
    mine.organizationId,
    { enabled: true, policy: DEFAULT_DEPENDENCY_REVIEW_POLICY, extraBotLogins: [] },
    mine.userId,
  );
  const row = await getProtectionHealthRow(mine.db, mine.organizationId, mine.targetId);
  expect(row).not.toBeNull();
  const lease = await claimProtectionHealth(mine.db, row!, new Date());
  await saveProtectionHealth(
    mine.db,
    row!,
    lease!,
    {
      defaultBranch: "main",
      checks: [{ id: "config", label: "Config", status: "passed", detail: "observed" }],
    },
    new Date(),
  );
  const saved = await getProtectionHealthRow(mine.db, mine.organizationId, mine.targetId);
  expect(publicProtectionHealth(saved!, new Date(Date.now() + 2 * 60 * 60 * 1000)).status).toBe(
    "unknown",
  );
  mockGithub(true);
  const result = await refreshProtectionHealth(
    mine.db,
    { ...env, ...config() } as Cloudflare.Env,
    mine.organizationId,
    mine.targetId,
  );
  expect(result?.status).toBe("unknown");
  expect(result?.checks[0].id).toBe("configuration-read");
  await mine.db
    .update(schema.githubAppInstallations)
    .set({ status: "uninstalled" })
    .where(eq(schema.githubAppInstallations.id, mine.installationRowId));
  expect(
    publicProtectionHealth(
      (await getProtectionHealthRow(mine.db, mine.organizationId, mine.targetId))!,
    ).status,
  ).toBe("at_risk");
});
test("leases serialize refresh and target deletion prevents late snapshot resurrection", async () => {
  const mine = await target();
  const row = (await getProtectionHealthRow(mine.db, mine.organizationId, mine.targetId))!;
  const lease = await claimProtectionHealth(mine.db, row, new Date());
  expect(await claimProtectionHealth(mine.db, row, new Date())).toBeNull();
  await mine.db
    .delete(schema.githubReleaseTargets)
    .where(eq(schema.githubReleaseTargets.id, mine.targetId));
  expect(
    await saveProtectionHealth(
      mine.db,
      row,
      lease!,
      { defaultBranch: null, checks: [] },
      new Date(),
    ),
  ).toBe(false);
  expect(await claimProtectionHealth(mine.db, row, new Date())).toBeNull();
});
test("bounded cron includes suspended and uninstalled installations without fetching GitHub", async () => {
  const owner = await seedUser();
  for (let index = 0; index < PROTECTION_HEALTH_BATCH_LIMIT + 2; index++)
    await target(index % 2 ? "suspended" : "uninstalled", owner);
  const network = vi.fn();
  vi.stubGlobal("fetch", network);
  await sweepProtectionHealth(env);
  const rows = await listProtectionHealthRows(owner.db, owner.organizationId);
  expect(rows.filter((row) => row.health?.checkedAt)).toHaveLength(PROTECTION_HEALTH_BATCH_LIMIT);
  expect(network).not.toHaveBeenCalled();
  await sweepProtectionHealth(env);
  expect(
    (await listProtectionHealthRows(owner.db, owner.organizationId)).every(
      (row) => row.health?.checkedAt,
    ),
  ).toBe(true);
  const events = await owner.db
    .select()
    .from(schema.scanEvents)
    .where(eq(schema.scanEvents.type, "github_app.protection_health.changed"));
  expect(events.filter((event) => event.organizationId === owner.organizationId)).toHaveLength(
    PROTECTION_HEALTH_BATCH_LIMIT + 2,
  );
});

test("a complete real review and enforced controls become protected; transitions are audited once", async () => {
  const mine = await target();
  mockGithub();
  await saveDependencyReviewSettings(
    mine.db,
    mine.organizationId,
    { enabled: true, policy: DEFAULT_DEPENDENCY_REVIEW_POLICY, extraBotLogins: [] },
    mine.userId,
  );
  const gateId = crypto.randomUUID();
  const now = new Date();
  await mine.db.insert(schema.githubWorkflowGates).values({
    id: gateId,
    organizationId: mine.organizationId,
    installationRowId: mine.installationRowId,
    releaseTargetId: mine.targetId,
    deliveryId: crypto.randomUUID(),
    repositoryId: 42,
    repositoryFullName: "octo/release",
    environment: "production",
    runId: 987654,
    deploymentCallbackUrl:
      "https://api.github.com/repos/octo/release/actions/runs/987654/deployment_protection_rule",
    eventAction: "requested",
    status: "approved",
    decision: "approved",
    requestedAt: now,
    decidedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await mine.db.insert(schema.scans).values({
    id: crypto.randomUUID(),
    stageId: crypto.randomUUID(),
    gateId,
    organizationId: mine.organizationId,
    source: "workflow_gate",
    status: "complete",
    createdAt: now,
    updatedAt: now,
  });
  const result = await refreshProtectionHealth(
    mine.db,
    { ...env, ...config() } as Cloudflare.Env,
    mine.organizationId,
    mine.targetId,
  );
  expect(result).toMatchObject({ status: "protected", stale: false, defaultBranch: "main" });
  await refreshProtectionHealth(
    mine.db,
    { ...env, ...config() } as Cloudflare.Env,
    mine.organizationId,
    mine.targetId,
  );
  const events = await mine.db
    .select()
    .from(schema.scanEvents)
    .where(eq(schema.scanEvents.type, "github_app.protection_health.changed"));
  expect(events.filter((event) => event.organizationId === mine.organizationId)).toHaveLength(1);
  await saveDependencyReviewSettings(
    mine.db,
    mine.organizationId,
    { enabled: false, policy: DEFAULT_DEPENDENCY_REVIEW_POLICY, extraBotLogins: [] },
    mine.userId,
  );
  expect(
    publicProtectionHealth(
      (await getProtectionHealthRow(mine.db, mine.organizationId, mine.targetId))!,
      new Date(Date.now() + 2 * 60 * 60 * 1000),
    ).status,
  ).toBe("at_risk");
});

test("a target changed during GitHub collection cannot receive the old-scope observation", async () => {
  const mine = await target();
  const row = (await getProtectionHealthRow(mine.db, mine.organizationId, mine.targetId))!;
  const lease = await claimProtectionHealth(mine.db, row, new Date());
  await mine.db
    .update(schema.githubReleaseTargets)
    .set({ environment: "replacement", updatedAt: new Date(Date.now() + 10) })
    .where(eq(schema.githubReleaseTargets.id, mine.targetId));
  expect(
    await saveProtectionHealth(
      mine.db,
      row,
      lease!,
      {
        defaultBranch: "main",
        checks: [{ id: "config", label: "Config", status: "passed", detail: "old scope" }],
      },
      new Date(Date.now() + 100),
    ),
  ).toBe(false);
  const latest = (await getProtectionHealthRow(mine.db, mine.organizationId, mine.targetId))!;
  expect(latest.health?.snapshotJson).toBeNull();
  expect(latest.health?.leaseId).toBeNull();
});

test("an active installation with newer configuration invalidates its previous observation", async () => {
  const mine = await target();
  await saveDependencyReviewSettings(
    mine.db,
    mine.organizationId,
    { enabled: true, policy: DEFAULT_DEPENDENCY_REVIEW_POLICY, extraBotLogins: [] },
    mine.userId,
  );
  const row = (await getProtectionHealthRow(mine.db, mine.organizationId, mine.targetId))!;
  const lease = await claimProtectionHealth(mine.db, row, new Date());
  await saveProtectionHealth(
    mine.db,
    row,
    lease!,
    {
      defaultBranch: "main",
      checks: [{ id: "config", label: "Config", status: "passed", detail: "observed" }],
    },
    new Date(),
  );
  await mine.db
    .update(schema.githubAppInstallations)
    .set({ status: "active", updatedAt: new Date(Date.now() + 10) })
    .where(eq(schema.githubAppInstallations.id, mine.installationRowId));
  expect(
    publicProtectionHealth(
      (await getProtectionHealthRow(mine.db, mine.organizationId, mine.targetId))!,
    ).status,
  ).toBe("unknown");
});
