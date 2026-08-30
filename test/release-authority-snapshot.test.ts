import { describe, expect, it } from "vitest";
import { stableJson, utf8Size } from "../server/lib/platform/stable-json";
import {
  MAX_PERSISTED_SNAPSHOT_BYTES,
  buildReleaseAuthoritySnapshot,
} from "../server/lib/release-authority/snapshot";

describe("release-authority snapshot bounds", () => {
  it("enforces a final UTF-8 budget for repeated long job identifiers", async () => {
    const jobs = Object.create(null) as Record<string, unknown>;
    for (let index = 0; index < 55; index += 1) {
      const job = `j${String(index).padStart(2, "0")}_${"x".repeat(7_900)}`;
      jobs[job] = {
        "runs-on": "ubuntu-latest",
        environment: "pypi",
        permissions: { "id-token": "write" },
        steps: [
          {
            uses: "actions/upload-artifact@v4",
            with: { name: "release", path: "dist/" },
          },
          { uses: "pypa/gh-action-pypi-publish@release/v1" },
        ],
      };
    }

    const snapshot = await buildReleaseAuthoritySnapshot({
      run: {
        repositoryFullName: "octo/example",
        environment: "pypi",
        runId: 42,
        runAttempt: 1,
        workflowPath: ".github/workflows/release.yml",
        headSha: "a".repeat(40),
        ref: "refs/tags/v1.0.0",
        event: "push",
        actor: "maintainer",
        triggeringActor: "maintainer",
      },
      workflows: [
        {
          path: ".github/workflows/release.yml",
          repositoryFullName: "octo/example",
          sha: "a".repeat(40),
          ref: "a".repeat(40),
          role: "entry",
          content: "bounded hostile workflow fixture",
          document: { on: "push", jobs },
          documentComplete: true,
        },
      ],
      artifacts: [{ name: "pkg.tgz", kind: "npm", sha256: "b".repeat(64) }],
      unresolved: [],
    });

    const serialized = stableJson(snapshot);
    expect(utf8Size(serialized)).toBeLessThanOrEqual(MAX_PERSISTED_SNAPSHOT_BYTES);
    expect(snapshot.coverage.complete).toBe(false);
    expect(snapshot.coverage.unresolved).toContainEqual({
      path: "release authority snapshot byte budget",
      reason: "limit_reached",
    });
    expect(snapshot.permissions.length).toBeLessThan(55);
    expect(snapshot.workflows[0]?.authorityDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("marks job identity evidence incomplete instead of persisting a partial list", async () => {
    const jobs = Object.fromEntries(
      Array.from({ length: 257 }, (_, index) => [
        `job-${index}`,
        { "runs-on": "ubuntu-latest", permissions: { contents: "read" } },
      ]),
    );

    const snapshot = await buildReleaseAuthoritySnapshot({
      run: {
        repositoryFullName: "octo/example",
        environment: "pypi",
        runId: 43,
        runAttempt: 1,
        workflowPath: ".github/workflows/release.yml",
        headSha: "a".repeat(40),
        ref: "refs/tags/v1.0.0",
        event: "push",
        actor: "maintainer",
        triggeringActor: "maintainer",
      },
      workflows: [
        {
          path: ".github/workflows/release.yml",
          repositoryFullName: "octo/example",
          sha: "a".repeat(40),
          ref: "a".repeat(40),
          role: "entry",
          content: "bounded job identity fixture",
          document: { on: "push", jobs },
          documentComplete: true,
        },
      ],
      artifacts: [{ name: "pkg.tgz", kind: "npm", sha256: "b".repeat(64) }],
      unresolved: [],
    });

    expect(snapshot.workflows[0]?.jobs).toBeNull();
    expect(snapshot.coverage.complete).toBe(false);
    expect(snapshot.coverage.unresolved).toContainEqual({
      path: ".github/workflows/release.yml jobs (+1 more)",
      reason: "limit_reached",
    });
  });
});
