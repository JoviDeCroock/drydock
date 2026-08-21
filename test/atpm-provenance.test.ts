import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { atpmRecordFindings } from "../server/lib/ecosystems/atpm/findings";
import {
  atpmPurl,
  readAtpmAttestation,
  verifyAtpmProvenance,
  type AtpmProvenanceState,
} from "../server/lib/ecosystems/atpm/provenance";
import {
  matchTrustedPublisher,
  parseAtpmTrustPublisherRecord,
  trustedPublisherRepositoryUri,
  type AtpmTrustPublisher,
} from "../server/lib/ecosystems/atpm/trust-publisher";
import {
  fetchAtpmPackageRecord,
  parseAtpmPackageRecord,
  type AtpmVersion,
} from "../server/lib/ecosystems/atpm/record";
import { decodeBase64, parseX509, pemToDer } from "../server/lib/platform/x509";

/**
 * A real Sigstore bundle, as `npm publish --provenance` produces and as atpm
 * copies verbatim into a package record. Fetched from npm's public attestation
 * endpoint for `sigstore@3.0.0`, so the certificate chain, DSSE signature, and
 * Fulcio extensions in it are the genuine article rather than something this
 * suite generated and could therefore also verify incorrectly.
 */
const BUNDLE = JSON.parse(
  readFileSync(new URL("./fixtures/atpm/sigstore-3.0.0.provenance.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

const SUBJECT_SHA512 =
  "3c73227e187710de25a0c7070b3ea5deffe5bb3813df36bef5ff2cb9b1a078c3636c98f31f8223fd8a17dc6beefa46a8b894489557531c70911000d87fe66d78";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** A bundle whose DSSE payload has been rewritten, leaving the signature stale. */
function withPayload(mutate: (statement: Record<string, any>) => void): Record<string, unknown> {
  const bundle = clone(BUNDLE) as any;
  const statement = JSON.parse(atob(bundle.dsseEnvelope.payload));
  mutate(statement);
  bundle.dsseEnvelope.payload = btoa(JSON.stringify(statement));
  return bundle;
}

function version(overrides: Partial<AtpmVersion> = {}): AtpmVersion {
  return {
    version: "3.0.0",
    cid: "bafkreibrz4xmz6sbraw6h2mtchh5xq7jqghrjhr3yyyub3wbyrvmyjg2bm",
    size: 604,
    mimeType: "application/gzip",
    createdAt: "2026-08-13T06:28:24.000Z",
    declaredName: "@ebey.dev/counter",
    declaredVersion: "3.0.0",
    declaredShasum: null,
    declaredTarball: "https://pds.example.com/xrpc/com.atproto.sync.getBlob?did=x&cid=y",
    declaredIntegrity: null,
    provenance: { status: "absent" },
    ...overrides,
  };
}

function publisher(overrides: Partial<AtpmTrustPublisher> = {}): AtpmTrustPublisher {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    allowStage: true,
    allowPublish: false,
    github: { username: "sigstore", repository: "sigstore-js", workflow: "release.yml" },
    ...overrides,
  };
}

async function verifiedFixture(): Promise<AtpmProvenanceState> {
  return verifyAtpmProvenance(BUNDLE);
}

const DID = "did:plc:twegdcgytckr5cxm57gyruxa";
const PDS = "https://shiitake.us-east.host.bsky.network";
const CID = "bafkreibrz4xmz6sbraw6h2mtchh5xq7jqghrjhr3yyyub3wbyrvmyjg2bm";

/** A package record whose one version carries the real bundle above. */
function recordWithAttestation(attestation: unknown) {
  return {
    $type: "dev.atpm.alpha.package",
    createdAt: "2026-01-01T00:00:00.000Z",
    tags: { latest: "3.0.0" },
    versions: [
      {
        $type: "dev.atpm.alpha.package#package",
        version: "3.0.0",
        createdAt: "2026-08-13T06:28:24.000Z",
        blob: { $type: "blob", ref: { $link: CID }, size: 604, mimeType: "application/gzip" },
        meta: {
          name: "@ebey.dev/counter",
          version: "3.0.0",
          dist: {
            tarball: `${PDS}/xrpc/com.atproto.sync.getBlob?did=${DID}&cid=${CID}`,
            attestations: { provenance: attestation },
          },
        },
      },
    ],
  };
}

describe("record provenance", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("parsing never carries a bundle out with it", () => {
    const parsed = parseAtpmPackageRecord(recordWithAttestation(BUNDLE));
    expect(parsed?.versions[0].provenance).toEqual({ status: "not-evaluated" });
    // The bundle is the largest thing in a real record and is exchanged for a
    // verdict before anything is cached, so no caller can carry one further.
    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain((BUNDLE as any).dsseEnvelope.payload.slice(0, 64));
    expect(serialized.length).toBeLessThan(1024);
  });

  test("fetching resolves each version to a verdict and keeps the bundle out of the result", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(Response.json({ value: recordWithAttestation(BUNDLE) })),
    );
    const pkg = await fetchAtpmPackageRecord(
      { did: DID, pds: PDS, handle: "ebey.dev", handleMethod: "dns" },
      "counter",
    );
    expect(pkg.versions[0].provenance.status).toBe("verified");
    expect(JSON.stringify(pkg)).not.toContain((BUNDLE as any).dsseEnvelope.payload.slice(0, 64));
  });

  test("a version with no attestation reads as absent rather than unevaluated", async () => {
    const record = recordWithAttestation(BUNDLE) as any;
    delete record.versions[0].meta.dist.attestations;
    vi.stubGlobal("fetch", () => Promise.resolve(Response.json({ value: record })));
    const pkg = await fetchAtpmPackageRecord(
      { did: DID, pds: PDS, handle: null, handleMethod: null },
      "counter",
    );
    expect(pkg.versions[0].provenance).toEqual({ status: "absent" });
  });
});

describe("x509 reader", () => {
  test("reads the pinned Fulcio root's fields", () => {
    const chain = (BUNDLE as any).verificationMaterial.x509CertificateChain.certificates;
    const leaf = parseX509(decodeBase64(chain[0].rawBytes));
    expect(leaf.namedCurve).toBe("P-256");
    // ecdsa-with-SHA384: Fulcio's intermediate signs leaves with its P-384 key.
    expect(leaf.signatureAlgorithm).toBe("1.2.840.10045.4.3.3");
    expect(leaf.extensions.get("1.3.6.1.4.1.57264.1.12")).toBeDefined();
    expect(leaf.notAfter.getTime()).toBeGreaterThan(leaf.notBefore.getTime());
  });

  test("rejects trailing bytes after the certificate", () => {
    const chain = (BUNDLE as any).verificationMaterial.x509CertificateChain.certificates;
    const der = decodeBase64(chain[0].rawBytes);
    const padded = new Uint8Array(der.length + 1);
    padded.set(der);
    expect(() => parseX509(padded)).toThrow(/trailing bytes/);
  });

  test("rejects a PEM that is not a certificate", () => {
    expect(() => parseX509(pemToDer("-----BEGIN X-----\nAAAA\n-----END X-----"))).toThrow();
  });
});

describe("verifyAtpmProvenance", () => {
  test("verifies a real npm provenance bundle against the pinned Sigstore root", async () => {
    const state = await verifiedFixture();
    expect(state.status).toBe("verified");
    if (state.status !== "verified") return;
    expect(state.provenance.sourceRepository).toBe("https://github.com/sigstore/sigstore-js");
    expect(state.provenance.workflowPath).toBe(".github/workflows/release.yml");
    expect(state.provenance.runnerEnvironment).toBe("github-hosted");
    expect(state.provenance.repositoryVisibility).toBe("public");
    expect(state.provenance.subjectName).toBe("pkg:npm/sigstore@3.0.0");
    expect(state.provenance.subjectSha512).toBe(SUBJECT_SHA512);
    expect(state.provenance.logIndex).toBe("139985224");
    // Fulcio leaves expire in minutes, so the window has to be evaluated at the
    // recorded signing time or every historical release would read as invalid.
    expect(state.provenance.signedAt).toBe("2024-10-14T16:13:45.000Z");
  });

  test("reports absence rather than failure when there is no attestation", async () => {
    expect(await verifyAtpmProvenance(null)).toEqual({ status: "absent" });
    expect(await verifyAtpmProvenance(undefined)).toEqual({ status: "absent" });
  });

  test("rejects a bundle whose payload was rewritten after signing", async () => {
    const tampered = withPayload((statement) => {
      statement.subject[0].name = "pkg:npm/%40attacker/evil@1.0.0";
    });
    expect(await verifyAtpmProvenance(tampered)).toEqual({
      status: "invalid",
      reason: "bundle signature does not verify",
    });
  });

  test("rejects a bundle whose attested digest was rewritten", async () => {
    const tampered = withPayload((statement) => {
      statement.subject[0].digest.sha512 = "0".repeat(128);
    });
    expect((await verifyAtpmProvenance(tampered)).status).toBe("invalid");
  });

  test("rejects transparency-log metadata that no longer matches Rekor's signed promise", async () => {
    for (const mutate of [
      (entry: Record<string, any>) => {
        entry.integratedTime = "1728922426";
      },
      (entry: Record<string, any>) => {
        entry.logIndex = "139985225";
      },
    ]) {
      const bundle = clone(BUNDLE) as any;
      mutate(bundle.verificationMaterial.tlogEntries[0]);
      expect(await verifyAtpmProvenance(bundle)).toEqual({
        status: "invalid",
        reason: "transparency-log inclusion promise does not verify",
      });
    }
  });

  test("refuses a self-signed certificate that does not chain to Fulcio", async () => {
    const bundle = clone(BUNDLE) as any;
    // Swap the leaf for the pinned intermediate: a real, well-formed certificate
    // that simply was not issued by an accepted Fulcio intermediate.
    bundle.verificationMaterial.x509CertificateChain.certificates = [
      { rawBytes: bundle.verificationMaterial.x509CertificateChain.certificates[0].rawBytes },
    ];
    bundle.verificationMaterial.x509CertificateChain.certificates[0].rawBytes = btoa(
      String.fromCharCode(...pemToDer(FULCIO_INTERMEDIATE_PEM)),
    );
    expect(await verifyAtpmProvenance(bundle)).toEqual({
      status: "invalid",
      reason: "signing certificate does not chain to the pinned Sigstore root",
    });
  });

  test("rejects an unsupported bundle media type", async () => {
    const bundle = clone(BUNDLE) as any;
    bundle.mediaType = "application/json";
    expect((await verifyAtpmProvenance(bundle)).status).toBe("invalid");
  });

  test("rejects a statement with more than one subject", async () => {
    const tampered = withPayload((statement) => {
      statement.subject.push({ ...statement.subject[0], name: "pkg:npm/other@1.0.0" });
    });
    expect((await verifyAtpmProvenance(tampered)).status).toBe("invalid");
  });

  test("treats a bundle signed by a bare public key as unverifiable", async () => {
    // npm's own publish attestation is signed with a registry key rather than a
    // Fulcio certificate; nothing here can read an identity out of it.
    const bundle = clone(BUNDLE) as any;
    delete bundle.verificationMaterial.x509CertificateChain;
    bundle.verificationMaterial.publicKey = { hint: "npm" };
    expect(await verifyAtpmProvenance(bundle)).toEqual({
      status: "invalid",
      reason: "bundle carries no signing certificate",
    });
  });

  test("never throws on adversarial input", async () => {
    for (const value of [42, "x", [], { mediaType: 1 }, { verificationMaterial: [] }]) {
      const state = await verifyAtpmProvenance(value);
      expect(["invalid", "absent"]).toContain(state.status);
    }
  });
});

describe("readAtpmAttestation", () => {
  test("finds the bundle where npm and atpm put it", () => {
    expect(readAtpmAttestation({ dist: { attestations: { provenance: BUNDLE } } })).toBe(BUNDLE);
  });

  test("returns null for every other shape", () => {
    expect(readAtpmAttestation(null)).toBeNull();
    expect(readAtpmAttestation({ dist: {} })).toBeNull();
    expect(readAtpmAttestation({ dist: { attestations: { provenance: "x" } } })).toBeNull();
  });
});

describe("parseAtpmTrustPublisherRecord", () => {
  test("reads a well-formed record", () => {
    expect(
      parseAtpmTrustPublisherRecord({
        $type: "dev.atpm.alpha.trustPublisher",
        createdAt: "2026-01-01T00:00:00.000Z",
        allowStage: true,
        allowPublish: false,
        github: { username: "ebey", repository: "counter", workflow: "publish.yml" },
      }),
    ).toEqual({
      createdAt: "2026-01-01T00:00:00.000Z",
      allowStage: true,
      allowPublish: false,
      github: { username: "ebey", repository: "counter", workflow: "publish.yml" },
    });
  });

  test("rejects a record of a different collection", () => {
    expect(
      parseAtpmTrustPublisherRecord({
        $type: "dev.atpm.alpha.package",
        createdAt: "2026-01-01T00:00:00.000Z",
        allowStage: true,
        allowPublish: true,
      }),
    ).toBeNull();
  });

  test("drops a github block whose workflow could widen the ref prefix", () => {
    for (const workflow of ["../evil.yml", "a/b.yml", "", "x".repeat(101)]) {
      const parsed = parseAtpmTrustPublisherRecord({
        $type: "dev.atpm.alpha.trustPublisher",
        createdAt: "2026-01-01T00:00:00.000Z",
        allowStage: true,
        allowPublish: true,
        github: { username: "ebey", repository: "counter", workflow },
      });
      expect(parsed?.github).toBeNull();
    }
  });

  test("keeps the permission flags even when the provider is unreadable", () => {
    const parsed = parseAtpmTrustPublisherRecord({
      $type: "dev.atpm.alpha.trustPublisher",
      createdAt: "2026-01-01T00:00:00.000Z",
      allowStage: true,
      allowPublish: true,
      gitlab: { project: "x" },
    });
    expect(parsed).toEqual({
      createdAt: "2026-01-01T00:00:00.000Z",
      allowStage: true,
      allowPublish: true,
      github: null,
    });
  });
});

describe("matchTrustedPublisher", () => {
  test("matches the repository and workflow the certificate names", async () => {
    const state = await verifiedFixture();
    if (state.status !== "verified") throw new Error("fixture must verify");
    expect(matchTrustedPublisher(state.provenance, publisher())).toEqual({ status: "match" });
  });

  test("reports a repository the publisher never declared", async () => {
    const state = await verifiedFixture();
    if (state.status !== "verified") throw new Error("fixture must verify");
    const match = matchTrustedPublisher(
      state.provenance,
      publisher({ github: { username: "attacker", repository: "fork", workflow: "release.yml" } }),
    );
    expect(match).toEqual({
      status: "repository-mismatch",
      expected: "https://github.com/attacker/fork",
      actual: "https://github.com/sigstore/sigstore-js",
    });
  });

  test("reports a workflow the publisher never declared", async () => {
    const state = await verifiedFixture();
    if (state.status !== "verified") throw new Error("fixture must verify");
    expect(
      matchTrustedPublisher(
        state.provenance,
        publisher({
          github: { username: "sigstore", repository: "sigstore-js", workflow: "other.yml" },
        }),
      ).status,
    ).toBe("workflow-mismatch");
  });

  test("does not treat a missing certificate workflow identity as a match", async () => {
    const state = await verifiedFixture();
    if (state.status !== "verified") throw new Error("fixture must verify");
    expect(matchTrustedPublisher({ ...state.provenance, workflowPath: null }, publisher())).toEqual(
      {
        status: "workflow-unverified",
        expected: ".github/workflows/release.yml",
      },
    );
  });

  test("does not claim a disagreement with a provider it cannot read", async () => {
    const state = await verifiedFixture();
    if (state.status !== "verified") throw new Error("fixture must verify");
    expect(matchTrustedPublisher(state.provenance, publisher({ github: null }))).toEqual({
      status: "unknown-provider",
    });
  });

  test("builds the repository URI a certificate would carry", () => {
    expect(
      trustedPublisherRepositoryUri({
        username: "ebey",
        repository: "counter",
        workflow: "publish.yml",
      }),
    ).toBe("https://github.com/ebey/counter");
  });
});

describe("provenance findings", () => {
  const base = {
    manifest: { name: "@ebey.dev/counter", version: "3.0.0" } as any,
    archiveSha1: null,
    recordName: "counter",
  };

  function findings(args: {
    provenance: AtpmProvenanceState;
    archiveSha512?: string | null;
    trustPublisher?: AtpmTrustPublisher | null;
    baseline?: AtpmVersion | null;
    baselineArchiveSha512?: string | null;
    declaredName?: string;
  }) {
    return atpmRecordFindings({
      ...base,
      entry: version({
        provenance: args.provenance,
        ...(args.declaredName ? { declaredName: args.declaredName } : {}),
      }),
      archiveSha512: args.archiveSha512 ?? null,
      trustPublisher: args.trustPublisher ?? null,
      baseline: args.baseline ?? null,
      baselineArchiveSha512: args.baselineArchiveSha512 ?? null,
    }).filter((finding) => finding.ruleId?.startsWith("atpm."));
  }

  test("flags an attestation that does not verify", () => {
    const [finding] = findings({ provenance: { status: "invalid", reason: "bad signature" } });
    expect(finding.ruleId).toBe("atpm.provenance-invalid");
    expect(finding.severity).toBe("high");
    expect(finding.evidence).toContain("bad signature");
  });

  test("flags a valid attestation that describes different bytes", async () => {
    const state = await verifiedFixture();
    const found = findings({
      provenance: state,
      archiveSha512: "ab".repeat(64),
      declaredName: "sigstore",
    });
    const mismatch = found.find((f) => f.ruleId === "atpm.provenance-subject-mismatch");
    expect(mismatch?.severity).toBe("critical");
    expect(mismatch?.evidence).toContain("attested sha512");
  });

  test("flags a valid attestation copied from another package", async () => {
    const state = await verifiedFixture();
    const found = findings({
      provenance: state,
      archiveSha512: SUBJECT_SHA512,
      declaredName: "@ebey.dev/counter",
    });
    const mismatch = found.find((f) => f.ruleId === "atpm.provenance-subject-mismatch");
    expect(mismatch?.evidence).toContain(atpmPurl("@ebey.dev/counter", "3.0.0"));
  });

  test("stays silent when the sandbox never computed a digest", async () => {
    const state = await verifiedFixture();
    const found = findings({ provenance: state, archiveSha512: null, declaredName: "sigstore" });
    expect(found.map((f) => f.ruleId)).not.toContain("atpm.provenance-subject-mismatch");
  });

  test("flags a build from outside the declared trusted publisher", async () => {
    const state = await verifiedFixture();
    const found = findings({
      provenance: state,
      archiveSha512: SUBJECT_SHA512,
      declaredName: "sigstore",
      trustPublisher: publisher({
        github: { username: "attacker", repository: "fork", workflow: "release.yml" },
      }),
    });
    const mismatch = found.find((f) => f.ruleId === "atpm.provenance-publisher-mismatch");
    expect(mismatch?.severity).toBe("high");
    expect(mismatch?.evidence).toContain("https://github.com/attacker/fork");
  });

  test("flags a build whose certificate does not authenticate the declared workflow", async () => {
    const state = await verifiedFixture();
    if (state.status !== "verified") throw new Error("fixture must verify");
    const found = findings({
      provenance: { status: "verified", provenance: { ...state.provenance, workflowPath: null } },
      archiveSha512: SUBJECT_SHA512,
      declaredName: "sigstore",
      trustPublisher: publisher(),
    });
    const mismatch = found.find((f) => f.ruleId === "atpm.provenance-publisher-mismatch");
    expect(mismatch?.severity).toBe("high");
    expect(mismatch?.evidence).toContain("no certificate-authenticated workflow identity");
  });

  test("notes a declared trusted publisher with no attestation on the release", () => {
    const [finding] = findings({ provenance: { status: "absent" }, trustPublisher: publisher() });
    expect(finding.ruleId).toBe("atpm.provenance-missing");
    expect(finding.severity).toBe("low");
  });

  test("says nothing about an unattested release with no declaration", () => {
    expect(findings({ provenance: { status: "absent" } })).toEqual([]);
  });

  test("flags provenance the previous release had and this one does not", async () => {
    const state = await verifiedFixture();
    const [finding] = findings({
      provenance: { status: "absent" },
      baseline: version({ declaredName: "sigstore", provenance: state }),
      baselineArchiveSha512: SUBJECT_SHA512,
    });
    expect(finding.ruleId).toBe("atpm.trusted-publishing-lost");
    expect(finding.severity).toBe("medium");
    expect(finding.evidence).toContain("https://github.com/sigstore/sigstore-js");
  });

  test("treats equivalent GitHub repository URI spellings as the same publisher", async () => {
    const state = await verifiedFixture();
    if (state.status !== "verified") throw new Error("fixture must verify");
    expect(
      findings({
        provenance: {
          status: "verified",
          provenance: {
            ...state.provenance,
            sourceRepository: "https://github.com/Sigstore/Sigstore-JS.git/",
          },
        },
        archiveSha512: SUBJECT_SHA512,
        declaredName: "sigstore",
        baseline: version({ declaredName: "sigstore", provenance: state }),
        baselineArchiveSha512: SUBJECT_SHA512,
      }).map((finding) => finding.ruleId),
    ).not.toContain("atpm.trusted-publishing-lost");
  });

  test("does not trust baseline provenance copied from another artifact", async () => {
    const state = await verifiedFixture();
    expect(
      findings({
        provenance: { status: "absent" },
        baseline: version({ declaredName: "@ebey.dev/counter", provenance: state }),
        baselineArchiveSha512: SUBJECT_SHA512,
      }).map((finding) => finding.ruleId),
    ).not.toContain("atpm.trusted-publishing-lost");
  });

  test("does not trust baseline provenance without its archive digest", async () => {
    const state = await verifiedFixture();
    expect(
      findings({
        provenance: { status: "absent" },
        baseline: version({ declaredName: "sigstore", provenance: state }),
        baselineArchiveSha512: null,
      }).map((finding) => finding.ruleId),
    ).not.toContain("atpm.trusted-publishing-lost");
  });

  test("does not read an unevaluated version as a regression", async () => {
    const state = await verifiedFixture();
    expect(
      findings({
        provenance: { status: "not-evaluated" },
        baseline: version({ provenance: state }),
      }),
    ).toEqual([]);
  });

  test("does not report a loss when the baseline had nothing to lose", () => {
    expect(
      findings({
        provenance: { status: "absent" },
        baseline: version({ provenance: { status: "absent" } }),
      }),
    ).toEqual([]);
  });
});

const FULCIO_INTERMEDIATE_PEM = `-----BEGIN CERTIFICATE-----
MIICGjCCAaGgAwIBAgIUALnViVfnU0brJasmRkHrn/UnfaQwCgYIKoZIzj0EAwMw
KjEVMBMGA1UEChMMc2lnc3RvcmUuZGV2MREwDwYDVQQDEwhzaWdzdG9yZTAeFw0y
MjA0MTMyMDA2MTVaFw0zMTEwMDUxMzU2NThaMDcxFTATBgNVBAoTDHNpZ3N0b3Jl
LmRldjEeMBwGA1UEAxMVc2lnc3RvcmUtaW50ZXJtZWRpYXRlMHYwEAYHKoZIzj0C
AQYFK4EEACIDYgAE8RVS/ysH+NOvuDZyPIZtilgUF9NlarYpAd9HP1vBBH1U5CV7
7LSS7s0ZiH4nE7Hv7ptS6LvvR/STk798LVgMzLlJ4HeIfF3tHSaexLcYpSASr1kS
0N/RgBJz/9jWCiXno3sweTAOBgNVHQ8BAf8EBAMCAQYwEwYDVR0lBAwwCgYIKwYB
BQUHAwMwEgYDVR0TAQH/BAgwBgEB/wIBADAdBgNVHQ4EFgQU39Ppz1YkEZb5qNjp
KFWixi4YZD8wHwYDVR0jBBgwFoAUWMAeX5FFpWapesyQoZMi0CrFxfowCgYIKoZI
zj0EAwMDZwAwZAIwPCsQK4DYiZYDPIaDi5HFKnfxXx6ASSVmERfsynYBiX2X6SJR
nZU84/9DZdnFvvxmAjBOt6QpBlc4J/0DxvkTCqpclvziL6BCCPnjdlIB3Pu3BxsP
mygUY7Ii2zbdCdliiow=
-----END CERTIFICATE-----`;
