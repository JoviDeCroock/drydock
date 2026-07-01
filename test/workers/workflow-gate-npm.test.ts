import { createExecutionContext, env } from "cloudflare:test";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { createDb } from "../../server/db/client";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import * as schema from "../../server/db/schema";
import { readGithubAppConfig } from "../../server/lib/github-app/config";
import { createReleaseTarget, upsertInstallation } from "../../server/lib/github-app/persistence";
import { getGateForOrganization } from "../../server/lib/github-app/webhook-gates";
import { npmWorkflowGateAdapter } from "../../server/lib/workflow-gates/npm";
import { prepareReleaseCandidatesForGate } from "../../server/lib/workflow-gates/prepare";
import {
  AMBIGUOUS_ARCHIVE_ECOSYSTEM,
  classifyBundleArtifact,
  detectArchiveEcosystems,
  getWorkflowGateAdapter,
  supportedWorkflowGateEcosystems,
} from "../../server/lib/workflow-gates/registry";
import { type ParsedGateArtifact } from "../../server/lib/workflow-gates/types";
import { npmGateAdapter } from "../../server/lib/adapters/npm/gate";
import type { NpmGateDetails } from "../../server/lib/adapters/npm/gate";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function npmArtifact(
  path: string,
  name: string,
  version: string,
  sha = "ab".repeat(32),
): ParsedGateArtifact {
  return {
    path,
    sha256: sha,
    ecosystem: "npm",
    kind: "tarball",
    files: [
      {
        path: "package.json",
        size: 20,
        sha256: "00",
        flags: [],
        textSample: JSON.stringify({ name, version }),
      },
    ],
    packageJson: { name, version },
  };
}

// ── Registry: classification + content detection ─────────────────────────────

describe("workflow-gate registry with npm registered", () => {
  test("resolves the npm adapter by ecosystem and lists it", () => {
    expect(getWorkflowGateAdapter("npm")).toBe(npmWorkflowGateAdapter);
    expect(supportedWorkflowGateEcosystems()).toEqual(expect.arrayContaining(["pypi", "npm"]));
  });

  test("tags an ambiguous .tgz with the archive sentinel, a .whl with pypi", () => {
    expect(classifyBundleArtifact("dist/pkg-1.0.0.tgz")).toEqual({
      ecosystem: AMBIGUOUS_ARCHIVE_ECOSYSTEM,
      kind: "archive",
    });
    expect(classifyBundleArtifact("dist/pkg-1.0.0.tar.gz")).toEqual({
      ecosystem: AMBIGUOUS_ARCHIVE_ECOSYSTEM,
      kind: "archive",
    });
    expect(classifyBundleArtifact("dist/pkg-1.0.0-py3-none-any.whl")).toEqual({
      ecosystem: "pypi",
      kind: "wheel",
    });
    expect(classifyBundleArtifact("dist/SHASUMS.txt")).toBeNull();
  });

  test("content-detects npm via a root package.json and pypi via a root PKG-INFO", () => {
    expect(
      detectArchiveEcosystems({ files: [], packageJson: { name: "left-pad", version: "1.0.0" } }),
    ).toEqual([{ ecosystem: "npm", kind: "tarball" }]);
    expect(
      detectArchiveEcosystems({
        files: [{ path: "left_pad-1.0.0/PKG-INFO", size: 1, sha256: "x", flags: [] }],
        packageJson: null,
      }),
    ).toEqual([{ ecosystem: "pypi", kind: "sdist" }]);
    expect(
      detectArchiveEcosystems({
        files: [{ path: "a.txt", size: 1, sha256: "x", flags: [] }],
        packageJson: null,
      }),
    ).toEqual([]);
  });

  test("keeps npm routing when a tarball contains nested PyPI metadata", () => {
    // Only a *root* PKG-INFO is a sdist signal; a deeply-vendored one is ignored,
    // so a tarball with a root package.json is unambiguously npm.
    expect(
      detectArchiveEcosystems({
        files: [
          { path: "package.json", size: 1, sha256: "x", flags: [] },
          { path: "vendor/foo.egg-info/PKG-INFO", size: 1, sha256: "x", flags: [] },
        ],
        packageJson: { name: "left-pad", version: "1.0.0" },
      }),
    ).toEqual([{ ecosystem: "npm", kind: "tarball" }]);
  });

  test("reports an archive that claims both ecosystems (root decoy PKG-INFO)", () => {
    // An npm tarball with a root PKG-INFO claims both ecosystems; the resolver
    // must refuse to guess rather than route by registration order.
    const claims = detectArchiveEcosystems({
      files: [{ path: "PKG-INFO", size: 1, sha256: "x", flags: [] }],
      packageJson: { name: "evil", version: "1.0.0" },
    });
    expect(claims.map((claim) => claim.ecosystem).sort()).toEqual(["npm", "pypi"]);
  });
});

// ── npm workflow-gate adapter (pure) ─────────────────────────────────────────

describe("npmWorkflowGateAdapter", () => {
  test("classifies tarballs by extension and detects by package.json", () => {
    expect(npmWorkflowGateAdapter.classifyArtifact("a/b/pkg-1.0.0.tgz")).toBe("tarball");
    expect(npmWorkflowGateAdapter.classifyArtifact("a/b/pkg.tar.gz")).toBe("tarball");
    expect(npmWorkflowGateAdapter.classifyArtifact("a/b/pkg.whl")).toBeNull();
    expect(npmWorkflowGateAdapter.detectArtifact({ files: [], packageJson: { name: "x" } })).toBe(
      "tarball",
    );
    expect(npmWorkflowGateAdapter.detectArtifact({ files: [], packageJson: null })).toBeNull();
  });

  test("derives one candidate per distinct package (monorepo fan-out)", () => {
    const candidates = npmWorkflowGateAdapter.prepareReleaseCandidates([
      npmArtifact("dist/alpha-1.0.0.tgz", "@scope/alpha", "1.0.0", "11".repeat(32)),
      npmArtifact("dist/beta-2.0.0.tgz", "@scope/beta", "2.0.0", "22".repeat(32)),
    ]);
    expect(candidates).toHaveLength(2);
    const byName = Object.fromEntries(candidates.map((c) => [c.package.name, c]));
    expect(byName["@scope/alpha"].package.version).toBe("1.0.0");
    const input = byName["@scope/alpha"].pipelineInput as {
      manifest: { artifacts: { sha256: string }[] };
      artifact: { sha256: string };
    };
    expect(input.manifest.artifacts[0].sha256).toBe("11".repeat(32));
    expect(input.artifact.sha256).toBe("11".repeat(32));
  });

  test("rejects a tarball with no package.json identity", () => {
    const artifact = { ...npmArtifact("dist/x.tgz", "x", "1.0.0"), packageJson: null };
    expect(() => npmWorkflowGateAdapter.prepareReleaseCandidates([artifact])).toThrow(
      /does not expose a package.json/,
    );
  });

  test("rejects two tarballs of the same package (version skew or duplicate)", () => {
    expect(() =>
      npmWorkflowGateAdapter.prepareReleaseCandidates([
        npmArtifact("dist/a.tgz", "pkg", "1.0.0"),
        npmArtifact("dist/b.tgz", "pkg", "1.0.1"),
      ]),
    ).toThrow(/version 1.0.1 disagrees with 1.0.0/);
    expect(() =>
      npmWorkflowGateAdapter.prepareReleaseCandidates([
        npmArtifact("dist/a.tgz", "pkg", "1.0.0"),
        npmArtifact("dist/b.tgz", "pkg", "1.0.0"),
      ]),
    ).toThrow(/more than one tarball/);
  });
});

// ── npm gate package adapter (pure) ──────────────────────────────────────────

describe("npmGateAdapter", () => {
  function gateInput() {
    const [candidate] = npmWorkflowGateAdapter.prepareReleaseCandidates([
      npmArtifact("dist/pkg-1.2.3.tgz", "pkg", "1.2.3", "cd".repeat(32)),
    ]);
    return { scanId: "s", stageId: "g", organizationId: "o", ...candidate.pipelineInput };
  }

  test("parseInput validates the synthesized manifest + artifact", () => {
    const input = npmGateAdapter.parseInput(gateInput());
    expect(input.manifest.package).toBe("pkg");
    expect(input.artifact.sha256).toBe("cd".repeat(32));
    expect(() => npmGateAdapter.parseInput({})).toThrow();
  });

  test("acquireStaged reassembles parsed files without a broker, carrying the digest", async () => {
    const input = npmGateAdapter.parseInput(gateInput());
    const ctx = {
      env,
      executionCtx: createExecutionContext(),
      db: createDb(env.DB),
      session: { userId: "u" },
    };
    const staged = await npmGateAdapter.acquireStaged(ctx, input, {} as never);
    expect(staged.artifact.manifest).toEqual({ name: "pkg", version: "1.2.3" });
    expect((staged.details as NpmGateDetails).digest).toBe("cd".repeat(32));
    expect((staged.details as NpmGateDetails).mode).toBe("workflow_gate");
  });

  test("describe + summarizeDetails surface identity and the reviewed digest", () => {
    const input = npmGateAdapter.parseInput(gateInput());
    const details: NpmGateDetails = {
      mode: "workflow_gate",
      manifest: input.manifest,
      digest: input.artifact.sha256,
    };
    const summary = npmGateAdapter.describe({
      input,
      staged: { files: input.artifact.files, manifest: input.artifact.packageJson },
      details,
      baseline: { version: null, tag: null, source: "none", distTagVersion: null, reason: "x" },
      previous: null,
    });
    expect(summary).toEqual({
      name: "pkg",
      stagedVersion: "1.2.3",
      stagedTag: null,
      previousVersion: null,
    });
    expect(npmGateAdapter.summarizeDetails(details)).toEqual({
      mode: "workflow_gate",
      ecosystem: "npm",
      digest: "cd".repeat(32),
      manifest: input.manifest,
    });
  });

  test("degrades to a full-tree review when the baseline cannot be fetched", async () => {
    const input = npmGateAdapter.parseInput(gateInput());
    const ctx = {
      env,
      executionCtx: createExecutionContext(),
      db: createDb(env.DB),
      session: { userId: "u" },
    };
    // A workflow gate does not require an org npm token; a broker that throws on
    // credential resolution must not fail the gate closed.
    const throwingBroker = {
      dispose() {},
      fetchPackageMetadata() {
        throw new Error("Connect an organization npm token before scanning.");
      },
      fetchStagedDetails: async () => null,
      downloadStaged: async () => {
        throw new Error("unused");
      },
      downloadPublished: async () => {
        throw new Error("unused");
      },
    };
    const staged = await npmGateAdapter.acquireStaged(ctx, input, throwingBroker as never);
    const result = await npmGateAdapter.acquireBaseline(
      ctx,
      input,
      throwingBroker as never,
      staged,
    );
    expect(result.artifact).toBeNull();
    expect(result.baseline.source).toBe("none");
    expect(result.baseline.reason).toBe("baseline-unavailable");
  });
});

// ── Integration: auto-detect npm bundle through the shared runner ─────────────

interface ZipEntry {
  path: string;
  body: string;
}

function makeZip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const records: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const body = encoder.encode(entry.body);
    const nameBytes = encoder.encode(entry.path);
    const crc = crc32(body);
    const local = new Uint8Array(30 + nameBytes.length + body.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
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

interface SandboxResult {
  files: { path: string; size: number; sha256: string; flags: string[]; textSample?: string }[];
  packageJson: { name?: string; version?: string } | null;
}

// Returns one parsed result per artifact the router parses, in bundle order.
function buildLoaderMock(results: SandboxResult[]) {
  const calls: { format: string | null }[] = [];
  let index = 0;
  return {
    calls,
    binding: {
      load: vi.fn(() => ({
        getEntrypoint: () => ({
          fetch: vi.fn(async (request: Request) => {
            calls.push({ format: request.headers.get("x-archive-format") });
            const result = results[Math.min(index, results.length - 1)];
            index += 1;
            return new Response(JSON.stringify(result), {
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
  ctx.exports = { NpmStageGateway: vi.fn(() => ({ fetch: vi.fn() }) as unknown as Fetcher) };
  return ctx;
}

function configBindings(): Record<string, string> {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  return {
    GITHUB_APP_ID: "12345",
    GITHUB_APP_SLUG: "drydock-test",
    GITHUB_APP_CLIENT_ID: "client-id",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_PRIVATE_KEY: privateKeyPem,
    GITHUB_APP_WEBHOOK_SECRET: "webhook-secret-value-1234567890",
    GITHUB_APP_STATE_SECRET: "0123456789abcdef0123456789abcdef",
    BETTER_AUTH_SECRET: "fallback-secret-with-enough-entropy-aaaaaaaa",
  };
}

// Auto-detect release target (ecosystem null): npm `.tgz` must route by content.
async function seedAutoDetectGate(opts: {
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
    ecosystem: null,
    repositoryId: opts.repositoryId,
    repositoryFullName: "octo/example",
    environment: "npm",
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
    environment: "npm",
    runId: opts.runId,
    deploymentId: 909,
    deploymentCallbackUrl: `https://api.github.com/repos/octo/example/actions/runs/${opts.runId}/deployment_protection_rule`,
    eventAction: "requested",
    status: "pending",
    requestedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return { organizationId, gateId };
}

function stubGithubFetch(runId: number, artifactPaths: string[]) {
  const bundleZip = makeZip(artifactPaths.map((path) => ({ path, body: `bytes for ${path}` })));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url.includes("/access_tokens")) {
        return Response.json({ token: "ghs_install_token", expires_at: "2099-01-01T00:00:00Z" });
      }
      if (request.url.includes(`/actions/runs/${runId}/artifacts`)) {
        return Response.json({
          total_count: 1,
          artifacts: [
            {
              id: 4242,
              name: "npm-release-candidates",
              size_in_bytes: bundleZip.length,
              expired: false,
            },
          ],
        });
      }
      if (request.url.includes("/actions/artifacts/")) {
        return new Response(bundleZip, {
          status: 200,
          headers: { "content-type": "application/zip" },
        });
      }
      throw new Error(`unexpected fetch: ${request.url}`);
    }),
  );
}

describe("prepareReleaseCandidatesForGate · npm auto-detect", () => {
  test("routes a .tgz with a package.json to the npm adapter", async () => {
    const seeded = await seedAutoDetectGate({
      installationExternalId: "9300",
      repositoryId: 73001,
      runId: 6001,
    });
    stubGithubFetch(6001, ["dist/left-pad-1.3.0.tgz"]);
    const loader = buildLoaderMock([
      {
        files: [
          {
            path: "package.json",
            size: 20,
            sha256: "00",
            flags: [],
            textSample: '{"name":"left-pad","version":"1.3.0"}',
          },
        ],
        packageJson: { name: "left-pad", version: "1.3.0" },
      },
    ]);
    const ctx = buildCtxWithGateway();
    const bindings = configBindings();
    const config = readGithubAppConfig(bindings);
    const sandboxEnv = {
      ...env,
      ...bindings,
      LOADER: loader.binding as unknown as WorkerLoader,
    } as Cloudflare.Env;
    const db = createDb(env.DB);

    const result = await prepareReleaseCandidatesForGate(sandboxEnv, ctx, db, {
      config,
      organizationId: seeded.organizationId,
      gateId: seeded.gateId,
    });

    expect(result.packages).toHaveLength(1);
    expect(result.packages[0].candidate.ecosystem).toBe("npm");
    expect(result.packages[0].packageAdapter.id).toBe("npm");
    expect(result.packages[0].candidate.package).toEqual({ name: "left-pad", version: "1.3.0" });
    expect(loader.calls).toEqual([{ format: "tgz" }]);
    vi.unstubAllGlobals();
  });

  test("fans a monorepo of npm tarballs into one candidate per package", async () => {
    const seeded = await seedAutoDetectGate({
      installationExternalId: "9301",
      repositoryId: 73002,
      runId: 6002,
    });
    stubGithubFetch(6002, ["dist/alpha-1.0.0.tgz", "dist/beta-2.0.0.tgz"]);
    const loader = buildLoaderMock([
      {
        files: [
          {
            path: "package.json",
            size: 20,
            sha256: "00",
            flags: [],
            textSample: '{"name":"@scope/alpha","version":"1.0.0"}',
          },
        ],
        packageJson: { name: "@scope/alpha", version: "1.0.0" },
      },
      {
        files: [
          {
            path: "package.json",
            size: 20,
            sha256: "00",
            flags: [],
            textSample: '{"name":"@scope/beta","version":"2.0.0"}',
          },
        ],
        packageJson: { name: "@scope/beta", version: "2.0.0" },
      },
    ]);
    const ctx = buildCtxWithGateway();
    const bindings = configBindings();
    const config = readGithubAppConfig(bindings);
    const sandboxEnv = {
      ...env,
      ...bindings,
      LOADER: loader.binding as unknown as WorkerLoader,
    } as Cloudflare.Env;
    const db = createDb(env.DB);

    const result = await prepareReleaseCandidatesForGate(sandboxEnv, ctx, db, {
      config,
      organizationId: seeded.organizationId,
      gateId: seeded.gateId,
    });

    const names = result.packages.map((p) => p.candidate.package.name).sort();
    expect(names).toEqual(["@scope/alpha", "@scope/beta"]);
    for (const pkg of result.packages) expect(pkg.candidate.ecosystem).toBe("npm");
    vi.unstubAllGlobals();
  });

  test("fails the gate closed when a tarball carries no package.json", async () => {
    const seeded = await seedAutoDetectGate({
      installationExternalId: "9302",
      repositoryId: 73003,
      runId: 6003,
    });
    stubGithubFetch(6003, ["dist/mystery-1.0.0.tgz"]);
    const loader = buildLoaderMock([
      { files: [{ path: "lib/index.js", size: 5, sha256: "00", flags: [] }], packageJson: null },
    ]);
    const ctx = buildCtxWithGateway();
    const bindings = configBindings();
    const config = readGithubAppConfig(bindings);
    const sandboxEnv = {
      ...env,
      ...bindings,
      LOADER: loader.binding as unknown as WorkerLoader,
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
    vi.unstubAllGlobals();
  });

  test("fails the gate closed when a tarball looks like both npm and PyPI", async () => {
    const seeded = await seedAutoDetectGate({
      installationExternalId: "9303",
      repositoryId: 73004,
      runId: 6004,
    });
    stubGithubFetch(6004, ["dist/evil-1.0.0.tgz"]);
    // An npm tarball carrying a decoy root PKG-INFO would otherwise be routed to
    // the PyPI adapter by registration order, skipping every npm finding.
    const loader = buildLoaderMock([
      {
        files: [
          {
            path: "package.json",
            size: 20,
            sha256: "00",
            flags: [],
            textSample: '{"name":"evil","version":"1.0.0"}',
          },
          { path: "PKG-INFO", size: 5, sha256: "00", flags: [] },
        ],
        packageJson: { name: "evil", version: "1.0.0" },
      },
    ]);
    const ctx = buildCtxWithGateway();
    const bindings = configBindings();
    const config = readGithubAppConfig(bindings);
    const sandboxEnv = {
      ...env,
      ...bindings,
      LOADER: loader.binding as unknown as WorkerLoader,
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
    vi.unstubAllGlobals();
  });
});
