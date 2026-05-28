import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { createDb, ensurePersonalOrganization } from "../../server/db";
import * as schema from "../../server/db/schema";
import {
  createReleaseTarget,
  readGithubAppConfig,
  upsertInstallation,
} from "../../server/lib/github-app";
import { getGateForOrganization } from "../../server/lib/github-app-webhook";
import { preparePyPiReleaseCandidateForGate } from "../../server/lib/release-candidate-pypi";
import { WorkflowArtifactError } from "../../server/lib/github-app-artifacts";

const WEBHOOK_SECRET = "webhook-secret-value-1234567890";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.unstubAllGlobals();
});

// ── Test setup helpers ───────────────────────────────────────────────────────

async function seedGateForTest(opts: {
  installationExternalId: string;
  repositoryId: number;
  runId: number;
}) {
  const db = createDb(env.DB);
  const now = new Date();
  const userId = `user_${crypto.randomUUID()}`;
  await db.insert(schema.user).values({
    id: userId,
    name: "Tester",
    email: `${userId}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const organizationId = await ensurePersonalOrganization(db, { userId });
  const installation = await upsertInstallation(db, {
    organizationId,
    installationId: opts.installationExternalId,
    accountLogin: "octo",
    accountType: "Organization",
    targetType: "Organization",
    status: "active",
    createdByUserId: null,
  });
  const releaseTarget = await createReleaseTarget(db, {
    organizationId,
    installationRowId: installation.id,
    ecosystem: "pypi",
    packageName: "demo-package",
    repositoryId: opts.repositoryId,
    repositoryFullName: "octo/example",
    workflowFilename: null,
    environment: "pypi",
    pypiTrustedPublisherEnvironment: "pypi",
    createdByUserId: null,
  });

  const gateId = crypto.randomUUID();
  await db.insert(schema.githubWorkflowGates).values({
    id: gateId,
    organizationId,
    installationRowId: installation.id,
    releaseTargetId: releaseTarget.id,
    deliveryId: crypto.randomUUID(),
    repositoryId: opts.repositoryId,
    repositoryFullName: "octo/example",
    environment: "pypi",
    runId: opts.runId,
    deploymentId: 909,
    deploymentCallbackUrl: `https://api.github.com/repos/octo/example/actions/runs/${opts.runId}/deployment_protection_rule`,
    eventAction: "requested",
    status: "pending",
    requestedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return { organizationId, installation, releaseTarget, gateId };
}

// Minimal store-only ZIP builder.
interface ZipEntry {
  path: string;
  body: Uint8Array | string;
}

function makeZip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const records: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const body = typeof entry.body === "string" ? encoder.encode(entry.body) : entry.body;
    const nameBytes = encoder.encode(entry.path);
    const crc = crc32(body);
    const local = new Uint8Array(30 + nameBytes.length + body.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, body.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(body, 30 + nameBytes.length);
    records.push(local);

    const c = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, body.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    c.set(nameBytes, 46);
    central.push(c);
    offset += local.length;
  }
  const centralBytes = concat(central);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralBytes.length, true);
  ev.setUint32(16, offset, true);
  return concat([...records, centralBytes, eocd]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let i = 0;
  for (const part of parts) {
    out.set(part, i);
    i += part.length;
  }
  return out;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function buildLoaderMock() {
  const calls: { format: string | null; bodySize: number }[] = [];
  return {
    calls,
    binding: {
      load: vi.fn(() => ({
        getEntrypoint: () => ({
          fetch: vi.fn(async (request: Request) => {
            calls.push({
              format: request.headers.get("x-archive-format"),
              bodySize: (await request.arrayBuffer()).byteLength,
            });
            return new Response(
              JSON.stringify({
                files: [
                  {
                    path: "stub.txt",
                    size: 1,
                    sha256: "00",
                    flags: [],
                    textSample: "x",
                  },
                ],
                packageJson: null,
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }),
        }),
      })),
    },
  };
}

function buildCtxWithGateway() {
  const ctx = createExecutionContext() as ExecutionContext & {
    exports: { NpmStageGateway(options: { props: unknown }): Fetcher };
  };
  ctx.exports = {
    NpmStageGateway: vi.fn(() => ({ fetch: vi.fn() }) as unknown as Fetcher),
  };
  return ctx;
}

function buildConfigBindings(): Record<string, string> {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  return {
    GITHUB_APP_ID: "12345",
    GITHUB_APP_SLUG: "drydock-test",
    GITHUB_APP_CLIENT_ID: "client-id",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_PRIVATE_KEY: privateKeyPem,
    GITHUB_APP_WEBHOOK_SECRET: WEBHOOK_SECRET,
    GITHUB_APP_STATE_SECRET: "0123456789abcdef0123456789abcdef",
    BETTER_AUTH_SECRET: "fallback-secret-with-enough-entropy-aaaaaaaa",
  };
}

interface ScenarioOpts {
  digestMatches: boolean;
  manifestPackage?: string;
}

async function buildScenario(runId: number, opts: ScenarioOpts) {
  const wheelPath = "dist/demo_package-1.2.0-py3-none-any.whl";
  const wheelBytes = makeZip([
    {
      path: "demo_package-1.2.0.dist-info/METADATA",
      body: "Metadata-Version: 2.3\nName: demo-package\nVersion: 1.2.0\n",
    },
    {
      path: "demo_package-1.2.0.dist-info/WHEEL",
      body: "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
    },
    {
      path: "demo_package-1.2.0.dist-info/RECORD",
      body: "",
    },
  ]);
  const declaredSha = opts.digestMatches ? await sha256Hex(wheelBytes) : "0".repeat(64);
  const manifestRaw = JSON.stringify({
    schema: "drydock.release-artifacts.v1",
    ecosystem: "pypi",
    package: opts.manifestPackage ?? "demo-package",
    version: "1.2.0",
    artifacts: [{ path: wheelPath, sha256: declaredSha }],
  });
  const bundleZip = makeZip([
    { path: "drydock-manifest.json", body: manifestRaw },
    { path: wheelPath, body: wheelBytes },
  ]);

  const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.url.includes("/access_tokens")) {
      return Response.json({
        token: "ghs_install_token",
        expires_at: "2099-01-01T00:00:00Z",
      });
    }
    if (request.url.includes(`/actions/runs/${runId}/artifacts`)) {
      return new Response(
        JSON.stringify({
          total_count: 1,
          artifacts: [
            {
              id: 88888,
              name: "pypi-release-candidate",
              size_in_bytes: bundleZip.length,
              expired: false,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (request.url.includes("/actions/artifacts/")) {
      return new Response(bundleZip, {
        status: 200,
        headers: { "content-type": "application/zip" },
      });
    }
    throw new Error(`unexpected fetch in test: ${request.url}`);
  });
  vi.stubGlobal("fetch", fetchSpy);
  return { fetchSpy, manifestRaw, wheelPath, wheelBytes };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("preparePyPiReleaseCandidateForGate", () => {
  test("returns a PyPiAdapterInput for a pending gate with a matching manifest", async () => {
    const seeded = await seedGateForTest({
      installationExternalId: "9100",
      repositoryId: 71001,
      runId: 7777,
    });
    const scenario = await buildScenario(7777, { digestMatches: true });
    const loaderMock = buildLoaderMock();
    const ctx = buildCtxWithGateway();
    const bindings = buildConfigBindings();
    const config = readGithubAppConfig({
      ...bindings,
      BETTER_AUTH_SECRET: bindings.BETTER_AUTH_SECRET,
    });
    const sandboxEnv = {
      ...env,
      ...bindings,
      LOADER: loaderMock.binding as unknown as WorkerLoader,
    } as Cloudflare.Env;

    const db = createDb(env.DB);
    const result = await preparePyPiReleaseCandidateForGate(sandboxEnv, ctx, db, {
      config,
      organizationId: seeded.organizationId,
      gateId: seeded.gateId,
    });

    expect(result.gate.id).toBe(seeded.gateId);
    expect(result.bundle.manifest.package).toBe("demo-package");
    expect(result.adapterInput.artifacts).toHaveLength(1);
    expect(result.adapterInput.artifacts[0].path).toBe(scenario.wheelPath);
    expect(result.adapterInput.artifacts[0].files).toHaveLength(1);
    expect(loaderMock.calls).toHaveLength(1);
    expect(loaderMock.calls[0].format).toBe("zip");
    expect(loaderMock.calls[0].bodySize).toBe(scenario.wheelBytes.byteLength);

    const refreshed = await getGateForOrganization(db, seeded.organizationId, seeded.gateId);
    expect(refreshed?.status).toBe("pending");
  });

  test("marks the gate errored when the manifest digest does not match the wheel bytes", async () => {
    const seeded = await seedGateForTest({
      installationExternalId: "9101",
      repositoryId: 71002,
      runId: 8888,
    });
    await buildScenario(8888, { digestMatches: false });
    const loaderMock = buildLoaderMock();
    const ctx = buildCtxWithGateway();
    const bindings = buildConfigBindings();
    const config = readGithubAppConfig({
      ...bindings,
      BETTER_AUTH_SECRET: bindings.BETTER_AUTH_SECRET,
    });
    const sandboxEnv = {
      ...env,
      ...bindings,
      LOADER: loaderMock.binding as unknown as WorkerLoader,
    } as Cloudflare.Env;

    const db = createDb(env.DB);
    await expect(
      preparePyPiReleaseCandidateForGate(sandboxEnv, ctx, db, {
        config,
        organizationId: seeded.organizationId,
        gateId: seeded.gateId,
      }),
    ).rejects.toBeInstanceOf(WorkflowArtifactError);

    const refreshed = await getGateForOrganization(db, seeded.organizationId, seeded.gateId);
    expect(refreshed?.status).toBe("pending");
    expect(refreshed?.failureReason).toBe("artifact_digest_mismatch");
  });

  test("marks the gate errored when the manifest package does not match the release target", async () => {
    const seeded = await seedGateForTest({
      installationExternalId: "9102",
      repositoryId: 71003,
      runId: 9999,
    });
    await buildScenario(9999, {
      digestMatches: true,
      manifestPackage: "other-package",
    });
    const loaderMock = buildLoaderMock();
    const ctx = buildCtxWithGateway();
    const bindings = buildConfigBindings();
    const config = readGithubAppConfig({
      ...bindings,
      BETTER_AUTH_SECRET: bindings.BETTER_AUTH_SECRET,
    });
    const sandboxEnv = {
      ...env,
      ...bindings,
      LOADER: loaderMock.binding as unknown as WorkerLoader,
    } as Cloudflare.Env;

    const db = createDb(env.DB);
    await expect(
      preparePyPiReleaseCandidateForGate(sandboxEnv, ctx, db, {
        config,
        organizationId: seeded.organizationId,
        gateId: seeded.gateId,
      }),
    ).rejects.toMatchObject({ code: "release_target_mismatch" });

    expect(loaderMock.calls).toHaveLength(0);
    const refreshed = await getGateForOrganization(db, seeded.organizationId, seeded.gateId);
    expect(refreshed?.status).toBe("pending");
    expect(refreshed?.failureReason).toBe("release_target_mismatch");
  });

  test("rejects with bundle_unavailable when the gate id does not belong to the org", async () => {
    const seeded = await seedGateForTest({
      installationExternalId: "9103",
      repositoryId: 71004,
      runId: 10000,
    });
    const bindings = buildConfigBindings();
    const config = readGithubAppConfig({
      ...bindings,
      BETTER_AUTH_SECRET: bindings.BETTER_AUTH_SECRET,
    });
    const loaderMock = buildLoaderMock();
    const ctx = buildCtxWithGateway();
    const sandboxEnv = {
      ...env,
      ...bindings,
      LOADER: loaderMock.binding as unknown as WorkerLoader,
    } as Cloudflare.Env;
    const db = createDb(env.DB);
    await expect(
      preparePyPiReleaseCandidateForGate(sandboxEnv, ctx, db, {
        config,
        organizationId: "other-org",
        gateId: seeded.gateId,
      }),
    ).rejects.toMatchObject({ code: "bundle_unavailable" });
  });
});
