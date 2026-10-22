import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  npmAttestedPublishers,
  readNpmRegistryProvenance,
} from "../server/lib/ecosystems/npm/provenance";
import { projectRegistryMetadata } from "../server/lib/ecosystems/npm/registry";
import {
  classifyPyPiProvenanceResponse,
  combinePyPiFileProvenance,
  readPyPiRegistryProvenance,
} from "../server/lib/ecosystems/pypi/provenance";
import {
  attestedRepositoryFromUrl,
  provenanceContinuityFindings,
  type AttestedPublisher,
  type RegistryProvenance,
} from "../server/lib/provenance-continuity";
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

function findings(baseline: RegistryProvenance, candidate: RegistryProvenance) {
  return provenanceContinuityFindings({
    registry: "npm",
    baseline: { version: "1.0.0", provenance: baseline },
    candidate: { version: "1.0.1", provenance: candidate },
  });
}

function rules(baseline: RegistryProvenance, candidate: RegistryProvenance) {
  return findings(baseline, candidate).map((f) => `${f.ruleId}:${f.severity}`);
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
