import { describe, expect, test } from "vitest";
import type { PublicPackageDiff } from "../server/lib/public-diff";
import {
  concludeDependencyReview,
  evaluateBumpEvidence,
  extractBumpEvidence,
  newPackageVerdict,
  parseDependencyReviewPolicy,
  unreviewedVerdict,
} from "../server/lib/dependency-review/policy";
import {
  collectCustomRegistries,
  emptyCustomRegistries,
  isPublicNpmName,
} from "../server/lib/dependency-review/registry-config";
import {
  code,
  listsEveryHold,
  renderDependencyReviewCheck,
} from "../server/lib/dependency-review/render";
import {
  DEFAULT_DEPENDENCY_REVIEW_POLICY,
  type BumpEvidence,
  type DependencyBump,
  type ReviewedBump,
} from "../server/lib/dependency-review/types";
import {
  isDependencyBot,
  parseCheckRunEvent,
  parsePullRequestEvent,
} from "../server/lib/dependency-review/webhook";

function diffWith(overrides: Partial<PublicPackageDiff>): PublicPackageDiff {
  return {
    ecosystem: "npm",
    packageName: "left-pad",
    fromVersion: "1.0.0",
    toVersion: "1.0.1",
    fromPackageJson: null,
    toPackageJson: null,
    fromFiles: [],
    toFiles: [],
    diff: [],
    packageJsonDiff: {
      name: "left-pad",
      hasPreviousManifest: true,
      previousVersion: "1.0.0",
      stagedVersion: "1.0.1",
      scripts: [],
      dependencies: [],
      bin: [],
      entrypointsChanged: false,
    },
    findings: [],
    risk: {
      artifactRisk: "low",
      releaseRisk: "low",
      contextRisk: "low",
      releaseFindingCount: 0,
      contextFindingCount: 0,
      unknownFindingCount: 0,
      priorApprovedContextFindingCount: 0,
    },
    cachedAt: "2026-10-24T00:00:00.000Z",
    ...overrides,
  };
}

const CLEAN: BumpEvidence = extractBumpEvidence(
  diffWith({ diff: [{ path: "index.js", status: "modified", flags: [] }] }),
);

const bump = (overrides: Partial<DependencyBump> = {}): DependencyBump => ({
  ecosystem: "npm",
  name: "left-pad",
  fromVersion: "1.0.0",
  toVersion: "1.0.1",
  direct: true,
  lockfilePath: "package-lock.json",
  ...overrides,
});

describe("extractBumpEvidence", () => {
  test("counts install hooks, native files, new dependencies, and bin commands", () => {
    const evidence = extractBumpEvidence(
      diffWith({
        diff: [
          { path: "build/addon.node", status: "added", flags: ["binary"] },
          { path: "lib/payload", status: "added", flags: ["binary", "native-elf"] },
          { path: "index.js", status: "modified", flags: [] },
          { path: "old.js", status: "removed", flags: [] },
        ],
        packageJsonDiff: {
          ...diffWith({}).packageJsonDiff,
          scripts: [
            { key: "postinstall", status: "added", staged: "node x.js" },
            { key: "preinstall", status: "modified", previous: "a", staged: "b" },
            { key: "test", status: "added", staged: "vitest" },
          ],
          dependencies: [
            { key: "evil", status: "added", staged: "^1.0.0" },
            { key: "moved", status: "added", staged: "^1.0.0", previouslyDeclared: true },
          ],
          bin: [{ key: "lp", status: "added", staged: "cli.js" }],
        },
      }),
    );
    expect(evidence).toMatchObject({
      filesAdded: 2,
      filesRemoved: 1,
      filesChanged: 1,
      installScriptsAdded: 1,
      installScriptsChanged: 1,
      nativeBinariesAdded: 2,
      dependenciesAdded: 1,
      binCommandsAdded: 1,
      // A sniffed native binary is its own reason, not also an uninspected file.
      uninspectedFiles: 0,
    });
  });

  test("treats minified code, skipped bodies, and unknown binaries as uninspected, not images or maps", () => {
    const evidence = extractBumpEvidence(
      diffWith({
        diff: [
          { path: "dist/app.min.js", status: "modified", flags: ["text-sample-skipped"] },
          { path: "dist/app.js.map", status: "modified", flags: ["text-sample-skipped"] },
          { path: "vendor/huge.js", status: "added", flags: ["content-skipped"] },
          { path: "assets/logo.png", status: "added", flags: ["binary"] },
          { path: "payload.bin", status: "added", flags: ["binary"] },
          { path: "unchanged.min.js", status: "unchanged", flags: ["text-sample-skipped"] },
        ],
      }),
    );
    expect(evidence.uninspectedFiles).toBe(3);
  });

  test("a coverage notice from the diff holds like an uninspected file", () => {
    const evidence = extractBumpEvidence(
      diffWith({ notices: ["2 other wheels of 1.0.1 were not inspected."] }),
    );
    expect(evidence.coverageNotices).toBe(1);
    expect(evaluateBumpEvidence(evidence, DEFAULT_DEPENDENCY_REVIEW_POLICY)).toMatchObject({
      status: "hold",
      reasons: ["uninspected-files"],
    });
    expect(
      evaluateBumpEvidence(evidence, {
        ...DEFAULT_DEPENDENCY_REVIEW_POLICY,
        holdOnUninspectedFiles: false,
      }).status,
    ).toBe("clear");
  });

  test("keeps only release-delta findings, most severe first", () => {
    const finding = (severity: "low" | "high" | "critical", releaseDelta: boolean) => ({
      severity,
      file: "index.js",
      evidence: "",
      reason: `${severity} reason`,
      ruleId: `rule.${severity}`,
      diffStatus: "modified" as const,
      releaseDelta,
    });
    const evidence = extractBumpEvidence(
      diffWith({
        findings: [finding("low", true), finding("critical", true), finding("high", false)],
      }),
    );
    expect(evidence.findings.map((f) => f.severity)).toEqual(["critical", "low"]);
    expect(evidence.findingCount).toBe(2);
  });
});

describe("evaluateBumpEvidence", () => {
  test("a clean bump is clear", () => {
    expect(evaluateBumpEvidence(CLEAN, DEFAULT_DEPENDENCY_REVIEW_POLICY).status).toBe("clear");
  });

  test("holds at or above the release-risk threshold only", () => {
    const policy = { ...DEFAULT_DEPENDENCY_REVIEW_POLICY, holdAtReleaseRisk: "high" as const };
    expect(evaluateBumpEvidence({ ...CLEAN, releaseRisk: "medium" }, policy).status).toBe("clear");
    expect(evaluateBumpEvidence({ ...CLEAN, releaseRisk: "high" }, policy)).toMatchObject({
      status: "hold",
      reasons: ["release-risk"],
    });
    expect(evaluateBumpEvidence({ ...CLEAN, releaseRisk: "critical" }, policy).status).toBe("hold");
    expect(
      evaluateBumpEvidence(
        { ...CLEAN, releaseRisk: "critical" },
        { ...policy, holdAtReleaseRisk: null },
      ).status,
    ).toBe("clear");
  });

  test("each capability switch holds and releases independently", () => {
    const evidence = {
      ...CLEAN,
      installScriptsAdded: 1,
      nativeBinariesAdded: 1,
      dependenciesAdded: 1,
      binCommandsAdded: 1,
      uninspectedFiles: 1,
    };
    expect(evaluateBumpEvidence(evidence, DEFAULT_DEPENDENCY_REVIEW_POLICY)).toMatchObject({
      status: "hold",
      reasons: [
        "install-script-added",
        "native-binary-added",
        "dependency-added",
        "bin-command-added",
        "uninspected-files",
      ],
    });
    const allOff = {
      ...DEFAULT_DEPENDENCY_REVIEW_POLICY,
      holdOnInstallScripts: false,
      holdOnNativeBinaries: false,
      holdOnNewDependencies: false,
      holdOnNewBinCommands: false,
      holdOnUninspectedFiles: false,
    };
    expect(evaluateBumpEvidence(evidence, allOff).status).toBe("clear");
  });

  test("unreviewed and new packages hold only when the policy says so", () => {
    expect(unreviewedVerdict("over-cap", DEFAULT_DEPENDENCY_REVIEW_POLICY)).toMatchObject({
      status: "hold",
      reasons: ["unreviewed"],
      unreviewed: "over-cap",
    });
    expect(
      unreviewedVerdict("not-found", {
        ...DEFAULT_DEPENDENCY_REVIEW_POLICY,
        holdOnUnreviewed: false,
      }),
    ).toEqual({ status: "unreviewed", unreviewed: "not-found" });
    expect(newPackageVerdict(DEFAULT_DEPENDENCY_REVIEW_POLICY)).toEqual({ status: "new-package" });
    expect(
      newPackageVerdict({ ...DEFAULT_DEPENDENCY_REVIEW_POLICY, holdOnNewPackages: true }).status,
    ).toBe("hold");
  });
});

describe("concludeDependencyReview", () => {
  const clear: ReviewedBump = {
    bump: bump(),
    verdict: { status: "clear", evidence: CLEAN },
    approved: false,
  };
  const held: ReviewedBump = {
    bump: bump({ name: "evil" }),
    verdict: { status: "hold", reasons: ["install-script-added"], evidence: CLEAN },
    approved: false,
  };

  test("any unapproved hold blocks; all holds approved reads as approved", () => {
    expect(concludeDependencyReview([])).toBe("clear");
    expect(concludeDependencyReview([clear])).toBe("clear");
    expect(concludeDependencyReview([clear, held])).toBe("held");
    expect(concludeDependencyReview([clear, { ...held, approved: true }])).toBe("approved");
  });
});

describe("parseDependencyReviewPolicy", () => {
  test("falls back per field, so a bad row holds more, never less", () => {
    expect(parseDependencyReviewPolicy(null)).toEqual(DEFAULT_DEPENDENCY_REVIEW_POLICY);
    expect(
      parseDependencyReviewPolicy({
        holdOnInstallScripts: "no",
        holdOnNewPackages: true,
        holdAtReleaseRisk: "extreme",
      }),
    ).toEqual({ ...DEFAULT_DEPENDENCY_REVIEW_POLICY, holdOnNewPackages: true });
    expect(parseDependencyReviewPolicy({ holdAtReleaseRisk: null }).holdAtReleaseRisk).toBeNull();
  });
});

describe("renderDependencyReviewCheck", () => {
  const diffUrl = (b: DependencyBump) =>
    `https://drydock.example/diff/${b.name}/${b.fromVersion}/${b.toVersion}`;

  test("hostile names, paths, and reasons stay inside code spans", () => {
    const hostile: ReviewedBump = {
      bump: bump({ name: "@x/y`](https://evil)", toVersion: "1.0.1" }),
      verdict: {
        status: "hold",
        reasons: ["release-risk"],
        evidence: {
          ...CLEAN,
          releaseRisk: "high",
          findings: [
            {
              severity: "high",
              ruleId: "exfil.network",
              file: "a\u202eb.js",
              reason: "@octocat ![img](https://evil/x.png) ``` <script>",
            },
          ],
          findingCount: 1,
        },
      },
      approved: false,
    };
    const { summary, title } = renderDependencyReviewCheck({
      bumps: [hostile],
      conclusion: "held",
      diffUrl,
      approvedBy: null,
      unreadLockfiles: [],
    });
    expect(title).toBe("1 of 1 update held for review");
    expect(summary).not.toContain("\u202e");
    expect(summary).toContain("````@octocat ![img](https://evil/x.png) ``` <script>````");
    expect(summary).toContain("``@x/y`](https://evil)``");
  });

  test("Approve is only possible when the check shows every hold in full", () => {
    const hold = (name: string, reason = "x"): ReviewedBump => ({
      bump: bump({ name }),
      verdict: {
        status: "hold",
        reasons: ["release-risk"],
        evidence: {
          ...CLEAN,
          findingCount: 3,
          findings: Array.from({ length: 3 }, () => ({
            ruleId: "r",
            severity: "high" as const,
            file: "f".repeat(120),
            reason,
          })),
        },
      },
      approved: false,
    });
    const input = (bumps: ReviewedBump[]) => ({
      bumps,
      conclusion: "held" as const,
      diffUrl,
      approvedBy: null,
      unreadLockfiles: [],
    });
    expect(listsEveryHold(input([hold("a"), hold("b")]))).toBe(true);
    const many = Array.from({ length: 101 }, (_, i) => hold(`p${i}`));
    expect(listsEveryHold(input(many))).toBe(false);
    // Fewer than 100, but long enough that the summary would be cut.
    const long = Array.from({ length: 80 }, (_, i) => hold(`p${i}`, "r".repeat(400)));
    expect(listsEveryHold(input(long))).toBe(false);
    // The unread lockfiles render beside the holds, before the long lists.
    const clear: ReviewedBump = {
      bump: bump({ name: "c" }),
      verdict: { status: "clear", evidence: CLEAN },
      approved: false,
    };
    const { summary } = renderDependencyReviewCheck({
      ...input([hold("a"), clear]),
      unreadLockfiles: ["bun.lock"],
    });
    expect(summary.indexOf("`bun.lock`")).toBeLessThan(summary.indexOf("### Clear"));
    expect(renderDependencyReviewCheck({ ...input(many), approvable: false }).summary).toContain(
      "can't be approved here",
    );
  });

  test("titles state the outcome", () => {
    const clear: ReviewedBump = {
      bump: bump(),
      verdict: { status: "clear", evidence: CLEAN },
      approved: false,
    };
    const render = (bumps: ReviewedBump[], conclusion: "clear" | "held" | "approved") =>
      renderDependencyReviewCheck({
        bumps,
        conclusion,
        diffUrl,
        approvedBy: "octocat",
        unreadLockfiles: [],
      });
    expect(render([], "clear").title).toBe("No reviewable package updates");
    expect(render([clear], "clear").title).toBe("Update clear");
    expect(render([clear, clear], "clear").title).toBe("All 2 updates clear");
    // A bump passing without a diff read (policy off, or a new package) is not "clear".
    const unread: ReviewedBump = {
      bump: bump(),
      verdict: { status: "unreviewed", unreviewed: "private-source" },
      approved: false,
    };
    expect(render([clear, unread], "clear").title).toBe("No updates held");
    const approved = render(
      [
        {
          ...clear,
          verdict: { status: "hold", reasons: ["dependency-added"], evidence: CLEAN },
          approved: true,
        },
      ],
      "approved",
    );
    expect(approved.title).toBe("Held updates approved");
    expect(approved.summary).toContain("Approved by `octocat`");
  });

  test("new packages and transitive bumps are labeled, and new packages get no diff link", () => {
    const { summary } = renderDependencyReviewCheck({
      bumps: [
        {
          bump: bump({ fromVersion: null, name: "fresh" }),
          verdict: { status: "new-package" },
          approved: false,
        },
        {
          bump: bump({ direct: false }),
          verdict: { status: "clear", evidence: CLEAN },
          approved: false,
        },
      ],
      conclusion: "clear",
      diffUrl,
      approvedBy: null,
      unreadLockfiles: ["bun.lock"],
    });
    expect(summary).toContain("`fresh` `1.0.1`");
    expect(summary).not.toContain("/diff/fresh");
    expect(summary).toContain("(transitive)");
    expect(summary).toContain("`bun.lock`");
  });

  test("a review held only for an unread lockfile says so instead of counting zero holds", () => {
    const { title } = renderDependencyReviewCheck({
      bumps: [],
      conclusion: "held",
      diffUrl,
      approvedBy: null,
      unreadLockfiles: ["pnpm-lock.yaml"],
    });
    expect(title).toBe("Held: some updates could not be read");
  });

  test("output stays under GitHub's field limit", () => {
    const many: ReviewedBump[] = Array.from({ length: 2000 }, (_, i) => ({
      bump: bump({ name: `pkg-${i}-${"x".repeat(150)}` }),
      verdict: {
        status: "hold",
        reasons: ["release-risk"],
        evidence: {
          ...CLEAN,
          findings: Array.from({ length: 3 }, () => ({
            severity: "high" as const,
            ruleId: "r",
            file: "f".repeat(200),
            reason: "r".repeat(300),
          })),
          findingCount: 3,
        },
      },
      approved: false,
    }));
    const { summary } = renderDependencyReviewCheck({
      bumps: many,
      conclusion: "held",
      diffUrl,
      approvedBy: null,
      unreadLockfiles: [],
    });
    expect(summary.length).toBeLessThan(65_535);
  });

  test("code() pads a value that starts with a backtick and replaces empty text", () => {
    expect(code("`x", 10)).toBe("`` `x ``");
    expect(code("\u200b", 10)).toBe("`-`");
    expect(code("abcdef", 4)).toBe("`abc…`");
  });
});

describe("registry config", () => {
  test("a custom scope drops only that scope; a custom default drops every name", () => {
    const scoped = collectCustomRegistries(emptyCustomRegistries(), {
      npmrc: "@acme:registry=https://npm.acme.dev/\nregistry=https://registry.npmjs.org/",
      yarnrc: null,
    });
    expect(isPublicNpmName(scoped, "@acme/internal")).toBe(false);
    expect(isPublicNpmName(scoped, "left-pad")).toBe(true);

    const all = collectCustomRegistries(emptyCustomRegistries(), {
      npmrc: null,
      yarnrc: 'npmRegistryServer: "https://mirror.internal"',
    });
    expect(isPublicNpmName(all, "left-pad")).toBe(false);
  });

  test("yarn npmScopes block and flow-style scopes", () => {
    const block = collectCustomRegistries(emptyCustomRegistries(), {
      npmrc: null,
      yarnrc:
        "npmScopes:\n  acme:\n    npmRegistryServer: https://npm.acme.dev\n  pub:\n    npmRegistryServer: https://registry.yarnpkg.com\n",
    });
    expect(isPublicNpmName(block, "@acme/a")).toBe(false);
    expect(isPublicNpmName(block, "@pub/a")).toBe(true);
    const flow = collectCustomRegistries(emptyCustomRegistries(), {
      npmrc: null,
      yarnrc: "npmScopes: { acme: { npmRegistryServer: x } }",
    });
    expect(isPublicNpmName(flow, "left-pad")).toBe(false);
  });
});

describe("webhook parsing", () => {
  const sha = "a".repeat(40);
  const prPayload = (overrides: Record<string, unknown> = {}) => ({
    action: "opened",
    installation: { id: 42 },
    repository: { id: 7, full_name: "octo/app" },
    pull_request: {
      number: 3,
      head: { sha, repo: { id: 7 } },
      user: { login: "dependabot[bot]", type: "Bot" },
    },
    sender: { login: "dependabot[bot]" },
    ...overrides,
  });

  test("pull_request carries what the review needs", () => {
    expect(parsePullRequestEvent(prPayload())).toEqual({
      kind: "pull_request",
      action: "opened",
      installationId: "42",
      repositoryId: 7,
      repositoryFullName: "octo/app",
      pullNumber: 3,
      headSha: sha,
      authorLogin: "dependabot[bot]",
      authorType: "Bot",
      senderLogin: "dependabot[bot]",
      headRepositoryId: 7,
    });
    expect(parsePullRequestEvent(prPayload({ action: "closed" }))).toEqual({
      error: "unsupported_action",
    });
    expect(
      parsePullRequestEvent(
        prPayload({ pull_request: { number: 3, head: { sha: "nope" }, user: {} } }),
      ),
    ).toEqual({ error: "missing_pull_request" });
  });

  test("check_run requested_action keeps the sender and identifier", () => {
    expect(
      parseCheckRunEvent({
        action: "requested_action",
        installation: { id: 42 },
        repository: { id: 7 },
        check_run: { id: 99, head_sha: sha, app: { id: 12345 } },
        requested_action: { identifier: "approve-holds" },
        sender: { login: "octocat", id: 1 },
      }),
    ).toMatchObject({
      kind: "check_run",
      checkRunId: 99,
      appId: "12345",
      identifier: "approve-holds",
      senderLogin: "octocat",
      senderId: 1,
    });
  });

  test("only real bot accounts and listed logins count as dependency bots", () => {
    expect(isDependencyBot("dependabot[bot]", "Bot", [])).toBe(true);
    expect(isDependencyBot("Renovate[bot]", "Bot", [])).toBe(true);
    expect(isDependencyBot("dependabot[bot]", "User", [])).toBe(false);
    expect(isDependencyBot("octocat", "User", [])).toBe(false);
    expect(isDependencyBot("acme-renovate", "User", ["acme-renovate"])).toBe(true);
  });
});
