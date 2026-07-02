# Public report sharing

Completed inspections can be shared outside the organization through a read-only link, so maintainers can show a release review to consumers, stakeholders, or a README audience without a Drydock account.

## How it works

- An org owner or admin creates a share from the inspection detail page (`Share report`). The server generates a 32-byte base64url bearer token and stores only its SHA-256 hash in `scan_report_shares` (one row per scan). The raw token exists only in the returned link, mirroring the invitation-token pattern.
- The shared page lives at `/reports/{token}` and renders the same redacted canonical export served by the authenticated `report.json` download — package identity, versions, release risk, decision, and deterministic findings. Organization identity, audit events, and staged file bodies are not part of the export.
- Creating a share again rotates the token in place: every previously issued link stops resolving. `Revoke link` disables the share without deleting the audit trail. Share creation and revocation are recorded as scan events.

## API surface

| Route                                  | Auth                     | Behavior                                                                                            |
| -------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------- |
| `GET /api/v1/scans/:id/share`          | session, org member      | Share status (`active`, `createdAt`); the token is never recoverable.                               |
| `POST /api/v1/scans/:id/share`         | session, org owner/admin | Create or rotate the share; returns the raw token once. Completed scans only (409 otherwise).       |
| `DELETE /api/v1/scans/:id/share`       | session, org owner/admin | Revoke the share.                                                                                   |
| `GET /api/public/reports/:token`       | bearer token only        | Redacted canonical report export JSON (`cache-control: no-store`).                                  |
| `GET /api/public/reports/:token/badge` | bearer token only        | [Shields endpoint-badge](https://shields.io/badges/endpoint-badge) JSON reporting the release risk. |

The public routes are mounted before the auth/CSRF middleware; the unguessable token (format-checked, then hash-matched against unrevoked rows) is the trust boundary. Requests are IP rate limited and always answer `404` for malformed, unknown, or revoked tokens.

## README badge

Embed a live risk badge with Shields:

```markdown
![drydock](https://img.shields.io/endpoint?url=https%3A%2F%2Fdrydock.org%2Fapi%2Fpublic%2Freports%2F{token}%2Fbadge)
```

Rotating or revoking the share breaks the badge (it renders Shields' error state), which is the intended failure mode.

## Boundaries

- Reports are shared unsigned; see the known gaps in [`security-model.md`](./security-model.md). Keep the export canonical and future-signable.
- A share must never widen beyond the report export: no staged file bodies, no organization or member identity, no npm connection state.
