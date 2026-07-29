import { describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

const { evaluateStagedArtifactIntegrity, parseStagedArtifactIntegrity } =
  await import("../server/lib/ecosystems/artifact-integrity");
const { buildNpmFindings } = await import("../server/lib/ecosystems/npm/findings");

const DECLARED = "cf6abd23c6a49417b8e8cd8635a1bba94a6fe5d2";
const OTHER = "48283451416861c231a367b872a700c1ef002013";

describe("evaluateStagedArtifactIntegrity", () => {
  test("verifies matching digests", () => {
    expect(evaluateStagedArtifactIntegrity(DECLARED, DECLARED)).toEqual({
      algorithm: "sha1",
      status: "verified",
      declared: DECLARED,
      computed: DECLARED,
    });
  });

  test("normalizes case and surrounding whitespace before comparing", () => {
    expect(evaluateStagedArtifactIntegrity(` ${DECLARED.toUpperCase()} `, DECLARED)).toMatchObject({
      status: "verified",
    });
  });

  test("reports a mismatch only when both digests exist", () => {
    expect(evaluateStagedArtifactIntegrity(DECLARED, OTHER)).toEqual({
      algorithm: "sha1",
      status: "mismatch",
      declared: DECLARED,
      computed: OTHER,
    });
  });

  test.each([
    ["registry reported no digest", null, DECLARED, "declared-digest-missing"],
    ["sandbox could not digest the stream", DECLARED, null, "computed-digest-unavailable"],
    ["neither side has a digest", null, null, "declared-digest-missing"],
    ["declared digest is not sha1 hex", "not-a-digest", DECLARED, "declared-digest-missing"],
  ])("fails to unverified when %s", (_name, declared, computed, reason) => {
    expect(evaluateStagedArtifactIntegrity(declared, computed)).toMatchObject({
      status: "unverified",
      reason,
    });
  });
});

describe("parseStagedArtifactIntegrity", () => {
  test.each([
    evaluateStagedArtifactIntegrity(DECLARED, DECLARED),
    evaluateStagedArtifactIntegrity(DECLARED, OTHER),
    evaluateStagedArtifactIntegrity(DECLARED, null),
    evaluateStagedArtifactIntegrity(null, OTHER),
  ])("accepts a consistent persisted $status verdict", (integrity) => {
    expect(parseStagedArtifactIntegrity(integrity)).toEqual(integrity);
  });

  test.each([
    null,
    {},
    { algorithm: "sha256", status: "verified", declared: DECLARED, computed: DECLARED },
    { algorithm: "sha1", status: "verified", declared: DECLARED, computed: OTHER },
    { algorithm: "sha1", status: "mismatch", declared: DECLARED, computed: DECLARED },
    {
      algorithm: "sha1",
      status: "unverified",
      declared: DECLARED,
      computed: OTHER,
      reason: "computed-digest-unavailable",
    },
  ])("rejects malformed or internally inconsistent persisted data", (value) => {
    expect(parseStagedArtifactIntegrity(value)).toBeNull();
  });
});

describe("stage.tarball-digest-mismatch", () => {
  const stagedArtifact = {
    files: [
      {
        path: "package.json",
        size: 32,
        sha256: "abc",
        flags: [],
        textSample: '{"name":"pkg","version":"1.0.0"}',
      },
    ],
    manifest: { name: "pkg", version: "1.0.0" },
  };

  function findingsFor(artifactIntegrity) {
    return buildNpmFindings({
      staged: stagedArtifact,
      details: {
        id: "stage-1",
        packageName: "pkg",
        version: "1.0.0",
        tag: "latest",
        access: "public",
        actor: null,
        actorType: null,
        createdAt: null,
        shasum: DECLARED,
        packageJson: null,
        artifactIntegrity,
      },
      fileDiff: [],
      manifestDiff: { name: "pkg", bin: [], dependencies: [], scripts: [] },
      stagedManifestText: null,
    });
  }

  test("raises a critical finding when the reviewed bytes are not the staged bytes", () => {
    const findings = findingsFor(evaluateStagedArtifactIntegrity(DECLARED, OTHER)).filter(
      (finding) => finding.ruleId === "stage.tarball-digest-mismatch",
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "critical", file: "package.json" });
    expect(findings[0].evidence).toContain(OTHER);
    expect(findings[0].evidence).toContain(DECLARED);
  });

  test.each([
    ["verified", evaluateStagedArtifactIntegrity(DECLARED, DECLARED)],
    ["unverified", evaluateStagedArtifactIntegrity(DECLARED, null)],
    ["absent", undefined],
  ])("stays silent when the digest verdict is %s", (_name, integrity) => {
    expect(
      findingsFor(integrity).filter(
        (finding) => finding.ruleId === "stage.tarball-digest-mismatch",
      ),
    ).toEqual([]);
  });
});
