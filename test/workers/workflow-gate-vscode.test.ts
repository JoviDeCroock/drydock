import { env } from "cloudflare:test";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { createDb } from "../../server/db/client";
import * as schema from "../../server/db/schema";
import { type GithubAppEnv, readGithubAppConfig } from "../../server/lib/github-app/config";
import { createReleaseTarget, upsertInstallation } from "../../server/lib/github-app/persistence";
import { validateReleaseTargetShape } from "../../server/lib/github-app/validation";
import { prepareReleaseCandidatesForGate } from "../../server/lib/workflow-gates/prepare";
import {
  classifyBundleArtifact,
  detectArchiveEcosystems,
  getWorkflowGateAdapter,
  supportedWorkflowGateEcosystems,
} from "../../server/lib/ecosystems";
import { resolveBundleArtifacts } from "../../server/lib/workflow-gates/resolve";
import { vscodeWorkflowGateAdapter } from "../../server/lib/ecosystems/vscode/workflow-gate";
import {
  type ResolvedReleaseBundle,
  WorkflowArtifactError,
} from "../../server/lib/github-app/artifacts";
import { buildZip } from "../helpers/archive-fixtures";
import { buildCtxWithGateway, buildLoaderMock, stubGithubFetch } from "./helpers/gate";
import { seedPersonalOrganization } from "./helpers/seed";

function stubRunArtifacts(runId: number, artifactPaths: string[]) {
  stubGithubFetch({
    runId,
    installationToken: true,
    // The inline stub this replaced sent no content-length, so the gate path
    // keeps exercising the undeclared-length download branch.
    contentLength: null,
    artifacts: [
      {
        id: 4242,
        name: "release-candidates",
        bundleZip: buildZip(artifactPaths.map((path) => ({ path, body: `bytes for ${path}` }))),
      },
    ],
  });
}

const SHA = "cd".repeat(32);

describe("VS Code workflow-gate adapter", () => {
  test("registers vscode and classifies VSIX artifacts", () => {
    expect(getWorkflowGateAdapter("vscode")).toBe(vscodeWorkflowGateAdapter);
    expect(supportedWorkflowGateEcosystems()).toEqual(
      expect.arrayContaining(["pypi", "npm", "vscode"]),
    );
    expect(classifyBundleArtifact("dist/example.remote-text-fetcher-1.0.0.vsix")).toEqual({
      ecosystem: "vscode",
      kind: "vsix",
    });
  });

  test("does not claim generic tar archives during auto-detect", () => {
    const claims = detectArchiveEcosystems({
      packageJson: { name: "npm-package", version: "1.0.0" },
      files: [
        {
          path: "extension/package.json",
          size: 120,
          sha256: "00",
          flags: [],
          textSample: JSON.stringify({
            name: "remote-text-fetcher",
            publisher: "example",
            version: "1.0.0",
            engines: { vscode: "^1.80.0" },
          }),
        },
      ],
    });

    expect(claims).toEqual([{ ecosystem: "npm", kind: "tarball" }]);
  });

  test("accepts vscode release targets", () => {
    expect(() =>
      validateReleaseTargetShape({
        ecosystem: "vscode",
        repositoryId: 123,
        repositoryFullName: "octo/example",
        environment: "vscode",
        installationRowId: "installation",
        organizationId: "org",
        artifactName: null,
        createdByUserId: null,
      }),
    ).not.toThrow();
  });

  test("parses VSIX bytes through the shared ZIP sandbox and prepares a scan candidate", async () => {
    const bundle: ResolvedReleaseBundle = {
      artifactId: 1,
      artifactName: "vscode-release-candidate",
      artifactSizeBytes: 1,
      artifacts: [
        {
          path: "dist/remote-text-fetcher-1.0.0.vsix",
          bytes: new Uint8Array([1, 2, 3]),
          sha256: SHA,
          ecosystem: "vscode",
          kind: "vsix",
        },
      ],
    };

    const loader = buildLoaderMock({
      results: [
        {
          files: [
            {
              path: "extension/package.json",
              size: 120,
              sha256: "00",
              flags: [],
              textSample: JSON.stringify({
                name: "remote-text-fetcher",
                publisher: "example",
                version: "1.0.0",
                engines: { vscode: "^1.80.0" },
                main: "./out/extension",
                activationEvents: ["onStartupFinished"],
              }),
            },
            {
              path: "extension/out/extension.js",
              size: 26,
              sha256: "00",
              flags: [],
              textSample: "exports.activate = () => {};",
            },
          ],
          packageJson: null,
          suspiciousEntries: [
            {
              kind: "retention-tier",
              path: "<archive>",
              detail: "one file body was recorded hash-only",
            },
          ],
        },
      ],
    });
    const parsed = await resolveBundleArtifacts(
      { ...env, LOADER: loader.binding as unknown as WorkerLoader } as Cloudflare.Env,
      buildCtxWithGateway(),
      bundle,
    );
    expect(loader.calls.map((call) => call.format)).toEqual(["vsix"]);
    expect(parsed[0].files.some((file) => file.path === "extension/package.json")).toBe(true);
    const [candidate] = vscodeWorkflowGateAdapter.prepareReleaseCandidates(parsed);
    expect(candidate).toMatchObject({
      ecosystem: "vscode",
      package: { name: "example.remote-text-fetcher", version: "1.0.0" },
    });
    expect(candidate.pipelineInput.manifest).toMatchObject({
      ecosystem: "vscode",
      package: "example.remote-text-fetcher",
      version: "1.0.0",
    });
    expect(candidate.pipelineInput.artifact).toMatchObject({
      suspiciousEntries: [
        expect.objectContaining({
          kind: "retention-tier",
        }),
      ],
    });
  });

  test("fails closed when a VSIX artifact has no extension manifest", () => {
    expect(() =>
      vscodeWorkflowGateAdapter.prepareReleaseCandidates([
        {
          path: "dist/malformed.vsix",
          sha256: SHA,
          ecosystem: "vscode",
          kind: "vsix",
          files: [
            {
              path: "extension/out/extension.js",
              size: 26,
              sha256: "00",
              flags: [],
              textSample: "exports.activate = () => {};",
            },
          ],
          packageJson: null,
        },
      ]),
    ).toThrow(WorkflowArtifactError);
  });

  test("fails closed when a release contains duplicate VSIX identities", () => {
    expect(() =>
      vscodeWorkflowGateAdapter.prepareReleaseCandidates([
        vsixArtifact("dist/remote-text-fetcher-1.0.0.vsix", "remote-text-fetcher", "1.0.0"),
        vsixArtifact("dist/remote-text-fetcher-copy-1.0.0.vsix", "remote-text-fetcher", "1.0.0"),
      ]),
    ).toThrow(/more than one VSIX artifact/);

    expect(() =>
      vscodeWorkflowGateAdapter.prepareReleaseCandidates([
        vsixArtifact("dist/remote-text-fetcher-1.0.0.vsix", "remote-text-fetcher", "1.0.0"),
        vsixArtifact("dist/remote-text-fetcher-1.0.1.vsix", "remote-text-fetcher", "1.0.1"),
      ]),
    ).toThrow(/version 1.0.1 disagrees with 1.0.0/);
  });

  test("fails closed on case-only duplicate VSIX identities", () => {
    // The Marketplace resolves publisher/name case-insensitively and the parser
    // accepts grandfathered capitalized names, so example.Remote-Text-Fetcher and
    // example.remote-text-fetcher are the same extension. They must collapse to a
    // single identity and fail closed, not split into two review candidates.
    expect(() =>
      vscodeWorkflowGateAdapter.prepareReleaseCandidates([
        vsixArtifact("dist/remote-text-fetcher-1.0.0.vsix", "Remote-Text-Fetcher", "1.0.0"),
        vsixArtifact("dist/remote-text-fetcher-copy-1.0.0.vsix", "remote-text-fetcher", "1.0.0"),
      ]),
    ).toThrow(/more than one VSIX artifact/);
  });

  test("preserves the original extension id casing for a single VSIX", () => {
    const [candidate] = vscodeWorkflowGateAdapter.prepareReleaseCandidates([
      vsixArtifact("dist/remote-text-fetcher-1.0.0.vsix", "Remote-Text-Fetcher", "1.0.0"),
    ]);
    expect(candidate.package.name).toBe("example.Remote-Text-Fetcher");
  });
});

// ── Integration: auto-detect VSIX bundle through the shared runner ────────────

describe("prepareReleaseCandidatesForGate · vscode auto-detect", () => {
  test("routes a .vsix to the vscode adapter via the ZIP sandbox", async () => {
    const seeded = await seedAutoDetectGate({
      installationExternalId: "9400",
      repositoryId: 74001,
      runId: 7001,
    });
    stubRunArtifacts(7001, ["dist/remote-text-fetcher-1.0.0.vsix"]);
    const loader = buildFormatLoaderMock({ vsix: vscodeSandboxResult() });
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
    expect(result.packages[0].candidate.ecosystem).toBe("vscode");
    expect(result.packages[0].packageAdapter.id).toBe("vscode");
    expect(result.packages[0].candidate.package).toEqual({
      name: "example.remote-text-fetcher",
      version: "1.0.0",
    });
    expect(loader.calls.map((call) => call.format)).toEqual(["vsix"]);
    vi.unstubAllGlobals();
  });

  test("fans a mixed npm + VSIX bundle into one candidate per ecosystem", async () => {
    const seeded = await seedAutoDetectGate({
      installationExternalId: "9401",
      repositoryId: 74002,
      runId: 7002,
    });
    stubRunArtifacts(7002, ["dist/alpha-1.0.0.tgz", "dist/remote-text-fetcher-1.0.0.vsix"]);
    const loader = buildFormatLoaderMock({
      tgz: {
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
      vsix: vscodeSandboxResult(),
    });
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

    const candidates = result.packages
      .map((pkg) => ({
        ecosystem: pkg.candidate.ecosystem,
        adapter: pkg.packageAdapter.id,
        ...pkg.candidate.package,
      }))
      .sort((a, b) => a.ecosystem.localeCompare(b.ecosystem));
    expect(candidates).toEqual([
      { ecosystem: "npm", adapter: "npm", name: "@scope/alpha", version: "1.0.0" },
      {
        ecosystem: "vscode",
        adapter: "vscode",
        name: "example.remote-text-fetcher",
        version: "1.0.0",
      },
    ]);
    expect(loader.calls.map((call) => call.format).sort()).toEqual(["tgz", "vsix"]);
    vi.unstubAllGlobals();
  });
});

interface SandboxResult {
  files: { path: string; size: number; sha256: string; flags: string[]; textSample?: string }[];
  packageJson: { name?: string; version?: string } | null;
  suspiciousEntries?: Array<{ kind: string; path: string; detail: string }>;
}

function vsixArtifact(path: string, name: string, version: string) {
  return {
    path,
    sha256: SHA,
    ecosystem: "vscode",
    kind: "vsix",
    files: [
      {
        path: "extension/package.json",
        size: 120,
        sha256: "00",
        flags: [],
        textSample: JSON.stringify({
          name,
          publisher: "example",
          version,
          engines: { vscode: "^1.80.0" },
        }),
      },
    ],
    packageJson: null,
  };
}

function vscodeSandboxResult(): SandboxResult {
  return {
    files: [
      {
        path: "extension/package.json",
        size: 160,
        sha256: "00",
        flags: [],
        textSample: JSON.stringify({
          name: "remote-text-fetcher",
          publisher: "example",
          version: "1.0.0",
          engines: { vscode: "^1.80.0" },
          main: "./out/extension",
          activationEvents: ["onCommand:remoteTextFetcher.run"],
        }),
      },
      {
        path: "extension/out/extension.js",
        size: 26,
        sha256: "00",
        flags: [],
        textSample: "exports.activate = () => {};",
      },
    ],
    packageJson: null,
  };
}

// Keyed by x-archive-format so parse-order (which is concurrent) cannot skew
// which artifact gets which parsed result.
const buildFormatLoaderMock = (resultsByFormat: Record<string, SandboxResult>) =>
  buildLoaderMock({
    respond: (request) => {
      const format = request.headers.get("x-archive-format") ?? "";
      const result = resultsByFormat[format];
      if (!result) throw new Error(`unexpected archive format ${format}`);
      return Response.json(result);
    },
  });

function configBindings(): GithubAppEnv {
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

// Auto-detect release target (ecosystem null): a `.vsix` must route by name.
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
  const organizationId = await seedPersonalOrganization(db, userId);
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
    environment: "release",
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
    environment: "release",
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
