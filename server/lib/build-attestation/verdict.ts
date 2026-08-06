/**
 * The verdict: compare what an attestation *claims* against what Drydock
 * *independently knows*, and grade the agreement.
 *
 * The design decision worth stating plainly: the load-bearing evidence here is
 * not the Sigstore PKI, it is the cross-check. At a workflow gate, Drydock
 * already holds a repository + run binding that arrived on a signature-verified
 * GitHub webhook, and artifact digests it recomputed itself from the immutable
 * Actions bytes. None of that is claimed by the package. An attestation that
 * agrees with all of it is corroborated by an independent channel; an
 * attestation that disagrees is a contradiction worth surfacing loudly — and
 * neither conclusion needs a certificate chain to reach.
 *
 * That is why full Sigstore verification (Fulcio chain, SCTs, Rekor inclusion)
 * is deliberately out of scope for this layer rather than quietly missing. See
 * `docs/build-attestation.md`.
 */

import { parseSigstoreBundle, verifyDsseSignature } from "./dsse";
import { parseInTotoStatement } from "./statement";
import type {
  AttestationBinding,
  BuildAttestation,
  BuildAttestationCheck,
  BuildClaim,
} from "./types";

// A release publishes a handful of attestations at most (build provenance plus
// a publish attestation per artifact). This cap bounds the signature
// verification work a hostile attestation store can ask for.
const MAX_BUNDLES = 32;

/**
 * Bundles as returned by an attestation source.
 *
 * Contract: `bundles` must be what the source returned when asked about
 * `binding.artifactDigests` specifically. Both wired sources query by digest,
 * so a returned bundle that covers none of those digests is the store
 * answering about the wrong bytes — which is why that case grades `mismatch`
 * rather than being filtered out as irrelevant. A future source that lists a
 * repository's attestations wholesale would need different handling.
 */
export type AttestationLookup =
  | { status: "ok"; bundles: unknown[] }
  | { status: "failed"; reason: string };

const NO_ATTESTATION_CEILING = "none" as const;

/**
 * Grade the attestation evidence for one review candidate. Pure: every input is
 * already-fetched data, and the result is advisory — it never feeds risk or
 * findings.
 */
export async function evaluateBuildAttestation(
  lookup: AttestationLookup,
  binding: AttestationBinding,
): Promise<BuildAttestation> {
  if (lookup.status === "failed") {
    return {
      status: "unavailable",
      claim: null,
      checks: [
        { kind: "subject-digest", result: "skipped", detail: `lookup failed: ${lookup.reason}` },
      ],
      trustCeiling: NO_ATTESTATION_CEILING,
    };
  }

  if (!lookup.bundles.length) {
    return {
      status: "absent",
      claim: null,
      checks: [
        {
          kind: "subject-digest",
          result: "skipped",
          detail: "no build attestation published for the reviewed bytes",
        },
      ],
      trustCeiling: NO_ATTESTATION_CEILING,
    };
  }

  const digests = new Set(
    binding.artifactDigests
      .map((digest) => digest.trim().toLowerCase())
      .filter((digest) => /^[0-9a-f]{64}$/.test(digest)),
  );

  const candidates: BuildAttestation[] = [];
  let parsedAny = false;
  for (const bundle of lookup.bundles.slice(0, MAX_BUNDLES)) {
    const envelope = parseSigstoreBundle(bundle);
    if (!envelope) continue;
    const claim = parseInTotoStatement(envelope.payload);
    if (!claim) continue;
    parsedAny = true;
    candidates.push(await gradeClaim(claim, envelope, digests, binding));
  }

  if (!parsedAny) {
    return {
      status: "unavailable",
      claim: null,
      checks: [
        {
          kind: "subject-digest",
          result: "skipped",
          detail: "attestation returned but no readable in-toto statement inside it",
        },
      ],
      trustCeiling: NO_ATTESTATION_CEILING,
    };
  }

  // A contradiction dominates: if any attestation covering this release
  // disagrees with Drydock's own binding, reporting a different, agreeable one
  // instead would hide exactly the signal this feature exists to surface.
  const contradiction = candidates.find((candidate) => candidate.status === "mismatch");
  if (contradiction) return contradiction;

  const rank = { verified: 0, partial: 1 } as Record<string, number>;
  return candidates.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9))[0];
}

async function gradeClaim(
  claim: BuildClaim,
  envelope: NonNullable<ReturnType<typeof parseSigstoreBundle>>,
  digests: ReadonlySet<string>,
  binding: AttestationBinding,
): Promise<BuildAttestation> {
  const checks: BuildAttestationCheck[] = [];

  const covered = claim.subjectDigests.filter((digest) => digests.has(digest));
  if (covered.length) {
    // State the coverage fraction rather than just "it matched". One attestation
    // covering one wheel of a thirty-wheel release is a true `pass` — the bytes
    // it names really were reviewed — but reading it as "this release is
    // attested" would be wrong, and a bare digest in the detail invites exactly
    // that reading.
    const total = digests.size;
    const scope =
      covered.length === total
        ? `all ${total} reviewed artifact${total === 1 ? "" : "s"}`
        : `${covered.length} of ${total} reviewed artifacts`;
    checks.push({
      kind: "subject-digest",
      result: "pass",
      detail: `attests ${scope} (sha256:${covered[0]}), digests Drydock recomputed from the reviewed bytes`,
    });
  } else {
    checks.push({
      kind: "subject-digest",
      result: "fail",
      detail: claim.subjectDigests.length
        ? `attests sha256:${claim.subjectDigests[0]}, which is not among the reviewed artifacts`
        : "attests no sha256 digest, so it cannot be tied to the reviewed bytes",
    });
  }

  const expectedRepository = `https://github.com/${binding.repositoryFullName}`;
  checks.push(
    compare({
      kind: "repository",
      claimed: claim.repository,
      expected: expectedRepository,
      absentDetail: "attestation names no source repository",
      passDetail: (value) => `built from ${value}, matching the repository the gate bound`,
      failDetail: (value) => `claims ${value} but the signed webhook bound ${expectedRepository}`,
    }),
  );

  checks.push(
    compare({
      kind: "workflow-run",
      claimed: claim.runId,
      expected: String(binding.runId),
      absentDetail: "attestation names no workflow run",
      passDetail: (value) => `built by run ${value}, matching the run the gate bound`,
      failDetail: (value) =>
        `claims run ${value} but the signed webhook bound run ${binding.runId}`,
    }),
  );

  const headSha = binding.headSha?.trim().toLowerCase() || null;
  checks.push(
    compare({
      kind: "source-commit",
      claimed: claim.commit,
      expected: headSha,
      absentDetail: headSha
        ? "attestation names no source commit"
        : "run head commit was not resolved, so there is nothing to compare",
      passDetail: (value) => `built from commit ${value}, matching the run's head commit`,
      failDetail: (value) => `claims commit ${value} but the run's head commit is ${headSha}`,
    }),
  );

  const signature = await verifyDsseSignature(envelope);
  checks.push({
    kind: "signature",
    result: signature.verified ? "pass" : "fail",
    detail: signature.verified
      ? `DSSE signature verified against the bundle's certificate key (${signature.algorithm})`
      : `signature not verified: ${signature.reason}`,
  });

  const failed = (kind: BuildAttestationCheck["kind"]) =>
    checks.some((check) => check.kind === kind && check.result === "fail");
  const passed = (kind: BuildAttestationCheck["kind"]) =>
    checks.some((check) => check.kind === kind && check.result === "pass");

  // A contradiction on any binding Drydock holds independently.
  const contradicted =
    failed("subject-digest") ||
    failed("repository") ||
    failed("workflow-run") ||
    failed("source-commit");

  if (contradicted) {
    return { status: "mismatch", claim, checks, trustCeiling: NO_ATTESTATION_CEILING };
  }

  // `verified` requires a positive agreement with an independently-held fact,
  // not merely the absence of disagreement. An attestation that covers the
  // right bytes but names no repository or run has nothing to corroborate.
  const corroborated = passed("repository") || passed("workflow-run");
  if (corroborated && passed("signature")) {
    return { status: "verified", claim, checks, trustCeiling: "self-consistent" };
  }
  return {
    status: "partial",
    claim,
    checks,
    trustCeiling: passed("signature") ? "self-consistent" : NO_ATTESTATION_CEILING,
  };
}

interface CompareArgs {
  kind: BuildAttestationCheck["kind"];
  claimed: string | null;
  expected: string | null;
  absentDetail: string;
  passDetail: (value: string) => string;
  failDetail: (value: string) => string;
}

/**
 * Compare one claimed value against one independently-held value. A missing
 * value on either side is `skipped`, never `fail`: asserting that an
 * attestation contradicts Drydock requires two values that both exist, the same
 * rule `evaluateStagedArtifactIntegrity` follows for digests.
 */
function compare(args: CompareArgs): BuildAttestationCheck {
  if (!args.claimed || !args.expected) {
    return { kind: args.kind, result: "skipped", detail: args.absentDetail };
  }
  if (args.claimed === args.expected) {
    return { kind: args.kind, result: "pass", detail: args.passDetail(args.claimed) };
  }
  return { kind: args.kind, result: "fail", detail: args.failDetail(args.claimed) };
}
