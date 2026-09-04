import { describe, expect, test } from "vitest";
import {
  isTrustedAutomationActor,
  normalizeRepository,
  parseNpmBuildIdentity,
  parseNpmStagePublisher,
  parseNpmTrustConfigs,
} from "../server/lib/ecosystems/npm/publisher-identity";
import { npmPublisherFindings } from "../server/lib/ecosystems/npm/findings";

function statement(predicateType, predicate) {
  const payload = Buffer.from(
    JSON.stringify({
      _type: "https://in-toto.io/Statement/v1",
      subject: [{ name: "pkg:npm/tool@1.0.0", digest: { sha512: "0".repeat(128) } }],
      predicateType,
      predicate,
    }),
  ).toString("base64");
  return {
    predicateType,
    bundle: {
      mediaType: "application/vnd.dev.sigstore.bundle+json;version=0.1",
      dsseEnvelope: { payload, payloadType: "application/vnd.in-toto+json", signatures: [] },
    },
  };
}

const githubConfig = {
  id: "tc_1",
  type: "github",
  claims: {
    repository: "acme/tool",
    workflow_ref: { file: "publish.yml" },
    environment: "release",
  },
  permissions: ["createStagedPackage"],
};

describe("parseNpmTrustConfigs", () => {
  test("reads the npm CLI body shape for github, gitlab, and circleci configs", () => {
    const configs = parseNpmTrustConfigs([
      { ...githubConfig, permissions: ["createPackage", "createStagedPackage"] },
      {
        id: "tc_2",
        type: "gitlab",
        claims: { project_path: "group/tool", ci_config_ref_uri: { file: ".gitlab-ci.yml" } },
        permissions: ["createStagedPackage"],
      },
      {
        id: "tc_3",
        type: "circleci",
        claims: { "oidc.circleci.com/vcs-origin": "github.com/acme/tool" },
        permissions: ["createPackage"],
      },
    ]);
    expect(configs).toEqual([
      {
        id: "tc_1",
        provider: "github",
        repository: "acme/tool",
        workflowFile: "publish.yml",
        environment: "release",
        directPublish: true,
        stagePublish: true,
      },
      {
        id: "tc_2",
        provider: "gitlab",
        repository: "group/tool",
        workflowFile: ".gitlab-ci.yml",
        environment: null,
        directPublish: false,
        stagePublish: true,
      },
      {
        id: "tc_3",
        provider: "circleci",
        repository: "github.com/acme/tool",
        workflowFile: null,
        environment: null,
        directPublish: true,
        stagePublish: false,
      },
    ]);
  });

  test("collapses a non-list body to null and drops malformed entries", () => {
    expect(parseNpmTrustConfigs({ configs: [] })).toBeNull();
    expect(parseNpmTrustConfigs("nope")).toBeNull();
    expect(parseNpmTrustConfigs([null, 7, "x", githubConfig])).toHaveLength(1);
  });

  test("rejects control characters and over-long fields instead of rendering them", () => {
    const [config] = parseNpmTrustConfigs([
      {
        ...githubConfig,
        claims: {
          repository: "acme/tool\nINJECTED",
          workflow_ref: { file: "p".repeat(600) },
          environment: " release ",
        },
      },
    ]);
    expect(config.repository).toBeNull();
    expect(config.workflowFile).toBeNull();
    expect(config.environment).toBe("release");
  });

  test("bounds the number of configs read from a hostile body", () => {
    const configs = parseNpmTrustConfigs(Array.from({ length: 500 }, () => githubConfig));
    expect(configs.length).toBeLessThanOrEqual(32);
  });
});

describe("parseNpmBuildIdentity", () => {
  test("reads SLSA v1 provenance from npm's attestation body", () => {
    const identity = parseNpmBuildIdentity({
      attestations: [
        statement("https://github.com/npm/attestation/tree/main/specs/publish/v0.1", {}),
        statement("https://slsa.dev/provenance/v1", {
          buildDefinition: {
            externalParameters: {
              workflow: {
                ref: "refs/heads/main",
                repository: "https://github.com/sigstore/sigstore-js",
                path: ".github/workflows/release.yml",
              },
            },
          },
          runDetails: { builder: { id: "https://github.com/actions/runner/github-hosted" } },
        }),
      ],
    });
    expect(identity).toEqual({
      repository: "sigstore/sigstore-js",
      workflowPath: ".github/workflows/release.yml",
      ref: "refs/heads/main",
      builderId: "https://github.com/actions/runner/github-hosted",
    });
  });

  test("reads SLSA v0.2 provenance from configSource", () => {
    const identity = parseNpmBuildIdentity({
      attestations: [
        statement("https://slsa.dev/provenance/v0.2", {
          builder: { id: "https://github.com/npm/cli@9.4.2" },
          invocation: {
            configSource: {
              uri: "git+https://github.com/sigstore/sigstore-js@refs/tags/v1.0.0",
              entryPoint: "sigstore/sigstore-js/.github/workflows/publish.yml@refs/tags/v1.0.0",
            },
          },
        }),
      ],
    });
    expect(identity).toEqual({
      repository: "sigstore/sigstore-js",
      workflowPath: ".github/workflows/publish.yml",
      ref: "refs/tags/v1.0.0",
      builderId: "https://github.com/npm/cli@9.4.2",
    });
  });

  test("collapses malformed bodies, payloads, and statement types to null", () => {
    expect(parseNpmBuildIdentity(null)).toBeNull();
    expect(parseNpmBuildIdentity({ attestations: "x" })).toBeNull();
    expect(
      parseNpmBuildIdentity({
        attestations: [
          {
            predicateType: "https://slsa.dev/provenance/v1",
            bundle: { dsseEnvelope: { payload: "!!not base64!!" } },
          },
        ],
      }),
    ).toBeNull();
    const wrongType = statement("https://slsa.dev/provenance/v1", {});
    wrongType.bundle.dsseEnvelope.payload = Buffer.from(
      JSON.stringify({ _type: "https://example.invalid/Statement", predicate: {} }),
    ).toString("base64");
    expect(parseNpmBuildIdentity({ attestations: [wrongType] })).toBeNull();
    expect(
      parseNpmBuildIdentity({ attestations: [statement("https://slsa.dev/provenance/v1", {})] }),
    ).toBeNull();
  });
});

describe("normalizeRepository", () => {
  test("strips only the github host and canonicalizes case", () => {
    expect(normalizeRepository("https://github.com/Acme/Tool.git")).toBe("acme/tool");
    expect(normalizeRepository("git+https://github.com/acme/tool")).toBe("acme/tool");
    expect(normalizeRepository("https://gitlab.com/group/tool")).toBe("gitlab.com/group/tool");
    expect(normalizeRepository("   ")).toBeNull();
  });
});

describe("isTrustedAutomationActor", () => {
  test("only npm's trusted automation reads as trusted", () => {
    expect(isTrustedAutomationActor("trusted automation")).toBe(true);
    expect(isTrustedAutomationActor("Trusted Automation")).toBe(true);
    expect(isTrustedAutomationActor("automation")).toBe(false);
    expect(isTrustedAutomationActor("user")).toBe(false);
    expect(isTrustedAutomationActor(null)).toBe(false);
  });
});

describe("parseNpmStagePublisher", () => {
  test("re-validates a persisted block and drops configs unless they were checked", () => {
    const parsed = parseNpmStagePublisher({
      actor: "bot",
      actorType: "trusted automation",
      trustConfigsState: "unavailable",
      trustConfigs: [{ provider: "github" }],
      previousBuild: { repository: "acme/tool", workflowPath: null, ref: null, builderId: null },
      stagedBuild: { repository: null, workflowPath: null, ref: null, builderId: null },
    });
    expect(parsed).toEqual({
      actor: "bot",
      actorType: "trusted automation",
      trustConfigs: null,
      trustConfigsState: "unavailable",
      previousBuild: { repository: "acme/tool", workflowPath: null, ref: null, builderId: null },
      stagedBuild: null,
    });
  });

  test("returns null for legacy or malformed blocks", () => {
    expect(parseNpmStagePublisher(undefined)).toBeNull();
    expect(parseNpmStagePublisher({ trustConfigsState: "sure" })).toBeNull();
  });
});

describe("npmPublisherFindings", () => {
  const stageOnly = {
    id: "tc_1",
    provider: "github",
    repository: "acme/tool",
    workflowFile: "publish.yml",
    environment: "release",
    directPublish: false,
    stagePublish: true,
  };
  const previousBuild = {
    repository: "acme/tool",
    workflowPath: ".github/workflows/publish.yml",
    ref: "refs/tags/v1.0.0",
    builderId: "https://github.com/actions/runner/github-hosted",
  };

  test("stays silent on unknown actor types, unreadable configs, and absent provenance", () => {
    expect(
      npmPublisherFindings({
        actor: null,
        actorType: null,
        trustConfigs: [stageOnly],
        trustConfigsState: "checked",
        previousBuild,
        stagedBuild: null,
      }),
    ).toEqual([]);
    expect(
      npmPublisherFindings({
        actor: "octocat",
        actorType: "user",
        trustConfigs: null,
        trustConfigsState: "unsupported",
        previousBuild: null,
        stagedBuild: null,
      }),
    ).toEqual([]);
    expect(npmPublisherFindings(null)).toEqual([]);
  });

  test("names the config in every message and never exceeds medium", () => {
    const findings = npmPublisherFindings({
      actor: "octocat",
      actorType: "user",
      trustConfigs: [
        { ...stageOnly, directPublish: true, environment: null, repository: "other/fork" },
      ],
      trustConfigsState: "checked",
      previousBuild,
      stagedBuild: null,
    });
    expect(findings.map((finding) => [finding.ruleId, finding.severity])).toEqual([
      ["publisher.direct-publish-allowed", "low"],
      ["publisher.no-environment", "low"],
      ["publisher.config-outside-provenance", "low"],
      ["publisher.actor-not-trusted", "medium"],
      ["publisher.provenance-path-changed", "medium"],
    ]);
    for (const finding of findings) expect(finding.file).toBe("<publisher>");
    // Every config-scoped message and the actor message name the config.
    for (const finding of findings.slice(0, 4)) expect(finding.evidence).toContain("other/fork");
    expect(findings[4].evidence).toContain("acme/tool .github/workflows/publish.yml");
    expect(findings[4].evidence).toContain("octocat (user)");
  });

  test("does not flag a missing environment on providers that have none", () => {
    const findings = npmPublisherFindings({
      actor: "bot",
      actorType: "trusted automation",
      trustConfigs: [{ ...stageOnly, provider: "circleci", environment: null }],
      trustConfigsState: "checked",
      previousBuild: null,
      stagedBuild: null,
    });
    expect(findings).toEqual([]);
  });
});
