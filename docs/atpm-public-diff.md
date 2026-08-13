# atpm on the public diff

[atpm](https://atpm.dev) is a package manager built on the AT Protocol. A package is a record in the publisher's own repository, its version tarballs are blobs attached to that record, and `atpm.dev` is an App View over the result — it maps names to DIDs and re-serves the same data through an npm-compatible API, so `registry=https://atpm.dev` in an `.npmrc` is enough to install.

Drydock serves atpm on `/diff` (`ecosystem=atpm`) and does not talk to `atpm.dev` to do it.

## Why not the App View

Reading through the App View would be a few lines: it speaks the npm registry protocol, so the existing npm public-diff adapter would nearly work as-is against a different base URL.

It would also make the diff mean less. The claim a `/diff` page makes is "these are the bytes of that release" — and routed through an App View, that claim is only as good as the App View. The protocol offers something better: every step of locating a release has its own authority, none of which is atpm.dev, so a diff resolved this way stays true whether or not the App View is up, agrees, or is honest. That property is the interesting thing about a distributed package manager, and it is worth spending code to keep.

The exchange is that Drydock now depends on the lexicon rather than on an HTTP API. `dev.atpm.alpha.package` is alpha, and the version in its name is a promise that it will change. When it does, `server/lib/ecosystems/atpm/record.ts` is what changes; nothing above it knows the record shape.

## Resolution

Every hop is a protocol mechanism, verified in `server/lib/ecosystems/atpm/identity.ts` and `record.ts`:

| Step             | Mechanism                                                                                          | Authority                                    |
| ---------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Handle → DID     | DNS TXT `_atproto.<handle>` over DoH, falling back to `https://<handle>/.well-known/atproto-did`   | DNS, or the publisher's web server           |
| DID → document   | `https://plc.directory/<did>` for `did:plc`, `https://<domain>/.well-known/did.json` for `did:web` | The PLC directory, or the publisher's domain |
| Document → PDS   | `service[]` entry with an `#atproto_pds` id and type `AtprotoPersonalDataServer`                   | The DID's controller                         |
| PDS → record     | `com.atproto.repo.getRecord`, collection `dev.atpm.alpha.package`, rkey = unscoped name            | The publisher's PDS                          |
| Record → tarball | `com.atproto.sync.getBlob` at the version entry's blob CID                                         | Content address                              |

Workers have no DNS resolver, so the TXT lookup goes over DNS-over-HTTPS through Cloudflare's public resolver. That is infrastructure for the lookup, not a party to the naming: it answers the same query any resolver would, and a wrong answer still has to survive the bidirectional check below.

Two checks are load-bearing:

- **Bidirectional handle verification.** A handle is only that account's handle if the DID document claims it back in `alsoKnownAs`. Without it, any domain could point `_atproto` at someone else's DID and serve their packages under its own name.
- **Subject match.** A DID document must have `id` equal to the DID it was fetched for. `did:web` in particular is just a file on a web server.

A DID-addressed lookup reports no handle at all rather than repeating the document's `alsoKnownAs` claim, which that lookup did not verify.

## Addressing

Both forms name the same package and both work everywhere a package name is accepted:

- `@<handle>/<name>` — the npm name, e.g. `@ebey.dev/counter`. `/diff/atpm/@ebey.dev/counter/0.0.14/0.0.15`.
- `did:plc:<id>/<name>` or `did:web:<domain>/<name>` — identity-pinned, and what atpm.dev's own package pages use. `/diff/atpm/did:plc:twegdcgytckr5cxm57gyruxa/counter/0.0.14/0.0.15`.

Prefer the DID form for links minted by a tool that already knows the publisher. A handle is a rented name: it can move to another account, and a handle-addressed diff follows the name to wherever it points now. Version-pair results are cached for 30 days keyed on the name as addressed, so a handle transfer can leave a previously-computed handle-form pair describing the old account for up to that long. The DID form has no such window. (Identity and record lookups themselves are cached for minutes, not days, so version listings track a transfer promptly.)

Handles fold to lowercase; the record key never does, because atproto record keys are case-sensitive and folding them would let two distinct records share one cache entry.

## What is checked, beyond the npm rules

An atpm version is an ordinary npm tarball, so it runs the npm deterministic rule set unchanged.

atpm also splits apart two things npm keeps together. `meta` in the record is a manifest the publisher wrote; the blob is the artifact that installs. A client reads the former and runs the latter. `server/lib/ecosystems/atpm/findings.ts` checks them against each other:

- `stage.tarball-digest-mismatch` — the blob's SHA-1 (computed by the sandbox over the wire bytes) disagrees with the record's `dist.shasum`. Fails to silent, never to "mismatch", when either digest is absent.
- `stage.metadata-mismatch` — the record's `meta.name` / `meta.version` / version key disagrees with the tarball's `package.json`, or the manifest's unscoped name is not the record key it was published under.

The blob CID is not re-verified: it is the address the bytes were fetched by, so a PDS cannot substitute them without the request failing. What these findings cover is the layer above, where the record makes claims the CID does not bind.

`meta.dist.tarball` is never followed. It is a publisher-written string in publisher-written data, and following it would let a record name any host on the internet as the source of the bytes Drydock then presents as that package's release. The blob URL is rebuilt from the resolved PDS and the CID.

## Host policy

The atpm path is the only public-diff egress whose hosts are chosen by the party under review. `assertPublicHttpsUrl` gates every one: https only, no embedded credentials, default port only, no IPv4/IPv6 literals, no loopback, no reserved internal suffixes, no single-label hostnames. Identity documents read under a 256 KiB ceiling and package records under 4 MiB. Nothing on this path holds credentials of any kind. See [`security-model.md`](./security-model.md).

A self-hosted PDS on a non-default port is the one legitimate shape this rejects. That is deliberate: allowing an arbitrary port would turn a DID document into a port prober, and atproto PDS endpoints are served on 443.

Redirects off the pinned blob URL are refused. `publicArtifactUrls` pins one exact URL, but the runtime follows 3xx transparently, so a hostile PDS could have answered the pinned request with a redirect to a host the policy never saw. `NpmStageGateway` now resolves redirects for pinned artifacts itself (`fetchPinnedArtifact` in `server/lib/sandbox.ts`): same-origin hops are followed — the origin is exactly what was vetted — and anything leaving it is a 403, with the chain bounded at three hops. Credentialed npm requests are untouched and keep the runtime's own redirect handling, so a registry that moves a staged tarball to a CDN keeps working.

## What is not built

- **No workflow gate and no staged review.** atpm has its own staging flow (`npm stage publish` / `list` / `approve`) and a trusted-publisher system; wiring Drydock into it would need atpm-side support, not just an adapter.
- **No dependency diff links.** An atpm dependency spelled `@handle/name` resolves on npm to a scope someone else owns, so the manifest diff links nothing rather than something confidently wrong.
- **No package-only `/diff/atpm/<name>` form.** Nothing links it.

## Records for reference

Live example, and what the tests are modelled on:

```
at://did:plc:twegdcgytckr5cxm57gyruxa/dev.atpm.alpha.package/counter    (@ebey.dev/counter)
```

```jsonc
{
  "$type": "dev.atpm.alpha.package",
  "tags": { "latest": "0.0.15" },
  "versions": [
    {
      "version": "0.0.15",
      "createdAt": "2026-08-13T06:28:24.000Z",
      "blob": {
        "$type": "blob",
        "ref": { "$link": "bafkrei…" },
        "size": 604,
        "mimeType": "application/gzip",
      },
      "meta": {
        "name": "@ebey.dev/counter",
        "version": "0.0.15",
        "dist": { "shasum": "…", "integrity": "sha512-…" },
      },
    },
  ],
}
```

Everything outside the fields above — the readme, the Sigstore attestation bundle, the rest of the npm manifest — is dropped at parse time. It is the bulk of a real record (~50 KB raw versus ~4 KB kept for this package) and none of it is read.
