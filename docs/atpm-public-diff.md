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

Multiple distinct DID claims in DNS are an invalid, ambiguous identity state. Drydock fails that resolution without consulting the well-known fallback; the fallback is only for an absent or unavailable DNS claim.

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

Handles fold to lowercase; the record key never does, because atproto record keys are case-sensitive and folding them would let two distinct records share one cache entry. The accepted record-key grammar is the lowercase npm subset of atproto's key grammar, including npm's valid `~` character. Handle-form names apply npm's 214-character limit to the complete `@handle/name`; DID-form record keys are bounded to the longest name that could fit under the shortest public handle.

## What is checked, beyond the npm rules

An atpm version is an ordinary npm tarball, so it runs the npm deterministic rule set unchanged.

atpm also splits apart two things npm keeps together. `meta` in the record is a manifest the publisher wrote; the blob is the artifact that installs. A client reads the former and runs the latter. `server/lib/ecosystems/atpm/findings.ts` checks them against each other:

- `stage.tarball-digest-mismatch` — the blob's SHA-1 (computed by the sandbox over the wire bytes) disagrees with the record's `dist.shasum`. Fails to silent, never to "mismatch", when either digest is absent.
- `stage.metadata-mismatch` — the tarball has no readable package name/version, or the record's `meta.name` / `meta.version` / version key disagrees with the tarball's `package.json`. Both package-name claims must be syntactically scoped atpm names whose only path segment is the stable record key. Their scope is compared with each other, not with the publisher's current verified handle: a historical release may legitimately retain the handle that was current when it was published.

A mismatch on the target is reported as the critical finding above. A mismatch on the baseline fails acquisition instead: otherwise the page would label the left side with a version its tarball does not authenticate.

The parser validates the record's required lexicon shape before pruning it. Each retained version must carry its timestamp, object-shaped manifest metadata with package name and version claims, a non-empty string `dist.tarball` install target, and a complete generic blob reference (CID, non-negative integer size, and MIME type). Its optional embedded `$type`, when present, must be the package lexicon's exact `#package` type. Legacy records may omit `dist.shasum`, but a present value must be a 40-character SHA-1 claim so malformed metadata cannot be mistaken for an omission. Malformed individual versions are dropped so they do not hide valid releases, but their syntactically valid version names are remembered. An exact request for one of those versions, or a `latest` tag that names one, fails as unreadable upstream data instead of returning a false 404 or silently selecting an older release. Every syntactically valid version key is also counted before pruning. Drydock rejects a record when the same version key occurs twice, even if one entry is otherwise malformed; otherwise review could keep one blob while an installing App View uses the other entry's metadata.

The blob CID and npm install integrity are independently re-verified. atpm explicitly asks the sandbox to compute SHA-256 and SHA-512 over the complete archive wire bytes alongside the default SHA-1; other adapters do not pay for those extra digests unless they need them. The parent Worker requires SHA-256 to equal the digest encoded by the canonical CIDv1 raw/sha2-256 address, and, when `meta.dist.integrity` is present, requires a readable SHA-512 SRI member to equal the computed SHA-512. A missing computed digest, malformed CID/SRI value, truncated response, or PDS substitution fails the request; the record-level finding above then covers the separate npm `dist.shasum` claim.

`meta.dist.tarball` is never followed. It is a publisher-written string in publisher-written data, and following it would let a record name any host on the internet as the source of the bytes Drydock then presents as that package's release. The blob URL is rebuilt from the resolved PDS and the CID, but the declared install URL must still identify that exact endpoint, DID, and CID. That binds the bytes Drydock reviews to the bytes the npm-compatible App View tells clients to install.

## Host policy

The atpm path is the only public-diff egress whose hosts are chosen by the party under review. `assertPublicHttpsUrl` gates every one: https only, no embedded credentials, default port only, no IPv4/IPv6 literals, no loopback, no single-label hostnames, and no atproto-reserved or local-use suffixes (`.alt`, `.arpa`, `.example`, `.invalid`, `.local`, `.localhost`, `.onion`, `.test`, and the additional private-network suffixes in the implementation). A PDS service endpoint must be an origin with no path, query, or fragment; extra components are rejected rather than silently stripped. The deployed Worker also enables Cloudflare's `global_fetch_strictly_public` compatibility flag, so global `fetch()` requests — including same-zone hosts — go through the public Internet path instead of bypassing Workers and Cloudflare security settings for an origin. Identity documents read under a 256 KiB ceiling and package records under 4 MiB. Nothing on this path holds credentials of any kind. See [`security-model.md`](./security-model.md).

A self-hosted PDS on a non-default port is the one legitimate shape this rejects. That is deliberate: allowing an arbitrary port would turn a DID document into a port prober, and atproto PDS endpoints are served on 443.

Redirects cannot route around that policy. Parent-Worker identity and record fetches disable automatic redirects, follow at most three hops, and validate every resolved target through `assertPublicHttpsUrl` before fetching it. Redirects off the pinned blob URL are stricter: `NpmStageGateway` resolves them itself (`fetchPinnedArtifact` in `server/lib/sandbox.ts`), follows only same-origin hops, and refuses anything that leaves the vetted origin. Credentialed npm requests are untouched and keep the runtime's own redirect handling, so a registry that moves a staged tarball to a CDN keeps working.

Computed atpm pairs have a five-minute lifetime rather than the registry-backed 30-day default. Blob bytes are immutable once CID-pinned, but the repository record that maps a version to a CID, the DID document's PDS location, and the reverse-verified display handle are mutable. Identity and record cache entries therefore carry an absolute expiry, and the computed pair inherits the earlier one. KV writes, colo rewarms, version responses, share cards, and the separate display-name value all use only the remaining lifetime; moving a value between layers can never restart its five-minute clock. Server-rendered HTML reads the verified display name from that small KV value, so it never fetches and parses the full cached diff merely to build a title.

## Build provenance

A version's Sigstore bundle and its package's trusted-publisher record are both read here, and both are re-verified rather than taken from the record. The page renders what was proven (repository, workflow, commit, run) separately from what the publisher declared, and the deltas between two releases produce their own findings. That is a surface of its own; see [`atpm-trusted-publishing.md`](./atpm-trusted-publishing.md).

## What is not built

- **No dependency diff links.** An atpm dependency spelled `@handle/name` resolves on npm to a scope someone else owns, so the manifest diff links nothing rather than something confidently wrong.
- **No package-only `/diff/atpm/<name>` form.** Nothing links it.
- **No approval, and no gate.** Drydock reviews staged candidates and stops there; approving is a write to the publisher's own repository, done in atpm.

Staged candidates are diffed on this same surface: `/stage/atpm/<publisher>/<rkey>` redirects to an ordinary `/diff` URL whose `to` version names the staged record, so a pre-publish review is anonymous, shareable, and identical to a published one. See [`atpm-trusted-publishing.md`](./atpm-trusted-publishing.md).

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

Everything outside the validated shape and retained fields above — the readme, the rest of the npm manifest — is dropped at parse time. It is the bulk of a real record (~50 KB raw versus ~4 KB kept for this package) and none of it is read. The Sigstore attestation bundle is the one exception, and only briefly: it is pulled out to one side during parsing, exchanged for a small verified verdict before anything is returned or cached, and never reaches `AtpmVersion` at all.
