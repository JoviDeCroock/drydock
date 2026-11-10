# Dependency review sources and pins

How dependency review places each lockfile version by where its bytes come
from (step 5 of the flow in `dependency-review.md`), proves lockfile pins
against the public registry (step 6), and words its young-package and
`dependency-added` holds. The hold policy, approvals, and settings are in
`dependency-review.md`.

## Places

Every recorded version is placed per side of the bump, and the bump takes the
worse side (public, mirror, private, remote, in that order). Sources whose code
is in the PR itself (`file:`, `link:`, `workspace:`, `portal:`, `exec:`, paths)
are left out. No bundled npm entry is: one npm's own rule accepts as bundled
(named in a `bundleDependencies` array, depended on by a bundled package, peers
included, and resolving inside the bundler, or installed inside a bundled
package) is reviewed as the registry release of its name and version with no
pin expected, since npm writes none. `true` and the `bundledDependencies`
spelling bundle nothing. Any other `inBundle` entry expects a pin like the
rest, so it holds.

| Place | When | Review |
| --- | --- | --- |
| Public | npm: an entry with no URL whose name the repository's config routes to the public registry, or a URL that is exactly the canonical https tarball URL on `registry.npmjs.org` or `registry.yarnpkg.com` for that entry's own name and version (Yarn classic's 40-hex `#` fragment allowed). PyPI: a uv entry on `https://pypi.org/simple` with every file on `files.pythonhosted.org`, or a requirements pin. | Diffed after its pin is proven (below). |
| Mirror candidate | The URL or the name's route is under a `publicMirrors` prefix, no side is private or remote, and every side pins strong hashes. | Diffed as public once the pins are proven; otherwise unreviewed `unverified-pin`, handled like a remote source. |
| Private registry (`privateSource`) | The URL or route is under a `privateRegistries` prefix and the package was already there at the base or is new to the lockfile, or the npm name is in a `privateScopes` scope (except as below). | Never diffed; unreviewed (`private-source`). |
| Remote (`remoteSource`) | Everything else: any other host or route (including a public-host URL that is not the canonical one), an unreadable or environment-dependent route, a git ref, a URL or tarball, a v5/v6 `pnpm-lock.yaml` entry keyed by another registry's host, a PyPI file off PyPI's file host, a mirror entry without comparable pins. | Never diffed; unreviewed (`remote-source`). No publish time, so no age fallback. |

A change of place across the PR is judged by what the head fetches:

| Change | Treated as |
| --- | --- |
| A public or mirror head whose base came from a private registry or another non-public source | A package new to the lockfile, listed "previously from a non-public source": the base version is no predecessor of the public release, and no private-registry exemption applies. Dependency confusion takes this shape. |
| A mirror base copy of the release the head installs, not pinned to the head's strong hashes | No predecessor: a new package, listed the same way. Nothing proves the base copy was the public release. |
| A base copy that was only bundled inside another npm package, with a fetched head | No predecessor: the fetched copy is a new package, not a re-pin. |
| A release the PR moves from the public registry or a mirror onto a declared private registry | Remote: the exemption needs the base on that registry already. |
| A `privateScopes` name that a change moves off a non-public source (a declared private registry, an undeclared host, git, or a URL) onto the public registry or a declared mirror, or that is new to its lockfile (not a re-pin) with an entry recording a public registry URL or resolving through a declared mirror | Unreviewed `private-scope-public`, never looked up publicly, held until approved whatever the switches. Every other case stays private and exempt: a version change or re-pin of a name already public at the base (a scope hosted on the public registry itself), a name on a declared private registry, and a new name the lockfile records no URL for (pnpm, Yarn Berry) that the repository routes nowhere. A name from a remote source is remote. |
| One change found in several lockfiles | New when any copy is new; it counts as pinning the whole tree only when every lockfile does. |

- Routing comes from the committed `.npmrc` and `.yarnrc.yml` in the npm
  lockfile's directory and each one above it, at the head. In a lockfile over
  10 directories deep, or where such a file doesn't parse (then listed as
  unread), every name routes somewhere unknown.
- Prefixes match only plain, canonical https URLs without credentials, query,
  or fragment, at a path boundary.
- Private and remote identities include their pin: a re-pin at the same URL is
  a change.
- A name in a declared `privateScopes` scope is never sent to a public
  registry, whatever routing outside the repository it relies on. Other config
  set outside the repository (environment variables, CI configuration,
  user-level files, Dependabot `registries:`) is invisible here, including
  registries and proxies set that way.

## Declaring registries

Naming a mirror sends the names and versions resolved from it to the public
npm registry or PyPI, to prove their hashes. For pnpm, whose lockfile records
no URL, that is every name the repository routes to the mirror, so list scopes
the organization hosts itself behind the mirror, or whose registry is set
outside the repository, under `privateScopes`. A mirror entry whose hashes
don't match, and every Yarn Berry or bundled npm entry from a mirror (neither
has a hash to compare), is treated like a git or URL source. A declared
private registry is never contacted and its names never leave the
organization.

A registry that also proxies the public registry must be declared a mirror,
not a private registry: bumps from a private registry are not reviewed. A
release the PR moves onto a private registry from the public registry or a
mirror is a remote source. An undeclared registry or proxy is a remote source
too, so under the default policy its bumps hold until approved.

A listed scope is the organization's own: its names are exempt and never looked
up publicly, except that a move off a non-public source onto a public one, or a
new internal package arriving from a public URL or a mirror, is held once for
approval. List a scope only if the organization owns it on the public registry
too, or hosts it behind a declared mirror (above); otherwise declare its
private registry, which exempts only what that registry serves.

## Pins

A public bump whose lockfile records a strong pin for the target version
carries it (`pinnedHashes`) and is diffed only after `verifyPublicPin`
(`server/lib/dependency-review/mirror-identity.ts`) proves every pinned hash is
one the public registry records for that exact name and release: npm's
`sha512` from `dist.integrity`, or the sha256 of one of the PyPI release's
files. The registry is read anonymously through the cached public-metadata
path. PyPI names are PEP 503-normalized and lockfile versions resolve to PyPI's
release key by PEP 440 equivalence, so a lockfile `1.0.0` reviews release
`1.0`.

| Format | Comparable pin | Mirror candidate |
| --- | --- | --- |
| `package-lock.json` / `npm-shrinkwrap.json` | `sha512-…` integrity | Yes, by `resolved` URL or the name's route |
| `pnpm-lock.yaml` | `sha512-…` integrity | Yes, by the name's route (the lockfile records no URL) or a `tarball` URL; never a host-keyed v5/v6 entry |
| `yarn.lock` classic | `sha512-…` integrity | Yes, by `resolved` URL |
| `yarn.lock` Berry | None: its checksum is of Yarn's repacked archive, so a checksum-only change at an unchanged version is not a change | Never |
| `uv.lock` | Every `sha256:` file hash of the release | Yes, by index and file URLs |
| Requirements | `--hash=sha256:` values, when present | No |

- A `sha512` counts only when every other component of the integrity string is
  a known weaker digest; gaining or losing a weaker digest beside an unchanged
  `sha512` is not a change.
- npm v2/v3, pnpm, Yarn classic, and uv always write a strong pin. In those
  formats a public bump or re-pin whose target has no clean, usable pin
  (missing, sha1-only, beside an unknown algorithm, carrying `?` options,
  malformed, or copies that disagree) must be proven and cannot be, however
  old the version. A requirements line that has, or drops, a `--hash` is held
  to the same rule.
- A failed or impossible proof (no usable pin, no public egress, a missing
  release or digest, a failed read) is `unverified-pin`, handled like a remote
  source. Only Yarn Berry and unhashed requirements have no pin by design;
  their public bumps rely on the registry route alone.
- A lockfile that keeps a public version and pins a copy with a pin no base
  copy had reports a bump with no previous version (**Same version, new
  pin**). Only the introduced pins are proven; kept, removed, or duplicated
  base pins owe nothing, and an introduced copy without a usable strong pin
  holds even beside pinned siblings. A proven re-pin is decided as a new
  package, but the young-package rule does not judge it.
- A mirror candidate (`verifyMirrorBump`) proves both sides of a version
  change, or the target alone for a new package, a move onto the mirror, or a
  re-pin. Proven, it is diffed, linked, and approved as public; unproven, it is
  `unverified-pin`, keyed by its pinned hashes.

## Hold wording

The check run and the dashboard word young-package and `dependency-added` holds
alike (`server/lib/dependency-review/wording.ts`); _time_ is UTC on the check
and local time in the dashboard.

| Hold | Check and dashboard wording |
| --- | --- |
| New package, first published under 90 days ago | a package new to the lockfile, first published _time_ |
| New package, installed version under 7 days old | a package new to the lockfile whose installed version was published _time_ |
| New package of unknown age | a package new to the lockfile whose age Drydock could not establish (plus " (past the per-PR review limit)" when it was) |
| New package with no verdict (remote source, unproven pin) | a package new to the lockfile with no Drydock verdict (_unreviewed reason_) |
| New uv package with no wheel | a package new to the lockfile that is built from source; its build dependencies are not in the lockfile |
| Undiffed update, version under 7 days old | no Drydock verdict (_unreviewed reason_); its version was published _time_ |
| Undiffed update past the review limit | no Drydock verdict (_unreviewed reason_); Drydock did not look up its age, so it holds until approved |
| Undiffed update, publish time unknown | no Drydock verdict (_unreviewed reason_); its version's publish time is unknown, so it holds until approved |
| Added dependency, lockfile doesn't pin the tree | adds a dependency; this lockfile does not pin transitive dependencies, so Drydock cannot see what it installs |
| Added dependency, part of the PR unread | adds a dependency; part of this pull request went unread, so Drydock cannot see what it installs |
