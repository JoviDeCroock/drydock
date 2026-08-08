import { describe, expect, it } from "vitest";
import {
  derEcdsaSignatureToRaw,
  dssePae,
  evaluateBuildAttestation,
  normalizeBuildAttestation,
  parseInTotoStatement,
  parseSigstoreBundle,
  verifyDsseSignature,
} from "../server/lib/build-attestation";

import {
  FIXTURE_COMMIT as COMMIT,
  FIXTURE_REPOSITORY as REPO,
  FIXTURE_RUN_ID as RUN_ID,
  signedBundle as buildSignedBundle,
  slsaV1Statement as buildSlsaV1Statement,
  type StatementOverrides,
} from "./helpers/sigstore-bundle";

// The shared fixtures default to no subjects so each caller states the digests
// it means; every case here is about one reviewed artifact.
const ARTIFACT_DIGEST = "b".repeat(64);

function slsaV1Statement(overrides: StatementOverrides = {}) {
  return buildSlsaV1Statement({ digests: [ARTIFACT_DIGEST], ...overrides });
}

const signedBundle = buildSignedBundle;

const BINDING = {
  repositoryFullName: REPO,
  runId: RUN_ID,
  headSha: COMMIT,
  artifactDigests: [ARTIFACT_DIGEST],
};

// ── DSSE / signature layer ───────────────────────────────────────────────────

describe("DSSE encoding and signature verification", () => {
  it("encodes PAE with byte lengths, not character lengths", () => {
    // "é" is two UTF-8 bytes; a character-length implementation writes 1 here
    // and every real signature stops verifying.
    const payload = new TextEncoder().encode("é");
    const pae = new TextDecoder().decode(dssePae("t", payload));
    expect(pae).toBe("DSSEv1 1 t 2 é");
  });

  it("verifies a genuinely signed bundle through the certificate's key", async () => {
    const bundle = await signedBundle(slsaV1Statement());
    const envelope = parseSigstoreBundle(bundle);
    expect(envelope).not.toBeNull();
    await expect(verifyDsseSignature(envelope!)).resolves.toMatchObject({
      verified: true,
      algorithm: "ecdsa-p256",
    });
  });

  it("does not verify a tampered signature", async () => {
    const bundle = await signedBundle(slsaV1Statement(), { tamperSignature: true });
    const outcome = await verifyDsseSignature(parseSigstoreBundle(bundle)!);
    expect(outcome.verified).toBe(false);
  });

  it("reports missing verification material instead of throwing", async () => {
    const bundle = await signedBundle(slsaV1Statement(), { omitCertificate: true });
    await expect(verifyDsseSignature(parseSigstoreBundle(bundle)!)).resolves.toMatchObject({
      verified: false,
      reason: expect.stringContaining("certificate"),
    });
  });

  it("reads the v0.2 x509CertificateChain bundle layout", async () => {
    const bundle = (await signedBundle(slsaV1Statement())) as Record<string, unknown>;
    const leaf = (bundle.verificationMaterial as { certificate: { rawBytes: string } }).certificate;
    bundle.verificationMaterial = { x509CertificateChain: { certificates: [leaf] } };
    await expect(verifyDsseSignature(parseSigstoreBundle(bundle)!)).resolves.toMatchObject({
      verified: true,
    });
  });

  it("rejects malformed bundles rather than partially reading them", () => {
    expect(parseSigstoreBundle(null)).toBeNull();
    expect(parseSigstoreBundle({})).toBeNull();
    expect(parseSigstoreBundle({ dsseEnvelope: { payloadType: "t" } })).toBeNull();
    // Not base64.
    expect(
      parseSigstoreBundle({ dsseEnvelope: { payloadType: "t", payload: "not base64!!" } }),
    ).toBeNull();
  });

  it("strips DER integer padding when converting an ECDSA signature", () => {
    // r = 0x00FF… (padded to stay positive), s = 0x01…
    const signature = Uint8Array.from([0x30, 0x08, 0x02, 0x02, 0x00, 0xff, 0x02, 0x02, 0x01, 0x02]);
    const raw = derEcdsaSignatureToRaw(signature, 4);
    expect(raw).not.toBeNull();
    expect([...raw!]).toEqual([0, 0, 0, 0xff, 0, 0, 0x01, 0x02]);
  });

  it("refuses an ECDSA signature whose coordinates overflow the curve width", () => {
    const signature = Uint8Array.from([0x30, 0x08, 0x02, 0x02, 0x01, 0x02, 0x02, 0x02, 0x03, 0x04]);
    expect(derEcdsaSignatureToRaw(signature, 1)).toBeNull();
  });
});

// ── Statement projection ─────────────────────────────────────────────────────

describe("in-toto statement projection", () => {
  it("projects SLSA v1 build definitions", () => {
    const payload = new TextEncoder().encode(JSON.stringify(slsaV1Statement()));
    expect(parseInTotoStatement(payload)).toEqual({
      predicateType: "https://slsa.dev/provenance/v1",
      repository: `https://github.com/${REPO}`,
      workflowPath: ".github/workflows/release.yml",
      ref: "refs/heads/main",
      commit: COMMIT,
      runId: RUN_ID,
      runAttempt: "1",
      builderId: "https://github.com/actions/runner/github-hosted",
      subjectDigests: [ARTIFACT_DIGEST],
    });
  });

  it("projects SLSA v0.2 invocations, splitting the ref off the config-source URI", () => {
    const statement = {
      _type: "https://in-toto.io/Statement/v1",
      subject: [{ name: "pkg:npm/widgets", digest: { sha256: ARTIFACT_DIGEST } }],
      predicateType: "https://slsa.dev/provenance/v0.2",
      predicate: {
        builder: { id: "https://github.com/actions/runner" },
        buildType: "https://github.com/npm/cli/gha/v2",
        invocation: {
          configSource: {
            uri: `git+https://github.com/${REPO}@refs/heads/main`,
            digest: { sha1: COMMIT },
            entryPoint: ".github/workflows/publish.yml",
          },
        },
        metadata: {
          buildInvocationId: `https://github.com/${REPO}/actions/runs/${RUN_ID}/attempts/2`,
        },
      },
    };
    const claim = parseInTotoStatement(new TextEncoder().encode(JSON.stringify(statement)));
    expect(claim).toMatchObject({
      repository: `https://github.com/${REPO}`,
      ref: "refs/heads/main",
      commit: COMMIT,
      runId: RUN_ID,
      runAttempt: "2",
      workflowPath: ".github/workflows/publish.yml",
    });
  });

  it("keeps only sha256 subject digests", () => {
    const statement = {
      _type: "https://in-toto.io/Statement/v1",
      predicateType: "https://slsa.dev/provenance/v1",
      subject: [
        { name: "a", digest: { sha512: "f".repeat(128) } },
        { name: "b", digest: { sha256: ARTIFACT_DIGEST.toUpperCase() } },
        { name: "c", digest: { sha256: "not-hex" } },
      ],
      predicate: {},
    };
    const claim = parseInTotoStatement(new TextEncoder().encode(JSON.stringify(statement)));
    expect(claim?.subjectDigests).toEqual([ARTIFACT_DIGEST]);
  });

  it("rejects payloads that are not in-toto statements", () => {
    const notAStatement = { _type: "https://example.com/other", predicateType: "x" };
    expect(
      parseInTotoStatement(new TextEncoder().encode(JSON.stringify(notAStatement))),
    ).toBeNull();
    expect(parseInTotoStatement(new TextEncoder().encode("{ not json"))).toBeNull();
  });
});

// ── Verdict ──────────────────────────────────────────────────────────────────

describe("build attestation verdict", () => {
  it("grades a matching signed attestation as verified", async () => {
    const bundle = await signedBundle(slsaV1Statement());
    const verdict = await evaluateBuildAttestation({ status: "ok", bundles: [bundle] }, BINDING);

    expect(verdict.status).toBe("verified");
    expect(verdict.trustCeiling).toBe("self-consistent");
    expect(checkResults(verdict)).toEqual({
      "subject-digest": "pass",
      repository: "pass",
      "workflow-run": "pass",
      "source-commit": "pass",
      signature: "pass",
    });
  });

  it("grades a different repository as a mismatch", async () => {
    const bundle = await signedBundle(
      slsaV1Statement({ repository: "https://github.com/attacker/widgets" }),
    );
    const verdict = await evaluateBuildAttestation({ status: "ok", bundles: [bundle] }, BINDING);

    expect(verdict.status).toBe("mismatch");
    expect(checkResults(verdict).repository).toBe("fail");
    expect(verdict.checks.find((check) => check.kind === "repository")?.detail).toContain(
      "signed webhook bound",
    );
  });

  it("grades an attestation for other bytes as a mismatch", async () => {
    const bundle = await signedBundle(slsaV1Statement({ digests: ["c".repeat(64)] }));
    const verdict = await evaluateBuildAttestation({ status: "ok", bundles: [bundle] }, BINDING);

    expect(verdict.status).toBe("mismatch");
    expect(checkResults(verdict)["subject-digest"]).toBe("fail");
  });

  it("grades a different workflow run as a mismatch", async () => {
    const bundle = await signedBundle(slsaV1Statement({ runId: "111" }));
    const verdict = await evaluateBuildAttestation({ status: "ok", bundles: [bundle] }, BINDING);
    expect(verdict.status).toBe("mismatch");
    expect(checkResults(verdict)["workflow-run"]).toBe("fail");
  });

  it("keeps verification monotonic when older attestations cover the same bytes", async () => {
    // Digest lookups span repository history. A retry can produce the same
    // bytes in a newer run, so an older attestation must not downgrade a
    // matching current-run attestation.
    const good = await signedBundle(slsaV1Statement());
    const bad = await signedBundle(
      slsaV1Statement({ repository: "https://github.com/attacker/widgets" }),
    );
    const verdict = await evaluateBuildAttestation({ status: "ok", bundles: [good, bad] }, BINDING);
    expect(verdict.status).toBe("verified");
  });

  it("degrades to partial when the signature cannot be verified", async () => {
    const bundle = await signedBundle(slsaV1Statement(), { tamperSignature: true });
    const verdict = await evaluateBuildAttestation({ status: "ok", bundles: [bundle] }, BINDING);

    expect(verdict.status).toBe("partial");
    expect(verdict.trustCeiling).toBe("none");
    expect(checkResults(verdict).signature).toBe("fail");
  });

  it("degrades to partial when the predicate corroborates nothing", async () => {
    // The npm publish attestation covers the bytes but names no build source,
    // so a signature alone must not read as a verified build claim.
    const bundle = await signedBundle(
      slsaV1Statement({
        predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1",
        predicate: { name: "widgets", version: "1.0.0" },
      }),
    );
    const verdict = await evaluateBuildAttestation({ status: "ok", bundles: [bundle] }, BINDING);

    expect(verdict.status).toBe("partial");
    expect(checkResults(verdict)).toMatchObject({
      "subject-digest": "pass",
      repository: "skipped",
      "workflow-run": "skipped",
      signature: "pass",
    });
  });

  it("skips the commit check when the run head commit is unknown", async () => {
    const bundle = await signedBundle(slsaV1Statement());
    const verdict = await evaluateBuildAttestation(
      { status: "ok", bundles: [bundle] },
      {
        ...BINDING,
        headSha: null,
      },
    );
    expect(verdict.status).toBe("verified");
    expect(checkResults(verdict)["source-commit"]).toBe("skipped");
  });

  it("states how many of the reviewed artifacts an attestation actually covers", async () => {
    // One attested wheel in a three-wheel release is a true `subject-digest`
    // pass, but reading it as "this release is attested" would be wrong.
    const bundle = await signedBundle(slsaV1Statement());
    const verdict = await evaluateBuildAttestation(
      { status: "ok", bundles: [bundle] },
      {
        ...BINDING,
        artifactDigests: [ARTIFACT_DIGEST, "d".repeat(64), "e".repeat(64)],
      },
    );
    expect(verdict.status).toBe("verified");
    expect(verdict.checks.find((check) => check.kind === "subject-digest")?.detail).toContain(
      "1 of 3 reviewed artifacts",
    );

    const full = await evaluateBuildAttestation({ status: "ok", bundles: [bundle] }, BINDING);
    expect(full.checks.find((check) => check.kind === "subject-digest")?.detail).toContain(
      "all 1 reviewed artifact",
    );
  });

  it("separates 'nothing published' from 'could not look'", async () => {
    await expect(
      evaluateBuildAttestation({ status: "ok", bundles: [] }, BINDING),
    ).resolves.toMatchObject({ status: "absent", claim: null });

    await expect(
      evaluateBuildAttestation({ status: "failed", reason: "HTTP 503" }, BINDING),
    ).resolves.toMatchObject({ status: "unavailable", claim: null });
  });

  it("reports unavailable when a returned bundle is unreadable", async () => {
    const verdict = await evaluateBuildAttestation(
      { status: "ok", bundles: [{ garbage: true }] },
      BINDING,
    );
    expect(verdict.status).toBe("unavailable");
  });
});

function checkResults(verdict: { checks: Array<{ kind: string; result: string }> }) {
  return Object.fromEntries(verdict.checks.map((check) => [check.kind, check.result]));
}

// ── Persisted-blob normalization ─────────────────────────────────────────────

describe("normalizeBuildAttestation", () => {
  const verifiedBlob = {
    status: "verified",
    trustCeiling: "self-consistent",
    claim: {
      predicateType: "https://slsa.dev/provenance/v1",
      repository: `https://github.com/${REPO}`,
      workflowPath: ".github/workflows/release.yml",
      ref: "refs/heads/main",
      commit: COMMIT,
      runId: RUN_ID,
      runAttempt: "1",
      builderId: "https://github.com/actions/runner/github-hosted",
      subjectDigests: [ARTIFACT_DIGEST],
    },
    checks: [
      { kind: "subject-digest", result: "pass", detail: "d" },
      { kind: "repository", result: "pass", detail: "d" },
      { kind: "signature", result: "pass", detail: "d" },
    ],
  };

  it("round-trips a real verdict", async () => {
    const bundle = await signedBundle(slsaV1Statement());
    const verdict = await evaluateBuildAttestation({ status: "ok", bundles: [bundle] }, BINDING);
    expect(normalizeBuildAttestation(JSON.parse(JSON.stringify(verdict)))).toEqual(verdict);
  });

  it("accepts a well-formed verified blob", () => {
    expect(normalizeBuildAttestation(verifiedBlob)?.status).toBe("verified");
  });

  it("refuses a verified status with no supporting checks", () => {
    // The whole point of the normalizer: a status must not outlive its evidence.
    expect(normalizeBuildAttestation({ ...verifiedBlob, checks: [] })).toBeNull();
    expect(normalizeBuildAttestation({ status: "verified" })).toBeNull();
  });

  it("refuses a verified status whose signature never passed", () => {
    expect(
      normalizeBuildAttestation({
        ...verifiedBlob,
        checks: verifiedBlob.checks.map((check) =>
          check.kind === "signature" ? { ...check, result: "fail" } : check,
        ),
      }),
    ).toBeNull();
  });

  it("refuses a verified status with no independent corroboration", () => {
    expect(
      normalizeBuildAttestation({
        ...verifiedBlob,
        checks: verifiedBlob.checks.filter((check) => check.kind !== "repository"),
      }),
    ).toBeNull();
  });

  it("refuses a verified status whose trust ceiling was downgraded", () => {
    expect(normalizeBuildAttestation({ ...verifiedBlob, trustCeiling: "none" })).toBeNull();
  });

  it("refuses a mismatch that contradicts nothing", () => {
    expect(normalizeBuildAttestation({ ...verifiedBlob, status: "mismatch" })).toBeNull();
  });

  it("refuses absent/unavailable blobs that carry a claim", () => {
    expect(normalizeBuildAttestation({ ...verifiedBlob, status: "absent" })).toBeNull();
    expect(normalizeBuildAttestation({ ...verifiedBlob, status: "unavailable" })).toBeNull();
  });

  it("reads pre-feature and malformed values as null", () => {
    expect(normalizeBuildAttestation(undefined)).toBeNull();
    expect(normalizeBuildAttestation(null)).toBeNull();
    expect(normalizeBuildAttestation([])).toBeNull();
    expect(normalizeBuildAttestation({ status: "nonsense" })).toBeNull();
  });

  it("drops claim fields that are not well-formed", () => {
    const normalized = normalizeBuildAttestation({
      ...verifiedBlob,
      claim: {
        ...verifiedBlob.claim,
        commit: "not-a-commit",
        runId: "not-a-run",
        repository: "::::",
        subjectDigests: [ARTIFACT_DIGEST, "short"],
      },
    });
    expect(normalized?.claim).toMatchObject({
      commit: null,
      runId: null,
      repository: null,
      subjectDigests: [ARTIFACT_DIGEST],
    });
  });
});
