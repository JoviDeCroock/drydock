import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { createDb } from "../../server/db/client";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import * as schema from "../../server/db/schema";
import { readGithubAppConfig } from "../../server/lib/github-app/config";
import { createReleaseTarget, upsertInstallation } from "../../server/lib/github-app/persistence";
import { getGateForOrganization } from "../../server/lib/github-app/webhook-gates";
import type { PyPiAdapterInput } from "../../server/lib/ecosystems/pypi";
import { acquireStagedPyPi } from "../../server/lib/ecosystems/pypi/acquire";
import { prepareReleaseCandidatesForGate } from "../../server/lib/workflow-gates/prepare";

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
    repositoryId: opts.repositoryId,
    repositoryFullName: "octo/example",
    environment: "pypi",
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

type SandboxFile = {
  path: string;
  size: number;
  sha256: string;
  flags: string[];
  textSample?: string;
};

// A `.dist-info/METADATA` record the way the sandbox surfaces it after parsing a
// wheel; identity derivation reads Name/Version from this textSample.
function metadataFile(name: string, version: string): SandboxFile {
  const slug = name.replace(/-/g, "_");
  return {
    path: `${slug}-${version}.dist-info/METADATA`,
    size: 64,
    sha256: "ab".repeat(32),
    flags: [],
    textSample: `Metadata-Version: 2.3\nName: ${name}\nVersion: ${version}\n`,
  };
}

function sharedSourceFile(path = "demo_package/_core.py"): SandboxFile {
  return {
    path,
    size: 15,
    sha256: "cd".repeat(32),
    flags: [],
    textSample: "VALUE = 1\n",
  };
}

// `fileSets[i]` is what the sandbox returns for the i-th artifact it parses, in
// bundle order. The mock clamps to the last entry so single-set callers can omit
// extras.
function buildLoaderMock(fileSets: SandboxFile[][]) {
  const calls: { format: string | null; bodySize: number }[] = [];
  let index = 0;
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
            const files = fileSets[Math.min(index, fileSets.length - 1)] ?? [];
            index += 1;
            return new Response(JSON.stringify({ files, packageJson: null }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
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

// The bundle contains only the wheel/sdist files — no `drydock-manifest.json`.
// The wheel bytes here are opaque: the sandbox is mocked, so identity comes from
// the loader's returned METADATA rather than these bytes.
async function buildScenario(
  runId: number,
  opts?: {
    artifactPaths?: string[];
    extraArtifacts?: Array<{ id: number; name: string; artifactPaths: string[] }>;
  },
) {
  const artifactPaths = opts?.artifactPaths ?? ["dist/demo_package-1.2.0-py3-none-any.whl"];
  const bundles = new Map<number, Uint8Array>();
  const bundleZip = zipForArtifactPaths(artifactPaths);
  bundles.set(88888, bundleZip);
  for (const artifact of opts?.extraArtifacts ?? []) {
    bundles.set(artifact.id, zipForArtifactPaths(artifact.artifactPaths));
  }

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
            ...(opts?.extraArtifacts ?? []).map((artifact) => ({
              id: artifact.id,
              name: artifact.name,
              size_in_bytes: bundles.get(artifact.id)?.length ?? 0,
              expired: false,
            })),
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (request.url.includes("/actions/artifacts/")) {
      const match = request.url.match(/\/actions\/artifacts\/(\d+)\/zip$/);
      const artifactId = match ? Number.parseInt(match[1], 10) : 88888;
      const zip = bundles.get(artifactId);
      if (!zip) return new Response("not found", { status: 404 });
      return new Response(zip, {
        status: 200,
        headers: { "content-type": "application/zip" },
      });
    }
    throw new Error(`unexpected fetch in test: ${request.url}`);
  });
  vi.stubGlobal("fetch", fetchSpy);
  return { fetchSpy, artifactPaths };
}

function zipForArtifactPaths(artifactPaths: string[]): Uint8Array {
  return makeZip(artifactPaths.map((path) => ({ path, body: `opaque bytes for ${path}` })));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("prepareReleaseCandidatesForGate", () => {
  test("derives the release identity from the artifacts for a matching gate", async () => {
    const seeded = await seedGateForTest({
      installationExternalId: "9100",
      repositoryId: 71001,
      runId: 7777,
    });
    const scenario = await buildScenario(7777);
    const loaderMock = buildLoaderMock([[metadataFile("demo-package", "1.2.0")]]);
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
    const result = await prepareReleaseCandidatesForGate(sandboxEnv, ctx, db, {
      config,
      organizationId: seeded.organizationId,
      gateId: seeded.gateId,
    });

    expect(result.gate.id).toBe(seeded.gateId);
    expect(result.packages).toHaveLength(1);
    const [prepared] = result.packages;
    expect(prepared.candidate.ecosystem).toBe("pypi");
    expect(prepared.packageAdapter.id).toBe("pypi");
    expect(prepared.candidate.package).toEqual({ name: "demo-package", version: "1.2.0" });

    const pipelineInput = prepared.candidate.pipelineInput as unknown as PyPiAdapterInput;
    expect(pipelineInput.manifest.package).toBe("demo-package");
    expect(pipelineInput.manifest.version).toBe("1.2.0");
    expect(pipelineInput.manifest.artifacts).toHaveLength(1);
    expect(pipelineInput.manifest.artifacts[0].path).toBe(scenario.artifactPaths[0]);
    expect(pipelineInput.artifacts).toHaveLength(1);
    expect(pipelineInput.artifacts[0].path).toBe(scenario.artifactPaths[0]);
    expect(pipelineInput.artifacts[0].files).toHaveLength(1);
    expect(loaderMock.calls).toHaveLength(1);
    expect(loaderMock.calls[0].format).toBe("zip");

    const refreshed = await getGateForOrganization(db, seeded.organizationId, seeded.gateId);
    expect(refreshed?.status).toBe("pending");
  });

  test("uses the PyPI default artifact for pinned targets without an override", async () => {
    const seeded = await seedGateForTest({
      installationExternalId: "9106",
      repositoryId: 71005,
      runId: 10101,
    });
    const scenario = await buildScenario(10101, {
      extraArtifacts: [
        {
          id: 99999,
          name: "unrelated-build-output",
          artifactPaths: ["dist/unrelated_package-9.9.9-py3-none-any.whl"],
        },
      ],
    });
    const loaderMock = buildLoaderMock([[metadataFile("demo-package", "1.2.0")]]);
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
    const result = await prepareReleaseCandidatesForGate(sandboxEnv, ctx, db, {
      config,
      organizationId: seeded.organizationId,
      gateId: seeded.gateId,
    });

    expect(result.packages).toHaveLength(1);
    expect(result.packages[0].candidate.package.name).toBe("demo-package");
    expect(loaderMock.calls).toHaveLength(1);
    const downloadedArtifactIds = scenario.fetchSpy.mock.calls
      .map(([input]) => (input instanceof Request ? input.url : String(input)))
      .filter((url) => url.includes("/actions/artifacts/"))
      .map((url) => url.match(/\/actions\/artifacts\/(\d+)\/zip$/)?.[1]);
    expect(downloadedArtifactIds).toEqual(["88888"]);
  });

  test("streams and compacts a 44-wheel PyPI shard family", async () => {
    const seeded = await seedGateForTest({
      installationExternalId: "9107",
      repositoryId: 71007,
      runId: 13131,
    });
    const wheelPaths = Array.from(
      { length: 44 },
      (_, index) =>
        `dist/demo_package-1.2.0-cp312-cp312-manylinux_${String(index).padStart(2, "0")}_x86_64.whl`,
    );
    const scenario = await buildScenario(13131, {
      artifactPaths: [wheelPaths[0]],
      extraArtifacts: [
        ...wheelPaths.slice(1).map((path, index) => ({
          id: 90000 + index,
          name: `pypi-release-candidate-${String(index + 1).padStart(2, "0")}`,
          artifactPaths: [path],
        })),
        {
          id: 99999,
          name: "unrelated-build-output",
          artifactPaths: ["dist/unrelated_package-9.9.9-py3-none-any.whl"],
        },
      ],
    });
    const loaderMock = buildLoaderMock(
      wheelPaths.map(() => [metadataFile("demo-package", "1.2.0"), sharedSourceFile()]),
    );
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
    const result = await prepareReleaseCandidatesForGate(sandboxEnv, ctx, db, {
      config,
      organizationId: seeded.organizationId,
      gateId: seeded.gateId,
    });

    expect(result.packages).toHaveLength(1);
    const pipelineInput = result.packages[0].candidate.pipelineInput as unknown as PyPiAdapterInput;
    expect(pipelineInput.manifest.artifacts).toHaveLength(44);
    expect(pipelineInput.artifacts).toHaveLength(44);
    expect(loaderMock.calls).toHaveLength(44);
    const retainedSharedSamples = pipelineInput.artifacts
      .flatMap((artifact) => artifact.files)
      .filter((file) => file.path === "demo_package/_core.py" && file.textSample);
    expect(retainedSharedSamples).toHaveLength(44);
    const staged = acquireStagedPyPi(pipelineInput);
    expect(
      staged.artifact.files.filter(
        (file) => file.path.endsWith("demo_package/_core.py") && file.textSample,
      ),
    ).toHaveLength(1);

    const downloadedArtifactIds = scenario.fetchSpy.mock.calls
      .map(([input]) => (input instanceof Request ? input.url : String(input)))
      .filter((url) => url.includes("/actions/artifacts/"))
      .map((url) => url.match(/\/actions\/artifacts\/(\d+)\/zip$/)?.[1]);
    expect(downloadedArtifactIds).toHaveLength(44);
    expect(downloadedArtifactIds).not.toContain("99999");
  });

  test("fans a monorepo bundle out into one candidate per distinct package", async () => {
    const seeded = await seedGateForTest({
      installationExternalId: "9105",
      repositoryId: 71006,
      runId: 12121,
    });
    // Two distinct packages publish from one release: each wheel carries its own
    // identity and must become its own candidate (its own scan + baseline).
    const scenario = await buildScenario(12121, {
      artifactPaths: [
        "dist/alpha_pkg-1.0.0-py3-none-any.whl",
        "dist/beta_pkg-2.0.0-py3-none-any.whl",
      ],
    });
    const loaderMock = buildLoaderMock([
      [metadataFile("alpha-pkg", "1.0.0"), sharedSourceFile("shared.py")],
      [metadataFile("beta-pkg", "2.0.0"), sharedSourceFile("shared.py")],
    ]);
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
    const result = await prepareReleaseCandidatesForGate(sandboxEnv, ctx, db, {
      config,
      organizationId: seeded.organizationId,
      gateId: seeded.gateId,
    });

    expect(result.packages).toHaveLength(2);
    const names = result.packages.map((pkg) => pkg.candidate.package.name).sort();
    expect(names).toEqual(["alpha-pkg", "beta-pkg"]);
    for (const pkg of result.packages) {
      expect(pkg.candidate.ecosystem).toBe("pypi");
      expect(pkg.packageAdapter.id).toBe("pypi");
      const input = pkg.candidate.pipelineInput as unknown as PyPiAdapterInput;
      expect(input.artifacts[0].files.find((file) => file.path === "shared.py")?.textSample).toBe(
        "VALUE = 1\n",
      );
    }
    expect(scenario.artifactPaths).toHaveLength(2);

    const refreshed = await getGateForOrganization(db, seeded.organizationId, seeded.gateId);
    expect(refreshed?.status).toBe("pending");
  });

  test("marks the gate errored when an artifact exposes no Name/Version", async () => {
    const seeded = await seedGateForTest({
      installationExternalId: "9101",
      repositoryId: 71002,
      runId: 8888,
    });
    await buildScenario(8888);
    // The sandbox returns a file with no usable PyPI metadata.
    const loaderMock = buildLoaderMock([
      [{ path: "demo_package/__init__.py", size: 1, sha256: "00", flags: [], textSample: "x" }],
    ]);
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
      prepareReleaseCandidatesForGate(sandboxEnv, ctx, db, {
        config,
        organizationId: seeded.organizationId,
        gateId: seeded.gateId,
      }),
    ).rejects.toMatchObject({ code: "artifact_identity_missing" });

    const refreshed = await getGateForOrganization(db, seeded.organizationId, seeded.gateId);
    expect(refreshed?.status).toBe("pending");
    expect(refreshed?.failureReason).toBe("artifact_identity_missing");
  });

  test("marks the gate errored when artifacts disagree on identity", async () => {
    const seeded = await seedGateForTest({
      installationExternalId: "9104",
      repositoryId: 71005,
      runId: 11111,
    });
    await buildScenario(11111, {
      artifactPaths: ["dist/demo_package-1.2.0-py3-none-any.whl", "dist/demo_package-1.3.0.tar.gz"],
    });
    // The wheel and sdist disagree on version: a version-skewed file must be
    // rejected rather than silently shipped.
    const loaderMock = buildLoaderMock([
      [metadataFile("demo-package", "1.2.0")],
      [{ ...metadataFile("demo-package", "1.3.0"), path: "demo_package-1.3.0/PKG-INFO" }],
    ]);
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
      prepareReleaseCandidatesForGate(sandboxEnv, ctx, db, {
        config,
        organizationId: seeded.organizationId,
        gateId: seeded.gateId,
      }),
    ).rejects.toMatchObject({ code: "artifact_identity_inconsistent" });

    const refreshed = await getGateForOrganization(db, seeded.organizationId, seeded.gateId);
    expect(refreshed?.status).toBe("pending");
    expect(refreshed?.failureReason).toBe("artifact_identity_inconsistent");
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
    const loaderMock = buildLoaderMock([[metadataFile("demo-package", "1.2.0")]]);
    const ctx = buildCtxWithGateway();
    const sandboxEnv = {
      ...env,
      ...bindings,
      LOADER: loaderMock.binding as unknown as WorkerLoader,
    } as Cloudflare.Env;
    const db = createDb(env.DB);
    await expect(
      prepareReleaseCandidatesForGate(sandboxEnv, ctx, db, {
        config,
        organizationId: "other-org",
        gateId: seeded.gateId,
      }),
    ).rejects.toMatchObject({ code: "bundle_unavailable" });
  });
});
