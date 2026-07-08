# Public report sharing and attestations

Completed scans can be shared outside the organization as a read-only public
report, with an optional signed attestation that lets anyone verify the report
bytes came from Drydock.

## Share flow

- `POST /api/v1/scans/:id/share` (owner/admin only) creates — or returns the
  existing — public share link for a completed scan. Sharing is idempotent so a
  link that is already distributed never rotates silently.
- `DELETE /api/v1/scans/:id/share` revokes the link immediately — report and
  attestation responses are served `no-store` so no shared cache can outlive a
  revoke.
- Both actions are recorded as scan events (`scan.share_enabled`,
  `scan.share_revoked`) and surface in the organization audit log.
- The UI entry point is the **Share** button on the scan detail header; the
  public page renders at `/reports/:token`.

## Public endpoints (no auth)

Mounted at `/public` ahead of the Better Auth middleware, like `/webhooks`.
The unguessable 256-bit share token is the capability; all endpoints are
rate-limited per IP and return `404` for unknown, malformed, or revoked tokens.

- `GET /public/reports/:token` — the canonical report export
  (`drydock.report.v1`, same bytes as the authenticated
  `/api/v1/scans/:id/report.json`). Never includes file samples, scan events,
  or organization/user identifiers.
- `GET /public/reports/:token/attestation` — DSSE envelope over an in-toto v1
  Statement about the report (see below).
- `GET /public/attestation-key` — the Ed25519 public key (JWK) and its RFC 7638
  thumbprint key id.

## Attestation format

The envelope is DSSE (`payloadType: application/vnd.in-toto+json`), signed with
Ed25519 over the standard DSSE pre-authentication encoding. `payload` and `sig`
use standard base64 (the alphabet sigstore/in-toto tooling emits). The payload
is an in-toto v1 Statement:

- `subject[0].name` — `package@version` (falls back to the scan id).
- `subject[0].digest.sha256` — SHA-256 of the exact bytes served by
  `GET /public/reports/:token`.
- `predicateType` — `https://drydock.org/attestation/scan-report/v1`.
- `predicate` — scan id, package identity, risk, decision, finding count,
  report schema/digest, completion timestamp.

To verify: fetch the report bytes, hash them, compare with the subject digest,
then verify the envelope signature against `/public/attestation-key` (match by
`keyid`).

## Key management

The signing key is the `ATTESTATION_SIGNING_KEY_JWK` secret — a private
Ed25519 JWK (`kty: OKP`). Generate one with:

```sh
node -e "crypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']).then(async k=>console.log(JSON.stringify(await crypto.subtle.exportKey('jwk',k.privateKey))))"
```

When the secret is absent or malformed the attestation endpoints return `503`;
report sharing itself keeps working. Rotating the key changes the published
`keyId`; envelopes issued under the old key stop verifying against the new
published key, so consumers should pin envelopes to the `keyid` they were
issued with.

## Trust boundaries

- Sharing is an explicit, elevated (owner/admin) opt-in per scan; there is no
  org-wide "share everything" switch.
- The public payload is the canonical export only — redaction is inherited from
  the report contract, not re-implemented on the public path.
- Public routes carry the locked-down API CSP and permissive CORS (`*`) — the
  data is public by construction once shared.
- Tests: `test/workers/public-reports.test.ts` (routes, roles, revocation,
  redaction, rate limit, signature verification).
