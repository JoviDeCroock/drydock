# Release Receipt v1

A release receipt binds a completed scan's canonical report to release-decision and workflow-control evidence. **Authority:** internal. **Owner:** `server/lib/scan/release-receipt.ts`.

## At a glance

| Thing | Owner file | Who may call / trigger | Pinned by (test) |
| --- | --- | --- | --- |
| Receipt download | `server/routes/scans/sharing.ts` | Authenticated organization member | `test/workers/release-receipt.test.ts` |
| Content address and evidence | `server/lib/scan/release-receipt.ts` | Completed scan export | `test/workers/release-receipt.test.ts` |
| Canonical serialization | `server/lib/platform/canonical-json.ts` | Report, receipt, stored scan artifacts | `test/workers/release-receipt.test.ts` |
| Report and public DSSE attestation | [Public reports](./public-reports.md) | Existing report/share contracts | `test/workers/public-reports.test.ts` |

## Contract

| Method | Path | Auth/role | Owner |
| --- | --- | --- | --- |
| GET | `/api/v1/scans/:id/release-receipt.json[?organizationId=...]` | Better Auth session; membership in the selected organization | `server/routes/scans/sharing.ts` |

| Document field / response | Meaning | Owner |
| --- | --- | --- |
| `schema` | `drydock.release-receipt.v1`; `RELEASE_RECEIPT_SCHEMA` | `server/lib/scan/release-receipt.ts` |
| `address` | `{ algorithm: "sha256", value: <hex> }` over the exact canonical bytes of `content` | `server/lib/scan/release-receipt.ts` |
| `content.report.schema` | `drydock.report.v2`; `REPORT_EXPORT_SCHEMA` | `server/lib/scan/report-export.ts` |
| `content.report.digest` | SHA-256 algorithm/value reference to exact canonical `report.json` bytes for the same scan state | `server/lib/scan/release-receipt.ts` |
| `content.release` | Scan id, stage id, package coordinates, source, mode, risk, decision outcome/time, authenticated Drydock reviewer id when available | `server/lib/scan/release-receipt.ts` |
| `mode` | `workflow_gate` only for gate scans; other sources, including manual and auto-discovered registry stages, use `staged_publish` | `server/lib/scan/release-receipt.ts` |
| `x-drydock-receipt-sha256` | SHA-256 of exact full response bytes | `server/routes/scans/sharing.ts` |
| `ETag` | `"sha256:<full-response-digest>"` | `server/routes/scans/sharing.ts` |
| Download filename | `drydock-release-receipt-<sanitized-scan-id>-<full-response-digest>.json` | `server/lib/scan/release-receipt.ts` |
| `Cache-Control` | `private, no-store` | `server/routes/scans/sharing.ts` |

### Control evidence

| Mode | `classification` | `scope` | `enforcedBy` | `enforcementScope` |
| --- | --- | --- | --- | --- |
| `workflow_gate` | `workflow_enforced` | `configured_publish_workflow` | `github_deployment_protection_rule` | `configured_environment_job` |
| `staged_publish` | `advisory` | `registry_stage_observation` | `null` | `null` |

GitHub enforces only the configured Environment job; see [workflow gates](./workflow-gates.md). Stage Watchtower is advisory; see [npm staged publishing](./npm-staged-publishing.md) and [atpm](./atpm.md).

### Evidence states

All builders below live in `server/lib/scan/release-receipt.ts`.

| `content.evidence` field | State contract |
| --- | --- |
| `report` | `complete`: report reference is present. |
| `reviewedArtifacts` | Validated workflow artifact SHA-256 provenance or staged registry-declared/computed SHA-1; missing legacy evidence → `unknown`; unverified staged digest → `partial`; validated mismatch → `conflicting`. |
| `intentBinding` | Validated intent envelope → `complete`, including explicit `absent` tier; missing/malformed persisted envelope → `unknown`. |
| `releaseDecision` | Outcome, decision time, and reviewer all present → `complete`; some present → `partial`; none → `unknown`. |
| `workflowGate` | Approved/rejected gate with decision/time → `complete`; pending/errored → `partial`; absent row → `unknown`; staged review → `not_applicable`. |
| `workflowGate.callback` | Outcome always `unknown` in v1; callback success/failure is not durably persisted. A stored gate decision does not prove GitHub received it. |
| `gateContinuity` | `matched` → `complete`; `digest-mismatch` / `gate-not-approved` → `conflicting`; `ungated` / `unverified` → `partial`; `unknown` → `unknown`; absent record or gate receipt → `not_applicable`. |
| `registryOutcome` | Persisted staged-registry status plus observation time → `complete`; unobserved workflow-gate/unsupported/failed/legacy lookup → `unknown`. |
| Aggregate `status` | Any required `conflicting` → `conflicting`; all required fields `complete` / `not_applicable` → `complete`; otherwise `partial`. Registry outcome is independent and excluded. |

| Gate-continuity evidence | Meaning |
| --- | --- |
| `matched` | Staged SHA-256, confirmed against npm's stage record, equals an approved organization gate review's provenance digest; validated record names gate scan, gate identity, and decision. |
| `ungated` / `unverified` | Partial evidence for an organization-gated package, with or without a review to name. |
| `unknown` | Check could not run for an organization with a live npm-capable release target: gate history unreadable or npm stage record unavailable. |
| `not_applicable` | Gate receipt or package the organization does not gate. |
| Disclosure | Full identity is authenticated-only in receipt and scan page; public-shareable `report.json` carries status, reason, and both digests. |
| Authority | Gate evidence is second-hand; staged receipt control remains `advisory`. |

### Digest verification

1. Canonicalize `content` with `canonicalJson` in `server/lib/platform/canonical-json.ts`: keys sorted by UTF-16 code unit, undefined object fields omitted, no presentation whitespace.
2. SHA-256 those bytes and compare with `address.value`.
3. SHA-256 the referenced canonical `report.json` bytes and compare with `content.report.digest.value`.
4. SHA-256 the full receipt response bytes and compare with `x-drydock-receipt-sha256`, `ETag`, and filename.

## Invariants

1. No public-share receipt route exists in v1; gate identity and control-plane state never widen the public share capability (`server/routes/scans/sharing.ts`; [public reports](./public-reports.md)).
2. Receipts do not replace, embed, sign, or alter `drydock.report.v2` or its DSSE attestation (`server/lib/scan/release-receipt.ts`).
3. Full-response digests stay outside the document to avoid recursive self-hashing (`server/routes/scans/sharing.ts`).
4. Serialization uses the RFC 8785/JCS UTF-16 key-order rule, independent of locale; non-BMP keys must not use code-point order (`server/lib/platform/canonical-json.ts`). JS string `<` and Java/.NET ordinal string comparison implement that ordering.
5. `classification` and `scope` retain their v1 values; additive evidence/control fields participate in the content address (`server/lib/scan/release-receipt.ts`).
6. Receipts reflect current persisted state, rather than immutable snapshots; downloading again may change `address`, while archived receipts verify against their own content (`server/lib/scan/release-receipt.ts`). Archive receipt and report together.
7. Receipts are unsigned; only existing public-report attestations sign exact report bytes ([public reports](./public-reports.md)).
8. Staged npm SHA-1 integrity proves byte continuity against the registry record, not new SHA-256 provenance (`server/lib/scan/release-receipt.ts`).
9. Authenticated publication-monitor observations, including npm-gate comparisons, are not embedded in v1 receipts ([publication monitor](./publication-monitor.md)).

10. GitHub holds Environment-targeted jobs until Drydock answers and fails them on rejection; Drydock holds nothing itself (`server/lib/scan/release-receipt.ts`; [workflow gates](./workflow-gates.md)).
11. A repository admin can remove the rule or bypass it unless the Environment's default-on “Allow administrators to bypass configured protection rules” option is unchecked ([workflow gates](./workflow-gates.md)).
12. The reviewed-byte `sha256sum --check` runs in a repository-controlled job; tokens and interactive npm publishing remain outside the gate. Neither classification claims registry-wide enforcement ([workflow gates](./workflow-gates.md)).
13. Advisory means no party enforces the Drydock decision: the maintainer approves the stage independently in npm or atpm (`server/lib/scan/release-receipt.ts`).
14. Workflow-gate evidence supplies organization-scoped repository, run, environment, durable status, decision, and time (`server/lib/scan/release-receipt.ts`).

## Failure modes

| Symptom/condition | Cause | What happens | Fix |
| --- | --- | --- | --- |
| `404` | Missing scan or organization ownership | Receipt withheld | Select an organization containing the scan. |
| `409` | Scan is not complete | `release receipt is only available for completed scans` | Wait for completion. |
| Digest differs | Different persisted state or serializer | Address/report comparison fails | Archive matching receipt/report; use UTF-16 canonical key ordering. |
| Aggregate `partial` | Required legacy, decision, or control evidence missing | Evidence stays incomplete | Inspect per-field states; do not infer missing evidence. |
| Callback `unknown` | No durable callback-attempt/result record | Delivery is unproven | Do not treat stored gate approval as delivery proof. |

## Change checklist

| If you change X | Also update Y | Run Z |
| --- | --- | --- |
| Receipt fields, evidence status, or digest serialization | Receipt contract and report compatibility | `pnpm exec vitest run --project workers test/workers/release-receipt.test.ts` |
| Public report disclosure | [Public reports](./public-reports.md); keep receipt identity authenticated | `pnpm exec vitest run --project workers test/workers/public-reports.test.ts` |
