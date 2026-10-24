import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  npmAttestedPublishers,
  npmProvenanceContinuity,
  readNpmRegistryProvenance,
} from "../server/lib/ecosystems/npm/provenance";
import { projectRegistryMetadata } from "../server/lib/ecosystems/npm/registry";
import {
  classifyPyPiProvenanceResponse,
  combinePyPiFileProvenance,
  pypiProvenanceContinuity,
  readPyPiRegistryProvenance,
} from "../server/lib/ecosystems/pypi/provenance";
import {
  attestedRepositoryFromUrl,
  evaluateProvenanceContinuity,
  provenanceContinuityFindings,
  provenanceLineage,
  type AttestedPublisher,
  type ProvenanceStatus,
  type RegistryProvenance,
} from "../server/lib/provenance-continuity";
import { DETERMINISTIC_RULES_VERSION } from "../server/lib/review/rules";
import { compareParsedSemver, parseSemver } from "../server/lib/ecosystems/semver";
import { RELEASE_PROCESS_FINDING_FILE } from "../server/lib/release-fingerprint";
import { computeScanRiskBreakdown } from "../server/lib/review/risk";
import type { AiReview } from "../server/lib/ai-review/types";
import { annotateFindingsWithDiffStatus } from "../server/lib/review";

const AI_REVIEW_OFF = {
  status: "unavailable",
  risk: "low",
  releaseAssessment: "not_assessed",
  summary: "AI review is disabled.",
  findings: [],
  requiresManualReview: false,
  model: null,
  reviewerVersion: null,
} as unknown as AiReview;

// The real SLSA v1 bundle npm serves for sigstore@3.0.0 (shared with the atpm
// verifier tests).
const SIGSTORE_BUNDLE = JSON.parse(
  readFileSync(new URL("./fixtures/atpm/sigstore-3.0.0.provenance.json", import.meta.url), "utf8"),
) as unknown;

const SIGSTORE_JS: AttestedPublisher = {
  provider: "github",
  repository: "github.com/sigstore/sigstore-js",
  repositoryId: "495574555",
  workflow: ".github/workflows/release.yml",
};

function publisher(overrides: Partial<AttestedPublisher> = {}): AttestedPublisher {
  return {
    provider: "github",
    repository: "github.com/example-org/widget",
    repositoryId: "1001",
    workflow: ".github/workflows/release.yml",
    ...overrides,
  };
}

const present = (...publishers: AttestedPublisher[]): RegistryProvenance => ({
  status: "present",
  publishers,
});
const ABSENT: RegistryProvenance = { status: "absent" };
const UNKNOWN: RegistryProvenance = { status: "unknown" };

// Two attested releases before the baseline: an established attested habit.
const ESTABLISHED: ProvenanceStatus[] = ["present", "present"];

function findings(
  baseline: RegistryProvenance,
  candidate: RegistryProvenance,
  prior: ProvenanceStatus[] = ESTABLISHED,
) {
  return provenanceContinuityFindings({
    registry: "npm",
    baseline: { version: "1.0.0", provenance: baseline },
    candidate: { version: "1.0.1", provenance: candidate },
    prior,
  });
}

function rules(
  baseline: RegistryProvenance,
  candidate: RegistryProvenance,
  prior: ProvenanceStatus[] = ESTABLISHED,
) {
  return findings(baseline, candidate, prior).map((f) => `${f.ruleId}:${f.severity}`);
}

function base64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

describe("provenanceContinuityFindings", () => {
  test("flags a drop from present to affirmatively absent", () => {
    const [finding] = findings(present(publisher()), ABSENT);
    expect(finding).toMatchObject({
      ruleId: "release.provenance-dropped",
      severity: "medium",
      file: RELEASE_PROCESS_FINDING_FILE,
    });
    expect(finding.evidence).toContain("github.com/example-org/widget");
    expect(rules(present(), ABSENT)).toEqual(["release.provenance-dropped:medium"]);
  });

  test("unknown on either side and newly gained provenance are silent", () => {
    expect(rules(present(publisher()), UNKNOWN)).toEqual([]);
    expect(rules(UNKNOWN, ABSENT)).toEqual([]);
    expect(rules(ABSENT, ABSENT)).toEqual([]);
    expect(rules(ABSENT, present(publisher()))).toEqual([]);
  });

  test("a different repository is medium; a stable id outranks the name", () => {
    const lookalike = publisher({ repository: "github.com/examp1e-org/widget", repositoryId: "2" });
    expect(rules(present(publisher()), present(lookalike))).toEqual([
      "release.provenance-publisher-changed:medium",
    ]);
    // Rename or transfer: same id, new name.
    const transferred = publisher({ repository: "github.com/new-owner/widget-js" });
    expect(rules(present(publisher()), present(transferred))).toEqual([]);
    // Re-registered name: same name, new id.
    const reregistered = publisher({ repositoryId: "9999" });
    const [finding] = findings(present(publisher()), present(reregistered));
    expect(finding.severity).toBe("medium");
    expect(finding.evidence).toContain("different repository id");
  });

  test("names compare case-insensitively when an id is missing on either side", () => {
    const upper = publisher({ repository: "github.com/Example-Org/Widget", repositoryId: null });
    expect(rules(present(publisher()), present(upper))).toEqual([]);
  });

  test("a workflow-only change is low and never raises release risk", () => {
    const moved = publisher({ workflow: ".github/workflows/publish.yml" });
    const result = findings(present(publisher()), present(moved));
    expect(result.map((f) => `${f.ruleId}:${f.severity}`)).toEqual([
      "release.provenance-publisher-changed:low",
    ]);
    expect(rules(present(publisher()), present(publisher({ workflow: null })))).toEqual([]);
    expect(rules(present(publisher({ workflow: null })), present(moved))).toEqual([]);
    const annotated = annotateFindingsWithDiffStatus(result, [], {});
    expect(computeScanRiskBreakdown(annotated, AI_REVIEW_OFF).releaseRisk).toBe("low");
  });

  test("release-scoped: a drop lands on the release delta and feeds release risk", () => {
    const annotated = annotateFindingsWithDiffStatus(
      findings(present(publisher()), ABSENT),
      [],
      {},
    );
    expect(annotated[0].releaseDelta).toBe(true);
    expect(computeScanRiskBreakdown(annotated, AI_REVIEW_OFF).releaseRisk).toBe("medium");
  });

  test("identity unreadable on either side compares nothing", () => {
    expect(rules(present(), present(publisher()))).toEqual([]);
    expect(rules(present(publisher()), present())).toEqual([]);
  });

  test("a drop is medium only after three attested releases in a row", () => {
    expect(rules(present(publisher()), ABSENT, ["present", "present", "absent"])).toEqual([
      "release.provenance-dropped:medium",
    ]);
    const short: ProvenanceStatus[][] = [
      [],
      ["present"],
      ["present", "absent"],
      ["unknown", "present"],
    ];
    for (const prior of short) {
      expect(rules(present(publisher()), ABSENT, prior), prior.join(",")).toEqual([
        "release.provenance-dropped:low",
      ]);
    }
    const annotated = annotateFindingsWithDiffStatus(
      findings(present(publisher()), ABSENT, ["present"]),
      [],
      {},
    );
    expect(computeScanRiskBreakdown(annotated, AI_REVIEW_OFF).releaseRisk).toBe("low");
  });

  test("evidence names the release on npm and the checked files on PyPI", () => {
    const [npm] = findings(present(publisher()), ABSENT);
    expect(npm.evidence).toBe(
      "npm reports build provenance for 1.0.0 (github.com/example-org/widget .github/workflows/release.yml) and the 2 releases before it, and none for 1.0.1",
    );
    const [pypi] = provenanceContinuityFindings({
      registry: "PyPI",
      baseline: { version: "1.0.0", provenance: present() },
      candidate: { version: "1.0.1", provenance: ABSENT },
      prior: [],
      absenceScope: "checked-files",
    });
    expect(pypi.evidence).toBe(
      "PyPI reports build provenance for 1.0.0, and none for the checked files of 1.0.1",
    );
  });

  test("findings are tagged and stamped with the ruleset version", () => {
    const all = [
      ...findings(present(publisher()), ABSENT),
      ...findings(present(publisher()), present(publisher({ workflow: "x.yml" }))),
    ];
    expect(all).toHaveLength(2);
    for (const finding of all) expect(finding.ruleVersion).toBe(DETERMINISTIC_RULES_VERSION);
  });

  test("without ids on both sides, a same-owner repository change is low", () => {
    const pypi = (repository: string) =>
      publisher({ repository, repositoryId: null, workflow: "release.yml" });
    const original = present(pypi("github.com/example-org/widget"));
    expect(rules(original, present(pypi("github.com/Example-Org/widget-py")))).toEqual([
      "release.provenance-publisher-changed:low",
    ]);
    expect(rules(original, present(pypi("github.com/examp1e-org/widget")))).toEqual([
      "release.provenance-publisher-changed:medium",
    ]);
    // One new repository under another owner keeps the release medium.
    expect(
      rules(
        original,
        present(pypi("github.com/example-org/widget-py"), pypi("github.com/other/widget")),
      ),
    ).toEqual(["release.provenance-publisher-changed:medium"]);
    // Ids on both sides are authoritative: a different id is a different repository.
    const sibling = publisher({ repository: "github.com/example-org/other", repositoryId: "2" });
    expect(rules(present(publisher()), present(sibling))).toEqual([
      "release.provenance-publisher-changed:medium",
    ]);
  });

  test("an undetermined read on any side or in the history is unsettled", () => {
    const unsettled = (
      baseline: RegistryProvenance,
      candidate: RegistryProvenance,
      prior: ProvenanceStatus[],
    ) =>
      evaluateProvenanceContinuity({
        registry: "npm",
        baseline: { version: "1.0.0", provenance: baseline },
        candidate: { version: "1.0.1", provenance: candidate },
        prior,
      }).unsettled;
    expect(unsettled(present(), ABSENT, ESTABLISHED)).toBe(false);
    expect(unsettled(ABSENT, ABSENT, [])).toBe(false);
    expect(unsettled(UNKNOWN, ABSENT, [])).toBe(true);
    expect(unsettled(present(), UNKNOWN, [])).toBe(true);
    expect(unsettled(present(), ABSENT, ["present", "unknown"])).toBe(true);
  });
});

describe("provenanceLineage", () => {
  const scheme = (times: Record<string, number> = {}) => ({
    parse: parseSemver,
    compare: compareParsedSemver,
    isPrerelease: (v: NonNullable<ReturnType<typeof parseSemver>>) => v.prerelease.length > 0,
    publishedAt: (version: string) => times[version] ?? null,
  });
  const versions = ["1.0.0", "1.1.0", "1.2.0", "2.0.0-rc.1", "2.0.0-rc.2", "2.0.0", "2.1.0-beta.0"];

  test("a stable release is judged against earlier stable releases", () => {
    const expected = { baseline: "1.2.0", prior: ["1.1.0", "1.0.0"] };
    expect(provenanceLineage(scheme(), versions, "2.0.0-rc.2", "2.0.0")).toEqual(expected);
    expect(provenanceLineage(scheme(), versions, "1.2.0", "2.0.0")).toEqual(expected);
  });

  test("a prerelease may follow a release of either channel", () => {
    expect(provenanceLineage(scheme(), versions, "2.0.0-rc.1", "2.0.0-rc.2")).toEqual({
      baseline: "2.0.0-rc.1",
      prior: ["1.2.0", "1.1.0"],
    });
    expect(provenanceLineage(scheme(), versions, "2.0.0", "2.1.0-beta.0")?.prior).toEqual([
      "2.0.0-rc.2",
      "2.0.0-rc.1",
    ]);
  });

  test("a release published after the candidate is not its baseline", () => {
    // 1.2.0 is a maintenance release shipped after 2.0.0.
    const times = {
      "1.0.0": 1,
      "1.1.0": 2,
      "2.0.0-rc.1": 3,
      "2.0.0-rc.2": 4,
      "2.0.0": 5,
      "1.2.0": 6,
    };
    expect(provenanceLineage(scheme(times), versions, "1.2.0", "2.0.0")).toEqual({
      baseline: "1.1.0",
      prior: ["1.0.0"],
    });
  });

  test("reversed, unparseable, and baseline-less pairs are not evaluated", () => {
    expect(provenanceLineage(scheme(), versions, "2.0.0", "1.2.0")).toBeNull();
    expect(provenanceLineage(scheme(), versions, "2.0.0", "2.0.0")).toBeNull();
    expect(provenanceLineage(scheme(), versions, "latest", "2.0.0")).toBeNull();
    expect(provenanceLineage(scheme(), ["1.0.0-rc.1", "1.0.0"], "1.0.0-rc.1", "1.0.0")).toBeNull();
  });
});

describe("npmProvenanceContinuity", () => {
  afterEach(() => vi.unstubAllGlobals());
  const PUBLIC = "https://registry.npmjs.org";
  const packument = (entries: Record<string, boolean | undefined>) => ({
    versions: Object.fromEntries(
      Object.entries(entries).map(([version, hasProvenance]) => [
        version,
        { dist: { tarball: "t" }, ...(hasProvenance === undefined ? {} : { hasProvenance }) },
      ]),
    ) as Record<string, { dist: { tarball: string }; hasProvenance?: boolean }>,
  });
  const run = (metadata: ReturnType<typeof packument>, fromVersion: string, toVersion: string) =>
    npmProvenanceContinuity({
      metadata,
      packageName: "example-widget",
      fromVersion,
      toVersion,
      registryUrl: PUBLIC,
      readProvenance: async (version) =>
        metadata.versions[version]?.hasProvenance ? present(publisher()) : ABSENT,
    });
  const severities = async (...args: Parameters<typeof run>) =>
    (await run(...args)).findings.map((f) => `${f.ruleId}:${f.severity}`);

  test("history comes from the packument's provenance markers", async () => {
    const ci = { "1.0.0": true, "1.0.1": true, "1.0.2": true };
    expect(await severities(packument({ ...ci, "1.0.3": false }), "1.0.2", "1.0.3")).toEqual([
      "release.provenance-dropped:medium",
    ]);
    // A local hotfix after only two CI releases is context.
    const adopting = packument({ "0.9.0": false, "1.0.0": true, "1.0.1": true, "1.0.2": false });
    expect(await severities(adopting, "1.0.1", "1.0.2")).toEqual([
      "release.provenance-dropped:low",
    ]);
  });

  test("a hand-published stable is not compared with its CI-built prerelease", async () => {
    const metadata = packument({
      "1.0.0": false,
      "1.1.0": false,
      "2.0.0-rc.1": true,
      "2.0.0": false,
    });
    expect(await run(metadata, "2.0.0-rc.1", "2.0.0")).toEqual({ findings: [], unsettled: false });
  });

  test("a stale packument is unsettled; a custom registry is not evaluated", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const evaluate = (metadata: ReturnType<typeof packument>, registryUrl: string) =>
      npmProvenanceContinuity({
        metadata,
        packageName: "example-widget",
        fromVersion: "1.0.0",
        toVersion: "1.0.1",
        registryUrl,
      });
    expect(await evaluate(packument({ "1.0.0": undefined, "1.0.1": undefined }), PUBLIC)).toEqual({
      findings: [],
      unsettled: true,
    });
    expect(
      await evaluate(packument({ "1.0.0": true, "1.0.1": false }), "http://127.0.0.1:4873"),
    ).toEqual({ findings: [], unsettled: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("pypiProvenanceContinuity", () => {
  const release = (version: string, uploaded: string) => [
    {
      filename: `example_sdk-${version}.tar.gz`,
      packagetype: "sdist",
      upload_time_iso_8601: uploaded,
    },
  ];
  const metadata = {
    info: { name: "example-sdk" },
    releases: {
      "1.0.0": release("1.0.0", "2026-01-01T00:00:00Z"),
      "1.1.0": release("1.1.0", "2026-02-01T00:00:00Z"),
      "1.2.0": release("1.2.0", "2026-03-01T00:00:00Z"),
      "2.0.0rc1": release("2.0.0rc1", "2026-04-01T00:00:00Z"),
      "2.0.0": release("2.0.0", "2026-05-01T00:00:00Z"),
    },
  };
  const evaluate = (fromVersion: string, attested: Set<string>, reads: string[]) =>
    pypiProvenanceContinuity({
      metadata,
      projectName: "example-sdk",
      fromVersion,
      toVersion: "2.0.0",
      fromFilenames: [`example_sdk-${fromVersion}.tar.gz`],
      toFilenames: ["example_sdk-2.0.0.tar.gz"],
      readProvenance: async (version, filenames) => {
        reads.push(`${version}:${filenames.join(",")}`);
        return attested.has(version) ? present() : ABSENT;
      },
    });

  test("reads history only for a drop, one representative file per release", async () => {
    const reads: string[] = [];
    const outcome = await evaluate("1.2.0", new Set(["1.0.0", "1.1.0", "1.2.0"]), reads);
    expect(outcome.findings.map((f) => `${f.ruleId}:${f.severity}`)).toEqual([
      "release.provenance-dropped:medium",
    ]);
    expect(reads.sort()).toEqual([
      "1.0.0:example_sdk-1.0.0.tar.gz",
      "1.1.0:example_sdk-1.1.0.tar.gz",
      "1.2.0:example_sdk-1.2.0.tar.gz",
      "2.0.0:example_sdk-2.0.0.tar.gz",
    ]);
    const quiet: string[] = [];
    await evaluate("1.2.0", new Set(["1.2.0", "2.0.0"]), quiet);
    expect(quiet).toHaveLength(2);
  });

  test("a stable after a CI-built rc is compared with the previous stable", async () => {
    const reads: string[] = [];
    const outcome = await evaluate("2.0.0rc1", new Set(["2.0.0rc1"]), reads);
    expect(outcome).toEqual({ findings: [], unsettled: false });
    expect(reads.sort()).toEqual([
      "1.2.0:example_sdk-1.2.0.tar.gz",
      "2.0.0:example_sdk-2.0.0.tar.gz",
    ]);
  });
});

describe("attestedRepositoryFromUrl", () => {
  test("normalizes npm's repository spellings", () => {
    expect(attestedRepositoryFromUrl("https://github.com/sigstore/sigstore-js")).toBe(
      "github.com/sigstore/sigstore-js",
    );
    expect(
      attestedRepositoryFromUrl("git+https://github.com/sigstore/sigstore-js@refs/heads/main"),
    ).toBe("github.com/sigstore/sigstore-js");
    expect(attestedRepositoryFromUrl("git+https://gitlab.com/group/sub/project")).toBe(
      "gitlab.com/group/sub/project",
    );
  });

  test("rejects anything that is not a plain https repository URL", () => {
    for (const value of [
      "http://github.com/a/b",
      "https://user:pw@github.com/a/b",
      "https://github.com/a",
      "https://github.com/a/b?x=1",
      "https://github.com/a/b\nforged",
      "https://github.com/a/b\u202Eforged",
      "https://github.com/a/b\u200Bc",
      "https://github.com/a/b\u0085c",
      `https://github.com/a/${"b".repeat(300)}`,
      "not a url",
      42,
      null,
    ]) {
      expect(attestedRepositoryFromUrl(value), String(value)).toBeNull();
    }
  });
});

describe("npmAttestedPublishers", () => {
  test("reads the real sigstore@3.0.0 SLSA v1 statement", () => {
    const document = {
      attestations: [{ predicateType: "https://slsa.dev/provenance/v1", bundle: SIGSTORE_BUNDLE }],
    };
    expect(npmAttestedPublishers(document, "sigstore", "3.0.0")).toEqual([SIGSTORE_JS]);
    // The record must be about this release.
    expect(npmAttestedPublishers(document, "sigstore", "3.0.1")).toEqual([]);
    expect(npmAttestedPublishers(document, "other", "3.0.0")).toEqual([]);
  });

  test("reads SLSA v0.2 GitHub and GitLab statements", () => {
    const wrap = (predicate: unknown, name = "@scope/pkg", version = "1.0.0") => ({
      attestations: [
        {
          predicateType: "https://slsa.dev/provenance/v0.2",
          bundle: {
            dsseEnvelope: {
              payloadType: "application/vnd.in-toto+json",
              payload: base64Json({
                _type: "https://in-toto.io/Statement/v0.1",
                subject: [{ name: `pkg:npm/${name.replace("@", "%40")}@${version}` }],
                predicateType: "https://slsa.dev/provenance/v0.2",
                predicate,
              }),
            },
          },
        },
      ],
    });
    expect(
      npmAttestedPublishers(
        wrap({
          buildType: "https://github.com/npm/cli/gha/v2",
          invocation: {
            configSource: {
              uri: "git+https://github.com/sigstore/sigstore-js@refs/heads/main",
              entryPoint: ".github/workflows/release.yml",
            },
            environment: { GITHUB_REPOSITORY_ID: "495574555" },
          },
        }),
        "@scope/pkg",
        "1.0.0",
      ),
    ).toEqual([SIGSTORE_JS]);
    expect(
      npmAttestedPublishers(
        wrap({
          buildType: "https://github.com/npm/cli/gitlab/v0alpha1",
          invocation: {
            configSource: { uri: "git+https://gitlab.com/group/project", entryPoint: "publish" },
            parameters: { CI_CONFIG_PATH: ".gitlab-ci.yml", CI_PROJECT_ID: "77" },
          },
        }),
        "@scope/pkg",
        "1.0.0",
      ),
    ).toEqual([
      {
        provider: "gitlab",
        repository: "gitlab.com/group/project",
        repositoryId: "77",
        workflow: ".gitlab-ci.yml",
      },
    ]);
    expect(
      npmAttestedPublishers(
        wrap({ buildType: "https://example.invalid/custom" }),
        "@scope/pkg",
        "1.0.0",
      ),
    ).toEqual([]);
  });

  test("malformed documents read as no identity instead of throwing", () => {
    const deep = "[".repeat(100_000) + "]".repeat(100_000);
    const documents: unknown[] = [
      null,
      "text",
      { attestations: {} },
      { attestations: [null, 1, { predicateType: "https://slsa.dev/provenance/v1" }] },
      {
        attestations: [
          {
            predicateType: "https://slsa.dev/provenance/v1",
            bundle: {
              dsseEnvelope: { payloadType: "application/vnd.in-toto+json", payload: "!!" },
            },
          },
        ],
      },
      {
        attestations: [
          {
            predicateType: "https://slsa.dev/provenance/v1",
            bundle: {
              dsseEnvelope: {
                payloadType: "application/vnd.in-toto+json",
                payload: Buffer.from(deep).toString("base64"),
              },
            },
          },
        ],
      },
    ];
    for (const document of documents) {
      expect(npmAttestedPublishers(document, "sigstore", "3.0.0")).toEqual([]);
    }
  });
});

describe("projectRegistryMetadata provenance marker", () => {
  test("keeps npm's registry-written provenance marker per version", () => {
    const projected = projectRegistryMetadata({
      versions: {
        "1.0.0": { dist: { tarball: "t1" } },
        "1.0.1": {
          dist: {
            tarball: "t2",
            attestations: {
              url: "u",
              provenance: { predicateType: "https://slsa.dev/provenance/v1" },
            },
          },
        },
        "1.0.2": { dist: { tarball: "t3", attestations: { url: "u" } } },
        "1.0.3": {},
      },
    });
    expect(projected.versions?.["1.0.0"]?.hasProvenance).toBe(false);
    expect(projected.versions?.["1.0.1"]?.hasProvenance).toBe(true);
    expect(projected.versions?.["1.0.2"]?.hasProvenance).toBe(false);
    expect(projected.versions?.["1.0.3"]?.hasProvenance).toBeUndefined();
  });
});

describe("readNpmRegistryProvenance", () => {
  afterEach(() => vi.unstubAllGlobals());

  const metadata = {
    versions: {
      "3.0.0": { dist: { tarball: "t" }, hasProvenance: true },
      "3.0.1": { dist: { tarball: "t" }, hasProvenance: false },
      "3.0.2": { dist: { tarball: "t" } },
    },
  };
  const PUBLIC = "https://registry.npmjs.org";

  test("answers absent and unknown from the packument without a fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(readNpmRegistryProvenance(metadata, "sigstore", "3.0.1", PUBLIC)).resolves.toEqual(
      { status: "absent" },
    );
    await expect(readNpmRegistryProvenance(metadata, "sigstore", "3.0.2", PUBLIC)).resolves.toEqual(
      { status: "unknown" },
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a custom registry is unknown and never contacted", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const version of ["3.0.0", "3.0.1"]) {
      await expect(
        readNpmRegistryProvenance(metadata, "sigstore", version, "http://127.0.0.1:4873"),
      ).resolves.toEqual({ status: "unknown" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("reads identity from the public attestations endpoint without credentials", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            attestations: [
              { predicateType: "https://slsa.dev/provenance/v1", bundle: SIGSTORE_BUNDLE },
            ],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      readNpmRegistryProvenance(metadata, "sigstore", "3.0.0", `${PUBLIC}/`),
    ).resolves.toEqual({ status: "present", publishers: [SIGSTORE_JS] });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://registry.npmjs.org/-/npm/v1/attestations/sigstore@3.0.0");
    expect(new Headers(init.headers).has("authorization")).toBe(false);
    expect(init.redirect).toBe("manual");
  });

  test("an unreadable attestations response keeps presence but no identity", async () => {
    const responses = [
      () => new Response("nope", { status: 500 }),
      () => new Response(null, { status: 302, headers: { location: "https://example.invalid" } }),
      () => new Response("x".repeat(300 * 1024), { status: 200 }),
      () => {
        throw new TypeError("network down");
      },
    ];
    for (const respond of responses) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => respond()),
      );
      await expect(
        readNpmRegistryProvenance(metadata, "sigstore", "3.0.0", PUBLIC),
      ).resolves.toEqual({ status: "present", publishers: [] });
    }
  });
});

describe("PyPI provenance", () => {
  afterEach(() => vi.unstubAllGlobals());

  const attested = (repository: unknown, kind = "GitHub") => ({
    version: 1,
    attestation_bundles: [
      {
        publisher: { kind, repository, workflow: "publish.yml", environment: "publish" },
        attestations: [],
      },
    ],
  });

  test("reads PyPI's publisher record", () => {
    expect(classifyPyPiProvenanceResponse(200, attested("urllib3/urllib3"), "f.tar.gz")).toEqual({
      status: "present",
      publishers: [
        {
          provider: "github",
          repository: "github.com/urllib3/urllib3",
          repositoryId: null,
          workflow: "publish.yml",
        },
      ],
    });
    // GitLab names its config file, Google names no repository.
    expect(
      classifyPyPiProvenanceResponse(
        200,
        {
          version: 1,
          attestation_bundles: [
            {
              publisher: {
                kind: "GitLab",
                repository: "g/s/p",
                workflow_filepath: ".gitlab-ci.yml",
              },
            },
            { publisher: { kind: "Google", email: "svc@example.invalid" } },
          ],
        },
        "f.tar.gz",
      ),
    ).toEqual({
      status: "present",
      publishers: [
        {
          provider: "gitlab",
          repository: "gitlab.com/g/s/p",
          repositoryId: null,
          workflow: ".gitlab-ci.yml",
        },
      ],
    });
  });

  test("only PyPI's own JSON 404 is absence", () => {
    expect(
      classifyPyPiProvenanceResponse(
        404,
        { message: "No provenance available for f-1.tar.gz" },
        "f-1.tar.gz",
      ),
    ).toEqual({ status: "absent" });
    expect(
      classifyPyPiProvenanceResponse(
        404,
        { message: "No provenance available for other" },
        "f-1.tar.gz",
      ),
    ).toEqual({ status: "unknown" });
    expect(classifyPyPiProvenanceResponse(404, null, "f-1.tar.gz")).toEqual({ status: "unknown" });
    expect(classifyPyPiProvenanceResponse(403, null, "f-1.tar.gz")).toEqual({ status: "unknown" });
    expect(classifyPyPiProvenanceResponse(500, null, "f-1.tar.gz")).toEqual({ status: "unknown" });
  });

  test("malformed 200 bodies and slugs keep presence without identity", () => {
    for (const body of [null, {}, { version: 2, attestation_bundles: [] }, attested("../etc")]) {
      expect(classifyPyPiProvenanceResponse(200, body, "f")).toEqual({
        status: "present",
        publishers: [],
      });
    }
    expect(classifyPyPiProvenanceResponse(200, attested("a/b\u0000c"), "f")).toEqual({
      status: "present",
      publishers: [],
    });
  });

  test("a release is absent only when every checked file is", () => {
    const absent = { status: "absent" } as const;
    const unknown = { status: "unknown" } as const;
    const withPublisher = classifyPyPiProvenanceResponse(200, attested("o/r"), "f");
    expect(combinePyPiFileProvenance([absent, absent])).toEqual({ status: "absent" });
    expect(combinePyPiFileProvenance([absent, unknown])).toEqual({ status: "unknown" });
    expect(combinePyPiFileProvenance([])).toEqual({ status: "unknown" });
    expect(combinePyPiFileProvenance([absent, withPublisher, withPublisher])).toEqual(
      withPublisher,
    );
  });

  test("queries the integrity API per selected file with PyPI's media type", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(".whl/provenance")) {
        return new Response("<!DOCTYPE html><title>Page Not Found (404)</title>", { status: 404 });
      }
      return new Response(JSON.stringify(attested("example-org/example-sdk")), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await readPyPiRegistryProvenance("Example_SDK", "2.0.0", [
      "example_sdk-2.0.0.tar.gz",
      "example_sdk-2.0.0-py3-none-any.whl",
    ]);
    expect(result).toMatchObject({ status: "present" });
    const urls = fetchMock.mock.calls.map(([input]) => String(input)).sort();
    expect(urls).toEqual([
      "https://pypi.org/integrity/example-sdk/2.0.0/example_sdk-2.0.0-py3-none-any.whl/provenance",
      "https://pypi.org/integrity/example-sdk/2.0.0/example_sdk-2.0.0.tar.gz/provenance",
    ]);
    const init = fetchMock.mock.calls[0][1];
    expect(new Headers(init?.headers).get("accept")).toBe("application/vnd.pypi.integrity.v1+json");
  });

  test("a malformed filename from metadata is unknown, not a failed diff", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(readPyPiRegistryProvenance("p", "1.0", ["p-\uD800.tar.gz"])).resolves.toEqual({
      status: "unknown",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a network failure is unknown, never absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      }),
    );
    await expect(readPyPiRegistryProvenance("p", "1.0", ["p-1.0.tar.gz"])).resolves.toEqual({
      status: "unknown",
    });
  });
});
