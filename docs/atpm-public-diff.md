# atpm on the public diff

[atpm](https://atpm.dev) is a package manager built on the AT Protocol. A package is a record in the publisher's own repository, its version tarballs are blobs attached to that record, and `atpm.dev` is an App View over the result — it maps names to DIDs and re-serves the same data through an npm-compatible API, so `registry=https://atpm.dev` in an `.npmrc` is enough to install.

Drydock serves atpm on `/diff` (`ecosystem=atpm`) and does not talk to `atpm.dev` to do it.

## Why not the App View

Reading through the App View would be a few lines: it speaks the npm registry protocol, so the existing npm public-diff adapter would nearly work as-is against a different base URL.

It would also make the diff mean less. The claim a `/diff` page makes is "these are the bytes of that release" — and routed through an App View, that claim is only as good as the App View. The protocol offers something better: every step of locating a release has its own authority, none of which is atpm.dev, so a diff resolved this way stays true whether or not the App View is up, agrees, or is honest. That property is the interesting thing about a distributed package manager, and it is worth spending code to keep.

The exchange is that Drydock now depends on the lexicon rather than on an HTTP API. `dev.atpm.alpha.package` is alpha, and the version in its name is a promise that it will change. When it does, `server/lib/ecosystems/atpm/record.ts` is what changes; nothing above it knows the record shape.

## Resolution

Every hop is a protocol mechanism, verified in `server/lib/ecosystems/atpm/identity.ts` and `record.ts`:

| Step             | Mechanism                                                                                                         | Authority                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Handle → DID     | DNS TXT `_atproto.<handle>` over DoH, falling back to `https://<handle>/.well-known/atproto-did`                  | DNS, or the publisher's web server           |
| DID → document   | `https://plc.directory/<did>` for `did:plc`, `https://<domain>/.well-known/did.json` for `did:web`                | The PLC directory, or the publisher's domain |
| Document → PDS   | `service[]` entry with the exact relative or DID-qualified `#atproto_pds` id and type `AtprotoPersonalDataServer` | The DID's controller                         |
| PDS → record     | `com.atproto.repo.getRecord`, collection `dev.atpm.alpha.package`, rkey = unscoped name                           | The publisher's PDS                          |
| Record → tarball | `com.atproto.sync.getBlob` at the version entry's blob CID                                                        | Content address                              |

Workers have no DNS resolver, so the TXT lookup goes over DNS-over-HTTPS through Cloudflare's public resolver. That is infrastructure for the lookup, not a party to the naming: it answers the same query any resolver would, and a wrong answer still has to survive the bidirectional check below.

Two checks are load-bearing:

- **Bidirectional handle verification.** A handle is only that account's handle if the DID document claims it back in `alsoKnownAs`. Without it, any domain could point `_atproto` at someone else's DID and serve their packages under its own name.
- **Subject match.** A DID document must have `id` equal to the DID it was fetched for. `did:web` in particular is just a file on a web server.

A DID-addressed lookup has no handle to check, so it proves the document's own claim instead: the first `at://` entry in `alsoKnownAs` is resolved back through DNS/well-known and kept only if it returns that same DID. Same bidirectional standard, opposite direction. A claim that does not verify is dropped rather than displayed, and only the first entry is checked so a long `alsoKnownAs` cannot turn one page view into many lookups.

## Addressing

`/diff` canonicalizes to the **DID form**, and that is what a shared link carries:

```
/diff/atpm/did:plc:twegdcgytckr5cxm57gyruxa/counter/0.0.14/0.0.15
```

Typing `@ebey.dev/counter` into the form resolves the handle and redirects there, so a link uses the canonical identity spelling rather than relying on the linker to prefer a DID. A direct handle-form detail URL does the same resolution before loading either artifact and replaces itself with the DID form. A handle is a rented name — it can move to another account, and a handle-form URL would otherwise quietly start describing a different package.

The guarantee depends on the DID method. A `did:plc` identifier is independent of the display handle. A `did:web` identifier is the publisher's domain written as a DID, so control can move when domain ownership changes. Drydock still canonicalizes `did:web` packages to their DID spelling, but displays a notice that the URL cannot permanently pin publisher ownership.

Handle-form URLs still resolve, for anything already linked and for hand-typed convenience.

Using the canonical identity does not cost the reader the name they know it by. Because a DID-addressed lookup reverse-verifies the document's claimed handle, the page, its title, and its share card all render `@ebey.dev/counter` while the URL keeps the DID form. That is what `displayName` on the public-diff payload and version listing is for; it is set only from a handle this resolution proved, so a package whose handle does not verify shows its DID and nothing else.

Handles fold to lowercase; the record key never does, because atproto record keys are case-sensitive and folding them would let two distinct records share one cache entry.

## What is checked, beyond the npm rules

An atpm version is an ordinary npm tarball, so it runs the npm deterministic rule set unchanged.

atpm also splits apart two things npm keeps together. `meta` in the record is a manifest the publisher wrote; the blob is the artifact that installs. A client reads the former and runs the latter. `server/lib/ecosystems/atpm/findings.ts` checks them against each other:

- `stage.tarball-digest-mismatch` — the blob's SHA-1 (computed by the sandbox over the wire bytes) disagrees with the record's `dist.shasum`. Fails to silent, never to "mismatch", when either digest is absent.
- `stage.metadata-mismatch` — the record's `meta.name` / `meta.version` / version key disagrees with the tarball's `package.json`. Both package-name claims must also use the stable record key as their unscoped name. Their scope is compared with each other, not with the publisher's current verified handle: a historical release may legitimately retain the handle that was current when it was published.

The parser validates the record's required lexicon shape before pruning it. Each retained version must carry its timestamp, object-shaped manifest metadata with package name and version claims, and a complete generic blob reference (CID, non-negative integer size, and MIME type). Malformed individual versions are dropped so they do not hide valid releases; a readable version string may occur only once. Drydock rejects a record with duplicate versions rather than choosing whichever blob happens to appear first; otherwise review and an installing App View could select different artifacts for the same version.

The blob CID is independently re-verified. The sandbox computes SHA-256 over the complete archive wire bytes alongside SHA-1, and the parent Worker requires it to equal the digest encoded by the CIDv1 raw/sha2-256 address before the diff can proceed. A missing digest, malformed CID, truncated response, or PDS substitution fails the request; the record-level finding above then covers the separate npm `dist.shasum` claim.

`meta.dist.tarball` is never followed. It is a publisher-written string in publisher-written data, and following it would let a record name any host on the internet as the source of the bytes Drydock then presents as that package's release. The blob URL is rebuilt from the resolved PDS and the CID.

## Host policy

The atpm path is the only public-diff egress whose hosts are chosen by the party under review. `assertPublicHttpsUrl` gates every one: https only, no embedded credentials, default port only, no IPv4/IPv6 literals, no loopback, no single-label hostnames, and no atproto-reserved or local-use suffixes (`.alt`, `.arpa`, `.example`, `.invalid`, `.local`, `.localhost`, `.onion`, `.test`, and the additional private-network suffixes in the implementation). A PDS service endpoint must be an origin with no path, query, or fragment; extra components are rejected rather than silently stripped. Identity documents read under a 256 KiB ceiling and package records under 4 MiB. Nothing on this path holds credentials of any kind. See [`security-model.md`](./security-model.md).

A self-hosted PDS on a non-default port is the one legitimate shape this rejects. That is deliberate: allowing an arbitrary port would turn a DID document into a port prober, and atproto PDS endpoints are served on 443.

Redirects cannot route around that policy. Parent-Worker identity and record fetches disable automatic redirects, follow at most three hops, and validate every resolved target through `assertPublicHttpsUrl` before fetching it. Redirects off the pinned blob URL are stricter: `NpmStageGateway` resolves them itself (`fetchPinnedArtifact` in `server/lib/sandbox.ts`), follows only same-origin hops, and refuses anything that leaves the vetted origin. Credentialed npm requests are untouched and keep the runtime's own redirect handling, so a registry that moves a staged tarball to a CDN keeps working.

Computed atpm pairs have a five-minute lifetime rather than the registry-backed 30-day default. Blob bytes are immutable once CID-pinned, but the repository record that maps a version to a CID, the DID document's PDS location, and the reverse-verified display handle are mutable; the short lifetime bounds stale mappings and provenance across both KV and colo caches. Share cards use the same five-minute ceiling. Server-rendered HTML reads the verified display name from a separate small KV value, so it never fetches and parses the full cached diff merely to build a title.

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
  "createdAt": "2026-01-01T00:00:00.000Z",
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

Everything outside the validated shape and retained fields above — the readme, the Sigstore attestation bundle, the rest of the npm manifest — is dropped at parse time. It is the bulk of a real record (~50 KB raw versus ~4 KB kept for this package) and none of it is read.
