import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/client/validators/cf-worker";
import { afterEach, describe, expect, test, vi } from "vitest";
import worker from "../../server";
import { PUBLIC_NPM_REGISTRY } from "../../server/lib/ecosystems/npm/public-diff";
import {
  computePublicDiffCacheKey,
  writePublicDiffCache,
  type PublicPackageDiff,
} from "../../server/lib/public-diff";
import { summarizePackageJsonDiff } from "../../server/lib/review/serialize";
import { publicDiffRoutes } from "../../server/routes/public-diff";
import {
  exhaustedRateLimitBindings,
  rateLimitBindingOverrides,
  rateLimiterDouble,
} from "./rate-limit-doubles";

const ENDPOINT = "http://example.com/api/public/v1/mcp";

async function fetchWorker(request: Request, bindings: Cloudflare.Env): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, bindings, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function requestEnv(): Cloudflare.Env {
  return { ...env, ...rateLimitBindingOverrides(rateLimiterDouble(true)) };
}

async function seedPair(bindings: Cloudflare.Env): Promise<PublicPackageDiff> {
  const packageName = `@mcp/package-${crypto.randomUUID()}`;
  const payload: PublicPackageDiff = {
    ecosystem: "npm",
    packageName,
    fromVersion: "1.0.0",
    toVersion: "2.0.0",
    fromPackageJson: null,
    toPackageJson: null,
    fromFiles: [
      {
        path: "index.js",
        size: 20,
        sha256: "before",
        flags: ["baseline-truncated"],
        textSample: "before evidence",
      },
    ],
    toFiles: [
      {
        path: "index.js",
        size: 30,
        sha256: "after",
        flags: ["truncated"],
        textSample: "after evidence",
      },
      { path: "native.bin", size: 40, sha256: "native", flags: ["binary", "content-skipped"] },
    ],
    diff: [
      { path: "index.js", status: "modified", flags: ["truncated"] },
      { path: "native.bin", status: "added", flags: ["binary", "content-skipped"] },
    ],
    packageJsonDiff: summarizePackageJsonDiff(null, null),
    findings: [
      {
        severity: "medium",
        ruleId: "code.process-execution",
        file: "index.js",
        evidence: "quoted evidence",
        reason: "existing process launch",
        diffStatus: "modified",
        releaseDelta: false,
      },
      {
        severity: "high",
        ruleId: "code.dynamic-execution",
        file: "index.js",
        evidence: "quoted new evidence",
        reason: "new dynamic execution",
        diffStatus: "modified",
        releaseDelta: true,
      },
    ],
    risk: {
      artifactRisk: "high",
      releaseRisk: "high",
      contextRisk: "medium",
      releaseFindingCount: 1,
      contextFindingCount: 1,
      unknownFindingCount: 0,
      priorApprovedContextFindingCount: 0,
    },
    notices: ["Baseline evidence is bounded"],
    textSamplesOmitted: true,
    cachedAt: new Date().toISOString(),
  };
  await writePublicDiffCache(
    bindings,
    await computePublicDiffCacheKey({
      ecosystem: "npm",
      registryUrl: PUBLIC_NPM_REGISTRY,
      packageName,
      fromVersion: payload.fromVersion,
      toVersion: payload.toVersion,
    }),
    payload,
  );
  return payload;
}

function pairArgs(payload: PublicPackageDiff) {
  return {
    ecosystem: payload.ecosystem,
    package: payload.packageName,
    from: payload.fromVersion,
    to: payload.toVersion,
  };
}

async function rpc(
  method: string,
  params: Record<string, unknown>,
  bindings = requestEnv(),
  headers: Record<string, string> = {},
) {
  const response = await fetchWorker(
    new Request(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25",
        "cf-connecting-ip": "198.51.100.44",
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    bindings,
  );
  const text = await response.text();
  const data =
    text.startsWith("event:") || text.startsWith("data:")
      ? text
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .join("\n")
      : text;
  return { response, body: JSON.parse(data) };
}

describe("anonymous hosted public MCP", () => {
  afterEach(() => vi.restoreAllMocks());

  test("official client initializes, discovers tools and reads cached evidence without auth or D1", async () => {
    const bindings = requestEnv();
    const payload = await seedPair(bindings);
    const prepare = vi.fn(() => {
      throw new Error("anonymous MCP must not access D1");
    });
    bindings.DB = { prepare } as unknown as D1Database;
    bindings.BETTER_AUTH_SECRET = "";
    const registryFetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected external fetch"));
    const dispatch = vi.spyOn(publicDiffRoutes, "fetch");
    const client = new Client(
      { name: "drydock-test", version: "1" },
      {
        jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
        versionNegotiation: { mode: "auto" },
      },
    );
    const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
      fetch: (input, init) => fetchWorker(new Request(input, init), bindings),
      requestInit: {
        headers: {
          authorization: "Bearer caller-secret",
          cookie: "session=caller-secret",
          "cf-connecting-ip": "198.51.100.11",
        },
      },
    });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "compare_package_versions",
        "get_changed_file",
      ]);
      expect(tools.tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
      const pair = await client.callTool({
        name: "compare_package_versions",
        arguments: pairArgs(payload),
      });
      expect(pair.isError).not.toBe(true);
      expect(pair.structuredContent).toMatchObject({
        packageName: payload.packageName,
        findings: payload.findings,
        notices: payload.notices,
        textSamplesOmitted: true,
        risk: payload.risk,
        reviewUrl: `http://example.com/diff/${payload.packageName}/1.0.0/2.0.0`,
      });
      const file = await client.callTool({
        name: "get_changed_file",
        arguments: { ...pairArgs(payload), path: "index.js" },
      });
      expect(file.isError).not.toBe(true);
      expect(file.structuredContent).toMatchObject({
        before: payload.fromFiles[0],
        after: payload.toFiles[0],
        textSamplesOmitted: true,
      });
      const binary = await client.callTool({
        name: "get_changed_file",
        arguments: { ...pairArgs(payload), path: "native.bin" },
      });
      expect(binary.structuredContent).toMatchObject({
        before: null,
        after: payload.toFiles[1],
        textSamplesOmitted: true,
      });
      expect(prepare).not.toHaveBeenCalled();
      expect(registryFetch).not.toHaveBeenCalled();
      expect(dispatch).toHaveBeenCalledTimes(3);
      for (const [request] of dispatch.mock.calls) {
        const forwarded = request as Request;
        expect(forwarded.headers.get("authorization")).toBeNull();
        expect(forwarded.headers.get("cookie")).toBeNull();
        expect(forwarded.headers.get("origin")).toBeNull();
        expect(forwarded.headers.get("cf-connecting-ip")).toBe("198.51.100.11");
      }
    } finally {
      await client.close();
    }
  });

  test("legacy initialize and tools calls preserve the same public response contract", async () => {
    const bindings = requestEnv();
    const payload = await seedPair(bindings);
    const initialized = await rpc(
      "initialize",
      {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "legacy", version: "1" },
      },
      bindings,
    );
    expect(initialized.response.status).toBe(200);
    expect(initialized.body.result.protocolVersion).toBe("2025-11-25");
    expect((await rpc("tools/list", {}, bindings)).body.result.tools).toHaveLength(2);
    const pair = await rpc(
      "tools/call",
      { name: "compare_package_versions", arguments: pairArgs(payload) },
      bindings,
    );
    expect(pair.body.result.structuredContent.findings).toEqual(payload.findings);
    expect(pair.body.result.structuredContent.notices).toEqual(payload.notices);
  });

  test("strict tool arguments and unknown tools cannot dispatch package requests", async () => {
    const dispatch = vi.spyOn(publicDiffRoutes, "fetch");
    for (const params of [
      {
        name: "compare_package_versions",
        arguments: { package: "pkg", from: "1", to: "2", url: "https://attacker.test" },
      },
      { name: "get_changed_file", arguments: { package: "pkg", from: "1", to: "2" } },
      { name: "get_changed_file", arguments: { package: "pkg", from: "1", to: "2", path: "" } },
      { name: "read_organization_scans", arguments: {} },
    ]) {
      const result = await rpc("tools/call", params);
      expect(Boolean(result.body.error || result.body.result?.isError)).toBe(true);
    }
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("outer rate limiting rejects before tool dispatch", async () => {
    const exhausted = exhaustedRateLimitBindings();
    const dispatch = vi.spyOn(publicDiffRoutes, "fetch");
    const result = await rpc("tools/list", {}, { ...env, ...exhausted.overrides });
    expect(result.response.status).toBe(429);
    expect(Number(result.response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(exhausted.limiter.keys).toEqual(["public-mcp:198.51.100.44"]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("MCP pair and file tools share the public HTTP route budgets", async () => {
    const counts = new Map<string, number>();
    const limiter = rateLimiterDouble(true);
    limiter.limit = async ({ key }) => {
      limiter.keys.push(key);
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return { success: !key.startsWith("public-diff:") || count <= 1 };
    };
    const bindings = { ...env, ...rateLimitBindingOverrides(limiter) };
    const payload = await seedPair(bindings);
    const args = pairArgs(payload);
    const query = new URLSearchParams(args);
    for (const [tool, suffix] of [
      ["compare_package_versions", ""],
      ["get_changed_file", "/file"],
    ]) {
      const direct = await fetchWorker(
        new Request(
          `http://example.com/api/public/v1/package-diff${suffix}?${query}&path=index.js`,
          { headers: { "cf-connecting-ip": "198.51.100.44" } },
        ),
        bindings,
      );
      expect(direct.status).toBe(200);
      const result = await rpc(
        "tools/call",
        { name: tool, arguments: suffix ? { ...args, path: "index.js" } : args },
        bindings,
      );
      expect(result.body.result.isError).toBe(true);
      expect(result.body.result.structuredContent.status).toBe(429);
      expect(result.body.result.structuredContent.retryAfterSeconds).toBeGreaterThan(0);
    }
    expect(counts.get("public-diff:fetch:198.51.100.44")).toBe(2);
    expect(counts.get("public-diff:file:198.51.100.44")).toBe(2);
  });

  test("cold file requests also inherit the pair computation budget", async () => {
    const limiter = rateLimiterDouble(true);
    limiter.limit = async ({ key }) => {
      limiter.keys.push(key);
      return { success: !key.startsWith("public-diff:fetch:") };
    };
    const registryFetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected external fetch"));
    const result = await rpc(
      "tools/call",
      {
        name: "get_changed_file",
        arguments: {
          package: `mcp-cold-${crypto.randomUUID()}`,
          from: "1.0.0",
          to: "2.0.0",
          path: "index.js",
        },
      },
      { ...env, ...rateLimitBindingOverrides(limiter) },
    );
    expect(result.body.result.isError).toBe(true);
    expect(result.body.result.structuredContent.status).toBe(429);
    expect(limiter.keys).toEqual([
      "public-mcp:198.51.100.44",
      "public-diff:file:198.51.100.44",
      "public-diff:fetch:198.51.100.44",
    ]);
    expect(registryFetch).not.toHaveBeenCalled();
  });

  test("custom registries and cross-origin callers cannot expose the tools", async () => {
    const custom = await rpc(
      "tools/list",
      {},
      { ...requestEnv(), NPM_REGISTRY: "https://registry.private.test" },
    );
    expect(custom.response.status).toBe(404);
    for (const origin of ["https://attacker.test", "null", "http://example.com.attacker.test"]) {
      expect((await rpc("tools/list", {}, requestEnv(), { origin })).response.status).toBe(403);
    }
    expect(
      (await rpc("tools/list", {}, requestEnv(), { origin: "http://example.com" })).response.status,
    ).toBe(200);
  });

  test("oversized and malformed protocol bodies are rejected without package dispatch", async () => {
    const dispatch = vi.spyOn(publicDiffRoutes, "fetch");
    for (const body of [
      "{invalid-json",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { oversized: "x".repeat(17 * 1024) },
      }),
    ]) {
      const response = await fetchWorker(
        new Request(ENDPOINT, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-11-25",
          },
          body,
        }),
        requestEnv(),
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    }
    expect(dispatch).not.toHaveBeenCalled();
  });
});
