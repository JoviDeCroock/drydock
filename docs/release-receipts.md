# Release Receipt v1

A release receipt is a canonical, hash-addressed control record for one completed
scan. It composes the existing canonical report evidence with release-decision
and workflow-control evidence; it does not replace, embed, sign, or alter
`drydock.report.v2` or its public DSSE attestation.

## Endpoint and access

`GET /api/v1/scans/:id/release-receipt.json[?organizationId=...]` is an
authenticated, organization-scoped download adjacent to `report.json`. It is
available only for completed scans and returns `private, no-store`.

There is intentionally no public-share receipt route in v1. Public share tokens
continue to expose only the canonical report export and its existing optional
attestation. Gate identity and control-plane state therefore do not widen the
public capability boundary.

## Canonical document

The schema tag is `drydock.release-receipt.v1`. Serialization uses the shared
stable JSON primitive: object keys are sorted, undefined fields are omitted, and
no presentation whitespace is added.

- `address` is SHA-256 hex of the exact canonical bytes of `content`. Consumers
  verify it by stable-serializing `content` and hashing those bytes.
- `content.report.schema` identifies `drydock.report.v2`.
- `content.report.digest` is SHA-256 hex of the exact canonical `report.json`
  bytes returned for the same scan state. This is a reference to the report,
  not a second report attestation.
- `x-drydock-receipt-sha256`, the `ETag`, and the download filename carry the
  SHA-256 of the exact full receipt response bytes. This whole-document digest
  is deliberately outside the document so the receipt does not make a
  recursive self-hash claim.

## Evidence semantics

`content.release` records scan id, stage id, package coordinates, source, mode,
risk, and a structured decision with decision time and the authenticated Drydock reviewer id when one exists. It also states the narrow control classification: a workflow-gate receipt is `workflow_enforced` for the configured publish workflow, while a staged-publish receipt is `advisory` registry-stage observation. Neither classification claims universal registry enforcement. `mode` is `workflow_gate` only for gate scans; manual and auto-discovered registry stages are `staged_publish`.

`content.evidence` separates independent claims:

- `report` says the report reference is present.
- `reviewedArtifacts` reuses the report's validated workflow provenance
  (`sha256` per artifact) or staged artifact integrity verdict (registry-declared
  and computed SHA-1). Missing legacy evidence is `unknown`; an unverified
  staged digest is `partial`; a validated mismatch is `conflicting`.
- `intentBinding` reuses the validated intent envelope. Missing or malformed
  persisted data is `unknown`; an explicit `absent` tier is complete evidence
  that no source binding was found.
- `workflowGate` records repository, run, environment, durable gate status,
  decision, and decision time when the organization-scoped gate row exists.
  Staged reviews use `not_applicable`. Callback outcome is `unknown` in v1:
  callback success/failure is not durably persisted, and a stored gate decision
  is not proof GitHub received it.
- `registryOutcome` records the registry status and observation time only when a
  status was observed. It remains `unknown` for workflow gates, unsupported
  registries, failed lookups, and legacy scans.

The aggregate evidence status covers evidence required by the selected mode.
Registry outcome is reported independently because an unobserved post-review
registry state does not make the review evidence incomplete.

## Limitations

- v1 receipts are generated from current persisted state rather than stored as
  immutable snapshots. Archive the receipt and referenced report together.
- Receipts are unsigned. Existing signed public-report attestations remain the
  only signing path and cover only exact report bytes.
- Callback delivery outcome is unknown until a durable callback-attempt/result
  record exists.
- Staged npm integrity currently follows the registry's SHA-1 record; it is byte
  continuity against that registry record, not a new SHA-256 provenance claim.
- Registry observation is currently the persisted staged-registry lifecycle
  status; workflow-gate registries do not yet feed a post-publish observation.
