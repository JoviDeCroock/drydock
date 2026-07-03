import { createExecutionContext, env } from "cloudflare:test";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import * as schema from "../../server/db/schema";
import { readGithubAppConfig } from "../../server/lib/github-app/config";
import { upsertInstallation } from "../../server/lib/github-app/persistence";
import { getGateForOrganization } from "../../server/lib/github-app/webhook-gates";
import { WorkflowArtifactError } from "../../server/lib/github-app/artifacts";
import { cratesWorkflowGateAdapter } from "../../server/lib/workflow-gates/crates";
import { goWorkflowGateAdapter } from "../../server/lib/workflow-gates/go";
import { prepareReleaseCandidatesForGate } from "../../server/lib/workflow-gates/prepare";
import { pypiWorkflowGateAdapter } from "../../server/lib/workflow-gates/pypi";
import {
  AMBIGUOUS_ARCHIVE_ECOSYSTEM,
  UnsupportedEcosystemError,
  classifyBundleArtifact,
  detectArchiveEcosystems,
  getWorkflowGateAdapter,
  supportedWorkflowGateEcosystems,
} from "../../server/lib/workflow-gates/registry";
import type { ParsedGateArtifact } from "../../server/lib/workflow-gates/types";

// ── Pure adapter dispatch ────────────────────────────────────────────────────

describe("workflow-gate adapter registry", () => {
  test("resolves the PyPI adapter by ecosystem", () => {
    const adapter = getWorkflowGateAdapter("pypi");
    expect(adapter).toBe(pypiWorkflowGateAdapter);
    expect(adapter.ecosystem).toBe("pypi");
  });

  test("throws UnsupportedEcosystemError for an ecosystem without an adapter", () => {
    let caught: unknown;
    try {
      getWorkflowGateAdapter("cargo");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnsupportedEcosystemError);
    expect((caught as UnsupportedEcosystemError).ecosystem).toBe("cargo");
  });

  test("lists every registered ecosystem", () => {
    expect(supportedWorkflowGateEcosystems()).toEqual(
      expect.arrayContaining(["pypi", "npm", "crates", "go"]),
    );
  });

  test("resolves the crates and go adapters by ecosystem", () => {
    expect(getWorkflowGateAdapter("crates")).toBe(cratesWorkflowGateAdapter);
    expect(getWorkflowGateAdapter("go")).toBe(goWorkflowGateAdapter);
  });
});

// ── crates/go: classification, content detection, candidate derivation ───────

function gateFile(path: string, textSample: string) {
  return { path, size: textSample.length, sha256: `sha-${path}`, flags: [], textSample };
}

function crateArtifact(name: string, version: string, path: string): ParsedGateArtifact {
  return {
    path,
    sha256: "ab".repeat(32),
    ecosystem: "crates",
    kind: "crate",
    files: [
      gateFile(
        `${name}-${version}/Cargo.toml`,
        `[package]\nname = "${name}"\nversion = "${version}"\n`,
      ),
      gateFile(`${name}-${version}/src/lib.rs`, "pub fn v() {}\n"),
    ],
    packageJson: null,
  };
}

function goArtifact(modulePath: string, version: string, path: string): ParsedGateArtifact {
  return {
    path,
    sha256: "cd".repeat(32),
    ecosystem: "go",
    kind: "module",
    files: [
      gateFile(`${modulePath}@${version}/go.mod`, `module ${modulePath}\n\ngo 1.22\n`),
      gateFile(`${modulePath}@${version}/main.go`, "package demo\n"),
    ],
    packageJson: null,
  };
}

describe("workflow-gate registry with crates and go registered", () => {
  test("classifies .crate as crates and .zip as go, keeping .tar.gz ambiguous", () => {
    expect(classifyBundleArtifact("target/package/demo-1.0.0.crate")).toEqual({
      ecosystem: "crates",
      kind: "crate",
    });
    expect(classifyBundleArtifact("dist/demo-v1.0.0.zip")).toEqual({
      ecosystem: "go",
      kind: "module",
    });
    expect(classifyBundleArtifact("dist/pkg-1.0.0.tar.gz")).toEqual({
      ecosystem: AMBIGUOUS_ARCHIVE_ECOSYSTEM,
      kind: "archive",
    });
  });

  test("content-detects a crate via its root Cargo.toml.orig and a module zip via its root", () => {
    expect(
      detectArchiveEcosystems({
        files: [gateFile("demo-1.0.0/Cargo.toml.orig", "[package]")],
        packageJson: null,
      }),
    ).toEqual([{ ecosystem: "crates", kind: "crate" }]);
    expect(
      detectArchiveEcosystems({
        files: [gateFile("example.com/demo@v1.0.0/go.mod", "module example.com/demo\n")],
        packageJson: null,
      }),
    ).toEqual([{ ecosystem: "go", kind: "module" }]);
    // A vendored Cargo.toml deeper in the tree must not claim the archive.
    expect(
      detectArchiveEcosystems({
        files: [gateFile("pkg/vendor/demo/Cargo.toml.orig", "[package]")],
        packageJson: null,
      }),
    ).toEqual([]);
  });

  test("derives one crates candidate per crate name and rejects duplicates", () => {
    const candidates = cratesWorkflowGateAdapter.prepareReleaseCandidates([
      crateArtifact("demo-a", "1.0.0", "demo-a-1.0.0.crate"),
      crateArtifact("demo-b", "2.0.0", "demo-b-2.0.0.crate"),
    ]);
    expect(candidates.map((candidate) => candidate.package)).toEqual([
      { name: "demo-a", version: "1.0.0" },
      { name: "demo-b", version: "2.0.0" },
    ]);
    expect(candidates.every((candidate) => candidate.ecosystem === "crates")).toBe(true);

    expect(() =>
      cratesWorkflowGateAdapter.prepareReleaseCandidates([
        crateArtifact("demo-a", "1.0.0", "one.crate"),
        crateArtifact("demo-a", "1.0.0", "two.crate"),
      ]),
    ).toThrow(WorkflowArtifactError);
  });

  test("derives one go candidate per module path and rejects identity-less zips", () => {
    const candidates = goWorkflowGateAdapter.prepareReleaseCandidates([
      goArtifact("example.com/demo", "v1.0.0", "demo-v1.0.0.zip"),
      goArtifact("example.com/other", "v2.0.0", "other-v2.0.0.zip"),
    ]);
    expect(candidates.map((candidate) => candidate.package)).toEqual([
      { name: "example.com/demo", version: "v1.0.0" },
      { name: "example.com/other", version: "v2.0.0" },
    ]);

    expect(() =>
      goWorkflowGateAdapter.prepareReleaseCandidates([
        {
          path: "bad.zip",
          sha256: "ef".repeat(32),
          ecosystem: "go",
          kind: "module",
          files: [gateFile("go.mod", "module example.com/demo\n")],
          packageJson: null,
        },
      ]),
    ).toThrow(WorkflowArtifactError);
  });
});

// ── Dispatch failure inside the shared runner ────────────────────────────────

function buildConfig() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  return readGithubAppConfig({
    GITHUB_APP_ID: "12345",
    GITHUB_APP_SLUG: "drydock-test",
    GITHUB_APP_CLIENT_ID: "client-id",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_PRIVATE_KEY: privateKeyPem,
    GITHUB_APP_WEBHOOK_SECRET: "webhook-secret-value-1234567890",
    GITHUB_APP_STATE_SECRET: "0123456789abcdef0123456789abcdef",
    BETTER_AUTH_SECRET: "fallback-secret-with-enough-entropy-aaaaaaaa",
  });
}

// Seed an org + active installation + a pending gate whose release target names
// an ecosystem with no registered workflow-gate adapter. The release target is
// inserted directly (not via `createReleaseTarget`, which rejects unsupported
// ecosystems) so we can exercise the runner's adapter-selection failure.
async function seedUnsupportedEcosystemGate(ecosystem: string) {
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
    installationId: "9200",
    accountLogin: "octo",
    accountType: "Organization",
    targetType: "Organization",
    status: "active",
    createdByUserId: null,
  });
  const releaseTargetId = crypto.randomUUID();
  await db.insert(schema.githubReleaseTargets).values({
    id: releaseTargetId,
    organizationId,
    installationRowId: installation.id,
    ecosystem,
    repositoryId: 72001,
    repositoryFullName: "octo/example",
    environment: "release",
    createdByUserId: null,
    createdAt: now,
    updatedAt: now,
  });
  const gateId = crypto.randomUUID();
  await db.insert(schema.githubWorkflowGates).values({
    id: gateId,
    organizationId,
    installationRowId: installation.id,
    releaseTargetId,
    deliveryId: crypto.randomUUID(),
    repositoryId: 72001,
    repositoryFullName: "octo/example",
    environment: "release",
    runId: 7000,
    deploymentId: 909,
    deploymentCallbackUrl:
      "https://api.github.com/repos/octo/example/actions/runs/7000/deployment_protection_rule",
    eventAction: "requested",
    status: "pending",
    requestedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return { organizationId, gateId };
}

describe("prepareReleaseCandidatesForGate adapter dispatch", () => {
  test("marks the gate errored and rethrows when the ecosystem has no adapter", async () => {
    const { organizationId, gateId } = await seedUnsupportedEcosystemGate("cargo");
    const ctx = createExecutionContext();
    const config = buildConfig();
    const db = createDb(env.DB);

    await expect(
      prepareReleaseCandidatesForGate(env, ctx, db, { config, organizationId, gateId }),
    ).rejects.toBeInstanceOf(UnsupportedEcosystemError);

    // A configuration/data problem leaves the gate pending (never auto-approved)
    // with the typed reason recorded for the dashboard.
    const refreshed = await getGateForOrganization(db, organizationId, gateId);
    expect(refreshed?.status).toBe("pending");
    expect(refreshed?.failureReason).toBe("unsupported_ecosystem");
  });
});
