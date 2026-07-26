import { describe, expect, it } from "vitest";
import {
  type AuthorityChange,
  type AuthorityChangeKind,
  computeReleaseAuthorityDelta,
} from "../server/lib/release-authority/delta";
import {
  type ReleaseAuthoritySnapshot,
  buildReleaseAuthoritySnapshot,
} from "../server/lib/release-authority/snapshot";
import { parseWorkflowYaml } from "../server/lib/release-authority/yaml";

// Incident-shaped replay: the compromised-publish pattern the `bittensor-wallet`
// 4.0.2 incident made public — a release that kept building and publishing
// normally while the workflow behind it quietly lost its safeguards and gained
// authority.
//
// PROVENANCE, read this before citing it anywhere: these two workflows are a
// *reconstruction of the pattern*, written for this test. They are not copies
// of the real repository's files and no claim is made that they match them
// line for line. What the fixture demonstrates is which classes of authority
// change Drydock detects deterministically.
//
// It also does not, on its own, demonstrate prevention. Detection is necessary
// but not sufficient: the claim "this would have been blocked" requires the
// blocking path to run end to end, which is exercised separately against the
// real gate decision route in
// `test/workers/release-authority-gate.test.ts` ("holds approval on a changed
// authority until it is acknowledged"). Nothing here should be described as
// prevention on its own.

const ENTRY = ".github/workflows/release.yml";

// The last release shape a maintainer would have approved: tag-triggered, a
// read-only default token, a gated publish job with attestation, publishing
// through the official PyPI action.
const LEGITIMATE = `
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
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
      - run: python -m build
      - uses: actions/upload-artifact@v4
        with:
          name: dist
          path: dist/

  publish:
    needs: build
    runs-on: ubuntu-latest
    environment: pypi
    permissions:
      id-token: write
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: dist
          path: dist/
      - uses: actions/attest-build-provenance@v2
        with:
          subject-path: dist/*
      - uses: pypa/gh-action-pypi-publish@release/v1
        with:
          attestations: true
`;

// The compromised shape. Every edit here keeps the release working, which is
// the point: none of this shows up as a broken build, and several of them are
// invisible in the published package's own bytes.
const COMPROMISED = `
name: Release
on:
  push:
    tags:
      - "v*"
  workflow_dispatch:

permissions:
  contents: write
  id-token: write

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@main
      - run: python -m build
      - uses: actions/upload-artifact@v4
        with:
          name: dist
          path: dist/

  publish:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: dist
          path: dist/
      - run: twine upload --repository-url https://upload.pypi.org/legacy/ dist/*
`;

async function snapshot(workflow: string, headSha: string): Promise<ReleaseAuthoritySnapshot> {
  const parsed = parseWorkflowYaml(workflow);
  return buildReleaseAuthoritySnapshot({
    run: {
      repositoryFullName: "example-org/example-wallet",
      environment: "pypi",
      runId: 1,
      runAttempt: 1,
      workflowPath: ENTRY,
      headSha,
      ref: "refs/tags/v4.0.2",
      event: "push",
      actor: "maintainer",
      triggeringActor: "maintainer",
    },
    workflows: [
      {
        path: ENTRY,
        repositoryFullName: "example-org/example-wallet",
        sha: headSha,
        ref: "refs/tags/v4.0.2",
        role: "entry",
        content: workflow,
        document: parsed.value,
        documentComplete: parsed.complete,
      },
    ],
    artifacts: [
      { name: "example_wallet-4.0.2-py3-none-any.whl", kind: "wheel", sha256: "aa".repeat(32) },
      { name: "example_wallet-4.0.2.tar.gz", kind: "sdist", sha256: "bb".repeat(32) },
    ],
    unresolved: [],
  });
}

function byKind(changes: AuthorityChange[], kind: AuthorityChangeKind): AuthorityChange[] {
  return changes.filter((change) => change.kind === kind);
}

describe("incident replay: compromised publishing workflow", () => {
  it("detects every authority change the compromised workflow introduced", async () => {
    const approved = await snapshot(LEGITIMATE, "a".repeat(40));
    const candidate = await snapshot(COMPROMISED, "d".repeat(40));

    const delta = computeReleaseAuthorityDelta(candidate, {
      snapshot: approved,
      ref: {
        snapshotId: "snap-approved",
        gateId: "gate-approved",
        runId: 1,
        headSha: "a".repeat(40),
        approvedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    expect(delta.status).toBe("changed");
    expect(delta.requiresApproval).toBe(true);
    expect(delta.highestSignificance).toBe("high");

    const kinds = new Set(delta.changes.map((change) => change.kind));

    // The environment held the deployment-protection gate itself. Losing it
    // means nothing pauses the publish job at all.
    expect(kinds).toContain("environment_removed");

    // Attestation and the publisher's own `attestations: true` both disappeared:
    // the release still publishes, it just stops proving where it came from.
    const safeguards = byKind(delta.changes, "safeguard_removed");
    expect(safeguards.length).toBeGreaterThanOrEqual(2);
    expect(safeguards.every((change) => change.significance === "high")).toBe(true);

    // The publish path was swapped from the official action to a raw upload.
    expect(kinds).toContain("publish_step_added");
    expect(kinds).toContain("publish_step_removed");

    // The job-level permissions block is gone, so the job inherits the
    // repository default instead of the narrow set it declared.
    expect(kinds).toContain("permission_block_removed");

    // The workflow-level token gained write scopes.
    expect(byKind(delta.changes, "permission_added").map((change) => change.subject)).toContain(
      "id-token",
    );
    expect(kinds).toContain("permission_widened");

    // A manual trigger means a release no longer has to come from a tag.
    expect(
      byKind(delta.changes, "trigger_added").some(
        (change) => change.subject === "workflow_dispatch" && change.significance === "high",
      ),
    ).toBe(true);

    // A pinned checkout became a branch reference that can move under approval.
    expect(byKind(delta.changes, "action_unpinned").map((change) => change.subject)).toContain(
      "actions/checkout",
    );
  });

  it("says nothing when the same legitimate workflow releases again", async () => {
    const approved = await snapshot(LEGITIMATE, "a".repeat(40));
    // Same authority, later commit, new artifact digests: an ordinary release.
    const candidate = await snapshot(LEGITIMATE, "e".repeat(40));

    const delta = computeReleaseAuthorityDelta(candidate, {
      snapshot: approved,
      ref: {
        snapshotId: "snap-approved",
        gateId: "gate-approved",
        runId: 1,
        headSha: "a".repeat(40),
        approvedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    expect(delta.status).toBe("unchanged");
    expect(delta.requiresApproval).toBe(false);
    expect(delta.changes).toEqual([]);
  });
});
