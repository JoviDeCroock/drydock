# RubyGems workflow-gate mode

This document covers RubyGems review through a **GitHub deployment-protection
workflow gate**. RubyGems has no npm-style staged registry artifact for external
review, and RubyGems Trusted Publishing already publishes from GitHub Actions
with short-lived OIDC credentials — so the workflow-gate architecture (build the
release artifact, hold the publish job on a GitHub Environment, review the exact
artifact, then release or block the job) maps cleanly onto gem releases.

It only describes what is RubyGems-specific. The webhook ingestion, gate
persistence, artifact download + SHA-256 recomputation, approve/reject callback,
2FA step-up, monorepo fan-out, notifications, and timeout handling are all
**shared with the PyPI and npm gates** and documented in
[`workflow-gates.md`](./workflow-gates.md). Read that first for the end-to-end
gate lifecycle.

Official references:

- RubyGems Trusted Publishing: `https://guides.rubygems.org/trusted-publishing/`
- RubyGems publishing guide: `https://guides.rubygems.org/publishing/`
- RubyGems versions API: `https://guides.rubygems.org/rubygems-org-api/`

## The release candidate

There is **no manifest file and no checksum file** to write. The boundary is the
workflow run's uploaded artifacts: CI runs `gem build` (one `.gem` per
publishable gem, plus one per native platform) and uploads `pkg/*.gem` as a
GitHub Actions artifact. Drydock treats every `.gem` it finds as the release set.

Integrity rests on **GitHub artifact immutability**, exactly like the PyPI gate:

- Drydock downloads the artifact bytes in the control plane and recomputes each
  gem's SHA-256 (`fetchReleaseBundleWithToken`). That digest is the reviewed
  gem's digest, bound to the immutable GitHub Actions artifact.
- The publish job downloads the **same immutable artifact** and runs
  `gem push <file>.gem` — it never rebuilds. The bytes Drydock reviewed are the
  bytes that get published.

Drydock synthesizes an internal release manifest
(`drydock.release-artifacts.v1`, `ecosystem: "rubygems"`) from the parsed
Gem::Specification identity plus the recomputed digest. Maintainers never author
it.

## Parsing a `.gem` (nested archives)

A `.gem` is **not** a plain gzipped tarball like an npm `.tgz` or a PyPI sdist.
It is an _uncompressed_ tar whose members are themselves archives:

```
example-1.0.0.gem            (uncompressed tar)
├── metadata.gz              (gzipped Gem::Specification YAML)
├── data.tar.gz              (gzipped tar of the installed files: lib/, ext/, bin/, …)
└── checksums.yaml.gz        (gzipped SHA digests of the two members above)
```

The shared sandbox grows a dedicated `gem` archive format
(`server/lib/tar-parser.js` `readGem`, wired through `server/lib/sandbox.ts`):
it reads the outer tar, gunzips `data.tar.gz` and re-parses it with the **same
hardened `readTar`** every ecosystem uses (so the installed files flow through
the identical untrusted-archive parser, path-traversal/suspicious-entry checks,
and file/byte caps), and gunzips `metadata.gz` to surface the raw gemspec YAML as
`gemMetadata`. Nested decompression is bounded by the same `maxTarBytes` cap, so a
gzip bomb in either member fails closed. Oversized gemspec metadata also fails
closed instead of being parsed from a truncated prefix, because the gemspec is the
source of package identity. Duplicate `metadata.gz`/`data.tar.gz` members fail
closed too: real gems carry each control member exactly once, and picking one of
a crafted pair could review a different payload than RubyGems' own reader
extracts. The installation token never enters the sandbox; only
the gem bytes cross the trust boundary, through the credentials-free
`downloadInSandboxInline` path.

Identity (`package` / `version` / `platform`) and the install-time capability
fields (`executables`, `extensions`, `metadata.allowed_push_host`, …) are parsed
from that gemspec YAML by a small, defensive line reader
(`server/lib/adapters/rubygems/gemspec.ts`) — not a general YAML library, because
the gemspec layout is regular and the bytes are attacker-controlled. A malformed
gemspec degrades every field to null/empty (surfacing as a `metadata-missing`
finding) rather than throwing. Root-level shapes the reader does not model but
Psych would honor — quoted or escaped mapping keys, explicit `? key` syntax,
directives, a second YAML document — invalidate the whole parse the same way, so
a crafted spec cannot present one identity to Drydock and another to `gem push`.

## No auto-detection ambiguity

A `.gem` extension is unique to RubyGems, so unlike an npm `.tgz` (byte- and
name-indistinguishable from a PyPI sdist), a gem is classified purely by path and
never needs content-based ecosystem detection. A release target can be left on
**auto-detect** (no pinned ecosystem) and a `.gem` still routes to the rubygems
adapter; pinning `ecosystem: "rubygems"` is supported but optional. A bundle that
mixes `.gem`, `.tgz`, and `.whl` files fans out per ecosystem as usual.

## Monorepo and native gems

One gem version can ship several `.gem` files — a pure-ruby gem plus
platform-specific native builds (`example-1.0.0.gem`,
`example-1.0.0-x86_64-linux.gem`, `example-1.0.0-java.gem`). They are grouped by
gem name into one review per gem:

- gems that share a name must agree on the version (a version-skewed file fails
  the gate closed with `artifact_identity_inconsistent`);
- two gems claiming the same name **and** platform are rejected — a single
  name/version/platform is exactly one `.gem`;
- distinct platforms of the same gem are the expected native-gem shape and are
  reviewed together, each namespaced by platform in the diff;
- a `.gem` with no parseable Gem::Specification name/version fails closed
  (`artifact_identity_missing`).

A true monorepo that publishes several distinct gems fans out into one scan per
gem, each against its own baseline; the held deployment releases only once every
gem is individually approved.

## Deterministic findings

On top of the shared file-level rules (secrets, and the **Ruby** code-capability
set — `system`/`exec`/`%x`/`Open3`, `Net::HTTP`/`open-uri`/sockets,
`eval`/`Marshal.load`/`YAML.load`, `ENV`/credential-file reads — run with diff
annotations), the rubygems adapter adds gem-specific rules
(`server/lib/adapters/rubygems/findings.ts`):

- `rubygems.metadata-mismatch` (critical) — the gemspec name/version disagrees
  with the reviewed manifest.
- `rubygems.metadata-missing` (medium) — the gem exposes no usable
  name/version, so it cannot be proven to match the manifest.
- `rubygems.native-extension` (medium) — the gemspec declares `extensions`, so
  `gem install` will compile native code, running the build script on the
  consumer machine.
- `rubygems.extension-build-hook` (high) — a native-extension build file under
  `ext/` (`extconf.rb`, `mkrf_conf.rb`, `Rakefile`, `Makefile`) contains
  process/network/dynamic-eval code, the RubyGems analogue of a PyPI
  `setup.py` install command.
- `rubygems.unexpected-push-host` (low) — the gemspec restricts pushes to a host
  other than rubygems.org (`metadata.allowed_push_host`), a provenance signal.

New executables and other unexpected packaged-file changes surface through the
standard package diff over the gem's files; the persisted report carries each
gem's dependency list, executables, extensions, and metadata for review.

## Baseline (currently-published version)

The baseline is the currently-published gem, selected and fetched through a
credential-free broker (`server/lib/adapters/rubygems/broker.ts`):

- `GET https://rubygems.org/api/v1/versions/<gem>.json` lists published versions;
  `pickRubyGemsBaselineVersion` picks the newest stable version that is not the
  candidate (falling back to the newest pre-release).
- only the platforms actually staged are downloaded
  (`https://rubygems.org/downloads/<gem>-<version>[-<platform>].gem`), bounded
  to one gem per platform, with the URL pinned on the sandbox public-artifact
  allowlist so the request is uncredentialed and host-restricted to
  rubygems.org.

Baseline resolution is best-effort: a missing or unreachable baseline degrades to
a full-tree review (every file reads as added) rather than failing the gate.

## Code sharing

The rubygems review runs on the same `PackageAdapter` pipeline as npm and PyPI:

- `server/lib/adapters/rubygems/index.ts` — `rubygemsAdapter`, the
  `PackageAdapter` the shared pipeline runs (parse input, staged + baseline
  acquisition, deterministic findings, risk).
- `server/lib/adapters/rubygems/manifest.ts` — the synthesized release-manifest
  type + validator.
- `server/lib/workflow-gates/rubygems.ts` — `rubygemsWorkflowGateAdapter`, the
  `WorkflowGateAdapter`: `classifyArtifact` (`.gem`), `detectArtifact` (always
  null — `.gem` is path-unique), and `prepareReleaseCandidates` (group parsed
  gems by name → one candidate per gem).

## Workflow shape

```yaml
jobs:
  build-release-artifacts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ruby/setup-ruby@v1
        with: { ruby-version: "3.3" }
      # `gem build` (or `rake build`) emits the .gem files; for native gems,
      # build each platform variant into pkg/.
      - run: gem build *.gemspec --output "pkg/$(ruby -e 'print "#{Gem::Specification.load(Dir["*.gemspec"].first).full_name}.gem"')"
      - uses: actions/upload-artifact@v4
        with:
          name: rubygems-release-candidate # or leave blank in the release target to auto-detect
          path: pkg/*.gem
          if-no-files-found: error

  publish:
    needs: build-release-artifacts
    runs-on: ubuntu-latest
    environment: rubygems # the gate: Drydock's deployment protection rule lives here
    permissions:
      id-token: write # OIDC for RubyGems Trusted Publishing
      contents: read
    steps:
      - uses: ruby/setup-ruby@v1
        with: { ruby-version: "3.3" }
      # No checkout, no rebuild: GitHub artifact storage is immutable, so the
      # bytes the gate approved are the bytes we download and push here.
      - uses: actions/download-artifact@v4
        with: { name: rubygems-release-candidate, path: pkg }
      - uses: rubygems/configure-rubygems-credentials@main
      - run: |
          shopt -s nullglob
          for gem in pkg/*.gem; do
            gem push "$gem"
          done
```

The `environment: rubygems` line is the gate. Map the repository + environment on
`Organization settings → GitHub App`, configure a matching RubyGems Trusted
Publisher on the same environment, and attach Drydock as a custom deployment
protection rule on it. The publish job stays blocked until a maintainer approves
every gem's review in Drydock; publishing then proceeds over Trusted
Publishing/OIDC — Drydock never holds or sees a RubyGems API key.

## Acceptance mapping (issue #200)

- _Org settings can map a GitHub repo + environment to a RubyGems gem_ — the
  shared release-target mapping accepts `ecosystem: "rubygems"`.
- _A pending deployment-protection request creates a `workflow_gate` scan with
  `ecosystem = rubygems`_ — shared gate machinery; the `.gem` bundle resolves to
  `rubygemsAdapter` scans linked to the gate.
- _Drydock downloads and scans `.gem` candidates from the workflow artifact
  bundle_ — `fetchReleaseBundleWithToken` + the sandbox `gem` parse path.
- _The scan compares the candidate against the previous published gem version_ —
  `acquireBaselineRubyGems` via the rubygems.org versions API.
- _Approve/reject releases or blocks the held job_ — shared decision callback.
- _Tests cover gem metadata parsing, nested archive limits, baseline selection,
  native extension findings, and gate decision behavior_ — `test/rubygems-*.mjs`,
  `test/rubygems.test.mjs`, `test/security-corpus-rubygems.test.mjs`, and
  `test/workers/workflow-gate-rubygems.test.ts` /
  `workflow-gate-prepare.test.ts`.
- _The publish credential stays out of Drydock_ — publishing remains in GitHub
  Actions through RubyGems Trusted Publishing.
