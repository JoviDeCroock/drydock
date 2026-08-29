import { buildNpmReleaseManifest, npmGateAdapter } from "./gate-review";
import { erasePackageAdapter } from "../package-adapter";
import { WorkflowArtifactError } from "../../github-app/artifacts";
import { buildManifestOrFail, groupReleaseCandidates } from "../../workflow-gates/group-candidates";
import type {
  ArchiveContents,
  GateSetupTemplate,
  GateSetupTemplateInput,
  ParsedGateArtifact,
  PreparedReleaseCandidate,
  WorkflowArtifactKind,
  WorkflowGateAdapter,
} from "../../workflow-gates/types";

const NPM_GATE_ARTIFACT_NAME = "npm-release-candidates";

/**
 * npm workflow-gate adapter.
 *
 * The release set is whatever `.tgz` tarballs the workflow uploaded (`npm pack`
 * output) — no maintainer-declared manifest. Identity (`package`/`version`) is
 * read from each tarball's `package.json` after the bytes are parsed in the
 * shared sandbox router, and the manifest is synthesized server-side with the
 * recomputed digest. Because an npm `.tgz` is indistinguishable from a PyPI
 * sdist by name, auto-detect targets route here by content (`detectArtifact`):
 * an archive that carries a root `package.json` is npm's.
 *
 * The deterministic review, baseline selection (through the org npm connection),
 * findings, and risk model are shared with the staged-publish path via
 * `npmGateAdapter` (`server/lib/ecosystems/npm/gate-review`).
 */
export const npmWorkflowGateAdapter: WorkflowGateAdapter = {
  ecosystem: "npm",
  // Matches the `actions/upload-artifact` name in the documented release flow,
  // but discovery does not require it — auto-detect inspects every upload.
  artifactName: NPM_GATE_ARTIFACT_NAME,
  packageAdapter: erasePackageAdapter(npmGateAdapter),

  gateSetupTemplate(input: GateSetupTemplateInput): GateSetupTemplate {
    return npmGateSetupTemplate(input);
  },

  classifyArtifact(path: string): WorkflowArtifactKind | null {
    const lower = path.toLowerCase();
    return lower.endsWith(".tgz") || lower.endsWith(".tar.gz") ? "tarball" : null;
  },

  detectArtifact(contents: ArchiveContents): WorkflowArtifactKind | null {
    // `package.json` is surfaced from the npm `package/` root by the sandbox
    // parser; a PyPI sdist never carries a root `package.json`.
    return contents.packageJson?.name ? "tarball" : null;
  },

  // Tarballs are grouped by `package.json` name (a monorepo's `npm run
  // pack:all` → `dist/*.tgz`). A single npm package version is exactly one
  // tarball, so a second tarball claiming the same name is rejected.
  prepareReleaseCandidates(artifacts: ParsedGateArtifact[]): PreparedReleaseCandidate[] {
    return groupReleaseCandidates(artifacts, {
      identity(artifact) {
        const name = artifact.packageJson?.name;
        const version = artifact.packageJson?.version;
        if (!name || !version) {
          throw new WorkflowArtifactError(
            "artifact_identity_missing",
            `${artifact.path} does not expose a package.json name/version`,
          );
        }
        return { key: name, name, version };
      },
      allowMultiplePerGroup: false,
      duplicateMessage: (identity) =>
        `package ${identity.name} has more than one tarball in this release`,
      buildManifest: (identity, [artifact]) =>
        buildManifestOrFail(
          () =>
            buildNpmReleaseManifest(identity.name, identity.version, [
              { path: artifact.path, sha256: artifact.sha256 },
            ]),
          "derived release identity is not valid",
        ),
      candidate: (manifest, [artifact]) => ({
        ecosystem: "npm",
        pipelineInput: {
          manifest,
          artifact: {
            path: artifact.path,
            sha256: artifact.sha256,
            sha1: artifact.sha1,
            files: artifact.files,
            packageJson: artifact.packageJson,
            ...(artifact.suspiciousEntries
              ? { suspiciousEntries: artifact.suspiciousEntries }
              : {}),
          },
        },
        package: { name: manifest.package, version: manifest.version },
      }),
    });
  },
};

/**
 * The npm publish workflow the setup wizard offers as a pull request.
 *
 * Same contract as the canonical example in `docs/workflow-gates.md`: pack
 * once, record `SHA256SUMS` beside the tarballs, upload both, pause at the
 * gated environment, re-check the digests on download, and publish the exact
 * reviewed bytes. `id-token: write` with no token secret keeps it on the npm
 * trusted-publishing path (`docs/npm-trusted-publishing.md`).
 */
function npmGateSetupTemplate({
  environmentName,
  packageName,
}: GateSetupTemplateInput): GateSetupTemplate {
  return {
    workflowPath: ".github/workflows/drydock-npm-release.yml",
    yaml: `# Drydock workflow gate — npm
# Package: ${packageName}
# Drydock reviews the packed tarballs before the publish job is allowed to run.
name: "Publish ${packageName}"

on:
  workflow_dispatch:
  push:
    tags:
      - "v*"

jobs:
  pack:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      # No registry pin on setup-node: that writes an .npmrc expecting an auth
      # token, and a token is exactly what this workflow exists to avoid.
      - run: npm ci
      - run: mkdir -p dist
      - run: npm pack --pack-destination dist
      # Record the digests Drydock reviews and the publish job re-checks.
      - run: cd dist && sha256sum *.tgz > SHA256SUMS
      - uses: actions/upload-artifact@v4
        with:
          name: ${NPM_GATE_ARTIFACT_NAME}
          path: dist/

  publish:
    needs: pack
    runs-on: ubuntu-latest
    # Drydock is this environment's deployment-protection rule: the job stays
    # queued until the release is approved in Drydock.
    environment: "${environmentName}"
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      # npm's OIDC trusted publishing needs npm >= 11.5.1; the npm bundled with
      # Node 22 (and with the runner image) is older and would fall back to
      # looking for a token that does not exist here.
      - run: npm install -g npm@^11.5.1
      - uses: actions/download-artifact@v4
        with:
          name: ${NPM_GATE_ARTIFACT_NAME}
          path: dist
      # Fail closed if the downloaded bytes drifted from what was reviewed.
      - run: cd dist && sha256sum --check --strict SHA256SUMS
      - run: |
          for tgz in dist/*.tgz; do
            npm publish "$tgz" --access public --provenance
          done
`,
    notes: [
      `On npmjs.com, configure a trusted publisher for \`${packageName}\`: GitHub Actions, this repository, \`drydock-npm-release.yml\`, and — the load-bearing part — the environment set to \`${environmentName}\`.`,
      'Set the package\'s publishing access to "Require two-factor authentication and disallow tokens" so no token path can publish around the gate.',
      "Keep `NODE_AUTH_TOKEN` and `registry-url` out of the workflow entirely: the publish runs on OIDC with npm >= 11.5.1, which the publish job installs.",
    ],
  };
}
