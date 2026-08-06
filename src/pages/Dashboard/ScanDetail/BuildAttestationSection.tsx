import type { BuildAttestation, BuildAttestationStatus } from "../../../../server/types";
import { Badge, type BadgeTone } from "../../../components/Badge";
import { SectionLabel } from "../../../components/Typography";

// Advisory build-provenance row, rendered under the source-binding row it
// complements: the envelope says *what the release is bound to*, this says
// *what the build claims, and whether that claim survives comparison*.
//
// The verdict never changes risk, so tones stay informational — with one
// exception. `mismatch` is the only state that asserts a contradiction between
// an attestation and a binding Drydock authenticated itself, and it earns a
// severity tone because a maintainer who scrolls past it has missed the point
// of the section. Scans with no verdict (staged publishes, pre-feature scans)
// render nothing; the parent passes null.
export function BuildAttestationSection({ attestation }: { attestation: BuildAttestation }) {
  const claim = attestation.claim;
  return (
    <section class="flex flex-col gap-3 min-w-0">
      <SectionLabel as="h2">Build provenance</SectionLabel>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Badge tone={statusTone(attestation.status)}>{attestation.status}</Badge>
        <span class="text-[13px] leading-[1.55] text-ink-muted min-w-0">
          {statusDescription(attestation)}
        </span>
      </div>

      {claim ? (
        <ul class="list-none p-0 m-0 flex flex-col gap-2">
          {claimRows(claim).map((row) => (
            <li key={row.label} class="grid grid-cols-[132px_minmax(0,1fr)] gap-3 text-[13px]">
              <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
                {row.label}
              </span>
              <span class="min-w-0 text-ink-muted break-words">{row.value}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {attestation.checks.length ? (
        <ul class="list-none p-0 m-0 flex flex-col gap-2">
          {attestation.checks.map((check, index) => (
            <li
              key={`${check.kind}-${index}`}
              class="grid grid-cols-[132px_minmax(0,1fr)] gap-3 text-[13px]"
            >
              <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
                {check.kind}
              </span>
              <span class="min-w-0 break-words">
                <Badge tone={checkTone(check.result)}>{check.result}</Badge>{" "}
                <span class="text-ink-muted">{check.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {attestation.status === "verified" ? (
        <p class="text-[12px] leading-[1.55] text-ink-subtle m-0">
          Drydock checks the attestation against bindings it holds independently of the package. It
          does not validate the Sigstore certificate chain or transparency-log inclusion, so this
          confirms the build claim agrees with the gate — not that a public trust root vouches for
          the signer.
        </p>
      ) : null}
    </section>
  );
}

function statusTone(status: BuildAttestationStatus): BadgeTone {
  if (status === "verified") return "ok";
  if (status === "mismatch") return "high";
  if (status === "partial") return "info";
  return "neutral";
}

function checkTone(result: "pass" | "fail" | "skipped"): BadgeTone {
  if (result === "pass") return "ok";
  if (result === "fail") return "high";
  return "neutral";
}

function statusDescription(attestation: BuildAttestation): string {
  switch (attestation.status) {
    case "verified":
      return "A signed build attestation covers these bytes and agrees with the repository and run the gate bound.";
    case "partial":
      return "A build attestation covers these bytes and contradicts nothing, but it could not be fully corroborated.";
    case "mismatch":
      return "A build attestation for this release disagrees with what the signed webhook bound. Review before releasing.";
    case "absent":
      return "This release publishes no build attestation. Byte continuity from CI is still recorded under Provenance.";
    case "unavailable":
      return "The build attestation could not be looked up. Absence of evidence, not evidence of a problem.";
  }
}

interface ClaimRow {
  label: string;
  value: string;
}

function claimRows(claim: NonNullable<BuildAttestation["claim"]>): ClaimRow[] {
  const rows: ClaimRow[] = [{ label: "predicate", value: claim.predicateType }];
  if (claim.repository) rows.push({ label: "repository", value: claim.repository });
  if (claim.workflowPath) rows.push({ label: "workflow", value: claim.workflowPath });
  if (claim.ref) rows.push({ label: "ref", value: claim.ref });
  if (claim.commit) rows.push({ label: "commit", value: claim.commit });
  if (claim.runId) {
    rows.push({
      label: "run",
      value: claim.runAttempt ? `${claim.runId} (attempt ${claim.runAttempt})` : claim.runId,
    });
  }
  if (claim.builderId) rows.push({ label: "builder", value: claim.builderId });
  return rows;
}
