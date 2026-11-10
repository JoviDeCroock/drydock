# Dependency review (evidence-based cooldown)

Release-age cooldowns (pnpm `minimumReleaseAge`, Renovate `minimumReleaseAge`,
uv `exclude-newer`) delay every dependency update by the same number of days
and hope someone else notices a bad release first. Dependency review replaces
the timer with the diff: the Drydock GitHub App posts a **Drydock dependency
review** check on pull requests from branches in the installed repository,
including PRs opened by people. A complete review with no npm or PyPI dependency
additions or version changes passes with **No npm or PyPI dependency updates**.
A version change whose diff Drydock read in full and that adds no capability
passes and can auto-merge the same day. A change that adds one is held until
someone with write access to the repository reads the diff and approves it.
What Drydock could not read in full falls back to a release-age wait, three days
by default (step 8).

The free PR comment workflow (`dependency-pr-diff-links.md`) shows the same
diffs without the App. It informs; this check decides, because a repository can
make it required.

## Flow

1. GitHub sends `pull_request` (`opened`, `synchronize`, `reopened`) to
   `POST /webhooks/github`. `server/lib/dependency-review/webhook.ts` records a
   review only when the installation is active and mapped to an organization
   that turned dependency review on, and the head branch is in the same
   repository. For a human-authored PR, the author and event sender (the pusher
   on `synchronize`) must both have write access. Trusted automation is
   `dependabot[bot]` or `renovate[bot]` with account type `Bot`, or a login the
   organization listed. Each (installation, repository, head sha) gets one
   `dependency_reviews` row. A redelivery enqueues it again when it is `queued`
   or `failed` (the first enqueue may have been lost), `superseded` (the PR was
   reopened), or `running` past its 15-minute lease (its worker died); a
   completed row is left alone. Trusted bot fork PRs are ignored; other fork
   PRs, and same-repo PRs whose author or sender lacks write access, use the
   guarded skip path below without claiming a review row.
2. **Newest run wins.** Check runs belong to a commit, and GitHub reads the
   newest run of a name. Anyone can open a PR from a fork at a bot PR's head
   commit, so a skip is never posted on a commit that has a review. A skip is
   created `in_progress`, which doesn't pass, and completed `skipped` only after
   a second look finds no review; one that dies part way never passes. A skip on
   a commit that is the tip of a branch in the repository (always so for a
   same-repo PR, and possible from a fork) completes `skipped` only when the
   PR's author and the event's sender (the pusher, on a new commit) both have
   write access, and `cancelled` otherwise: Renovate pushes its branch before
   opening the PR and can automerge it on a green check, and any reader can
   open a PR from that branch. An author stuck behind such a skip pushes a new
   commit. If a review appeared meanwhile, the skip completes `cancelled` and the review
   re-runs (a re-run asked for while the review is running is retried, not
   dropped, and Re-run on the cancelled skip re-runs the review too). Before
   publishing, the review lists the commit's Drydock runs (`check_name` plus
   the App id). When the newest is a skip, it publishes to a fresh run and
   closes its old one `cancelled`. When the newest is a run of the same review
   that the review records, a later attempt (a Re-run) owns the result; one it
   doesn't record (a create whose response was lost) is adopted. In the branch
   rule, set the required check's source to the Drydock App, so another App
   can't post a passing run under the same name.
3. **Claim.** The route enqueues `{ kind: "dependency_review" }` on
   `SCAN_QUEUE`. The consumer (`server/lib/dependency-review/job.ts`) mints an
   installation token, creates the check run in progress, and confirms the PR
   is still open at that head. A review runs in one or more passes (step 7);
   each pass claims the row first.

   | Claim rule | Behaviour |
   | --- | --- |
   | Who can claim | A queued, failed, or superseded review; a completed one only for Re-run or an age recheck (step 10); a running one only past its 15-minute lease. The next pass of a running review (a continuation) takes only a queued row or an expired lease. |
   | Fencing | The claim is compare-and-set and increments the row's `attempt`. Every progress, completion, cancellation, release, and failure write names that attempt (and the owning check run), so a pass that lost its claim stops at its next write and cannot overwrite its replacement. Each progress write renews the lease. |
   | Duplicates | A redelivery during a running claim sends a fresh delayed message before acknowledging, so waiting out the lease doesn't spend the queue's retries. A completed duplicate posts no second run. A retryable failure gives the claim back before the queue retries. |
   | Stale heads | Deliveries arrive out of order, so only the head comparison decides staleness. Each pass checks the head before spending anything, and the last pass again before publishing. A commit no longer the open PR's head is superseded and its check ends `cancelled` (not `neutral`, which GitHub counts as passing); reopening or Re-run reviews it again. |
   | Takeover | Taking over an expired claim creates a fresh check run and cancels its predecessor. |

4. **Collect.** The first pass lists the PR's files, reads each supported
   lockfile at the merge base and at the head through the contents API, and
   diffs the two snapshots (`server/lib/dependency-review/lockfiles/`). Direct
   and transitive packages both count: worms spread through transitive
   dependencies. A package version the PR adds with nothing to compare against
   is a _new package_. Lockfile, manifest, and registry config bytes are
   repository data: they are only parsed, and only in the canonical shape their
   tool writes. A changed file whose effect Drydock can't place is _unread_
   (`coverage.unreadLockfiles`), and step 8 holds the review for it. An
   incomplete snapshot diffs to nothing, which must not read as "nothing
   changed".

   | Changed file | Unread when |
   | --- | --- |
   | Supported lockfile (`package-lock.json` / `npm-shrinkwrap.json` v2–v3, `pnpm-lock.yaml` v5–v9, `yarn.lock` classic and Berry, `uv.lock`) | Past the 20-per-review cap, over 8 MiB, deleted by the PR, or not finished by the parser: malformed, outside the canonical shape, over its entry caps, or holding an entry it can't classify (an unplaceable entry makes the snapshot incomplete; it is never dropped). Peer variants of one release in `pnpm-lock.yaml` are one entry; variants with different resolutions make the file unread. |
   | Requirements (`requirements*.txt`, `constraints*.txt`, `requirements/*.txt`, and any other changed `.txt`, since pip follows `-r`/`-c` into files of any name) | As above, plus: an index or find-links option other than an explicit pypi.org `--index-url`, any option pip doesn't accept exactly as written, a name pinned to two versions, a change to its unpinned lines (ranges such as `foo>=1.3`, URLs, VCS and `-e` lines, includes), or a change to the extras, marker, or per-requirement install options of a name pinned to the same release on both sides (adding, removing, or re-versioning a conditional line is an ordinary bump). A `.txt` that isn't requirements holds on its text change. |
   | Unparsed npm or PyPI lockfile (`bun.lock`, `poetry.lock`, `Pipfile.lock`, `pdm.lock`, `pylock*.toml`) | Always. |
   | Dependency manifest (`package.json`, `pyproject.toml`, `setup.cfg`, `setup.py`, `Pipfile`, pip-tools `*.in`) | Unless the PR changes a parsed lockfile of its ecosystem that covers it: one in the same directory, or one above it whose parsed snapshot records the directory as a project: npm importer keys, pnpm `importers` from every YAML document, Berry `workspace:` resolutions, uv editable, virtual, and directory sources, or the Yarn root manifest's `workspaces` globs. A requirements file covers only its own pip-tools input (`X.in` for `X.txt`) or a manifest its `pip-compile` or `uv pip compile` header line names. |
   | `.npmrc`, `.yarnrc.yml` (anywhere in the PR) | Any change other than to comments and blank lines (an added or removed file counts unless it holds only those), any rename, and any side that does not read in the strict shape. Over 64 KiB a file does not read. |
   | Yarn classic `.yarnrc`, `uv.toml`, `pip.conf`, `pip.ini` | Any change. |
   | `pyproject.toml` `[tool]` and `[tool.uv…]` tables | Any change to their text (whitespace-normalized). |
   | Committed Yarn install files: anything under `.yarn/cache`, `.yarn/unplugged`, `.yarn/releases`, or `.yarn/plugins`, the PnP loader (`.pnp.cjs`, `.pnp.js`, `.pnp.loader.mjs`, `.pnp.data.json`), and any zip in the cache a `.yarnrc.yml` `cacheFolder` names (read at the head, relative to that file) | Added, removed, changed, or renamed; reported once per directory (per file for the loader). Yarn installs or runs these with nothing the lockfile diff binds. A zip elsewhere is an ordinary file; a moved `pnpUnpluggedFolder` is not followed. |

   Up to 20 changed `.npmrc`, `.yarnrc.yml`, and `pyproject.toml` files are
   compared per review; past that, a changed one is unread. Up to 20 uncovered
   `package.json` files are compared as data at the merge base and head
   (`server/lib/dependency-review/manifests.ts`): a change limited to known
   metadata (name, version, description, scripts, exports, formatting, key
   order) needs no lockfile. A new or renamed manifest is compared with an
   empty object, since moving declarations can change their resolution. Any
   other change, and malformed, missing, over-8-MiB, or over-cap data, stays
   unread. Python manifests always need the lockfile.

5. **Place each source.** Every recorded version is placed by where its bytes
   come from, per side of the bump, and the bump takes the worse side
   (public, mirror, private, remote, in that order). Sources whose code is in
   the PR itself (`file:`, `link:`, `workspace:`, `portal:`, `exec:`, paths)
   are left out. An npm `inBundle` entry without its own `resolved` is left out
   only when npm ships it in the bundler's tarball: a named bundle dependency,
   anything a bundled package depends on (peers included) that resolves inside
   the bundler, or anything installed inside a bundled package. Every other
   copy is reviewed.

   | Place | When | Review |
   | --- | --- | --- |
   | Public | npm: an entry with no URL whose name the repository's config routes to the public registry, or a URL that is exactly the canonical https tarball URL on `registry.npmjs.org` or `registry.yarnpkg.com` for that entry's own name and version (Yarn classic's 40-hex `#` fragment allowed). PyPI: a uv entry on `https://pypi.org/simple` with every file on `files.pythonhosted.org`, or a requirements pin. | Diffed after its pin is proven (step 6). |
   | Mirror candidate | The URL or the name's route is under a `publicMirrors` prefix, no side is private or remote, and every side pins strong hashes (step 6). | Diffed as public once the pins are proven; otherwise unreviewed `unverified-pin`, handled like a remote source. |
   | Private registry (`privateSource`) | The URL or route is under a `privateRegistries` prefix and the package was already there at the base or is new to the lockfile, or the npm name is in a `privateScopes` scope. | Never diffed; unreviewed (`private-source`). |
   | Remote (`remoteSource`) | Everything else: any other host or route (including a public-host URL that is not the canonical one), an unreadable or environment-dependent route, a git ref, a URL or tarball, a v5/v6 `pnpm-lock.yaml` entry keyed by another registry's host, a PyPI file off PyPI's file host, a mirror entry without comparable pins, a release the PR moves from the public registry or a mirror onto a declared private registry. | Never diffed; unreviewed (`remote-source`). No publish time, so no age fallback. |

   - Routing comes from the committed `.npmrc` and `.yarnrc.yml` in the npm
     lockfile's directory and each one above it, at the head. In a lockfile
     over 10 directories deep, or where such a file doesn't parse (then listed
     as unread), every name routes somewhere unknown.
   - Prefixes match only plain, canonical https URLs without credentials,
     query, or fragment, at a path boundary.
   - Private and remote identities include their pin: a re-pin at the same URL
     is a change.
   - A name in a declared `privateScopes` scope is never sent to a public
     registry, whatever routing outside the repository it relies on. Other
     config set outside the repository (environment variables, CI
     configuration, user-level files, Dependabot `registries:`) is invisible
     here, including registries and proxies set that way.

6. **Prove pins.** A public bump whose lockfile records a strong pin for the
   target version carries it (`pinnedHashes`) and is diffed only after
   `verifyPublicPin` (`server/lib/dependency-review/mirror-identity.ts`) proves
   every pinned hash is one the public registry records for that exact name and
   release: npm's `sha512` from `dist.integrity`, or the sha256 of one of the
   PyPI release's files. The registry is read anonymously through the cached
   public-metadata path.

   | Format | Comparable pin | Mirror candidate |
   | --- | --- | --- |
   | `package-lock.json` / `npm-shrinkwrap.json` | `sha512-…` integrity | Yes, by `resolved` URL or the name's route |
   | `pnpm-lock.yaml` | `sha512-…` integrity | Yes, by the name's route (the lockfile records no URL) or a `tarball` URL; never a host-keyed v5/v6 entry |
   | `yarn.lock` classic | `sha512-…` integrity | Yes, by `resolved` URL |
   | `yarn.lock` Berry | None: its checksum is of Yarn's repacked archive, so a checksum-only change at an unchanged version is not a change | Never |
   | `uv.lock` | Every `sha256:` file hash of the release | Yes, by index and file URLs |
   | Requirements | `--hash=sha256:` values, when present | No |

   - A `sha512` counts only when every other component of the integrity string
     is a known weaker digest; gaining or losing a weaker digest beside an
     unchanged `sha512` is not a change.
   - npm v2/v3, pnpm, Yarn classic, and uv always write a strong pin. In
     those formats a public bump or re-pin whose target has no clean, usable
     pin (missing, sha1-only, beside an unknown algorithm, carrying `?`
     options, malformed, or copies that disagree) must be proven and cannot
     be, however old the version. A requirements line that has, or drops, a
     `--hash` is held to the same rule.
   - A failed or impossible proof (no usable pin, no public egress, a missing
     release or digest, a failed read) is `unverified-pin`, handled like a
     remote source. Only Yarn Berry and unhashed requirements have no pin by
     design; their public bumps rely on the registry route alone.
   - A lockfile that keeps a public version and pins a copy with a pin no base
     copy had reports a bump with no previous version (**Same version, new
     pin**). Only the introduced pins are proven; kept, removed, or duplicated
     base pins owe nothing, and an introduced copy without a usable strong pin
     holds even beside pinned siblings. A proven re-pin is decided as a new
     package.
   - A mirror candidate (`verifyMirrorBump`) proves both sides of a version
     change, or the target alone for a new package, a move onto the mirror, or
     a re-pin. Proven, it is diffed, linked, and approved as public; unproven,
     it is `unverified-pin`, keyed by its pinned hashes.

7. **Review in passes.** Each public version change (proven pins and mirror
   bumps included) runs through `loadPublicPackageDiff`, the same pipeline,
   rules, and versioned KV cache as `/diff`. Everything except plain
   private-registry and remote bumps is reviewable; the first 500 reviewable
   bumps in collected order (direct first) are proven, diffed, and dated, and
   the rest are unreviewed `over-cap`. PyPI names
   are PEP 503-normalized and lockfile versions resolve to PyPI's release key by
   PEP 440 equivalence, so a lockfile `1.0.0` reviews release `1.0`.

   | Bound | Value (`server/lib/dependency-review/review-bumps.ts`, `job.ts`) |
   | --- | --- |
   | Cold diffs per pass (not in the shared cache) | 12 (`MAX_COLD_DIFFS_PER_PASS`), 4 at a time; a cached pair costs none |
   | Cached diff reads per pass | 100 |
   | Registry lookups per pass (pin and mirror proofs, publish-time listings) | 150 |
   | Wall clock per pass | 8 minutes (`PASS_BUDGET_MS`) |
   | Passes per review | 50 (`MAX_REVIEW_PASSES`) |

   - The cold-diff bound keeps a typical pass under the queue consumer's
     30-second CPU limit, which the Worker can't observe (see Measured).
   - Outcomes are stored on the review row (`progress_json`) as they land, a
     cold diff's start before it runs. Passes after the first reuse the stored
     collection and skip settled bumps. They collect again when the
     collection was too large to store, or when any setting collection reads
     (`publicMirrors`, `privateRegistries`, `privateScopes`) changed, dropping
     stored outcomes for bumps the new collection no longer has.
   - While work remains, the pass sets the in-progress check's summary to
     "Reviewed X of Y updates so far", queues the next pass, and gives its
     claim back. There is no Approve until the last pass.
   - `not-found`, `unsupported`, and `failed` (uncached by the public diff)
     are not retried within the review; a Re-run retries them.
   - A cold diff that started without recording an outcome may have taken its
     pass down; it runs alone at the start of the next pass, and after two
     starts it is recorded `failed`.
   - The last pass applies the policy and approvals once, so one check never
     mixes two policies. If the pass bound left work pending, those bumps read
     as `over-cap` or as an unknown publish time. A pass that starts with the
     bound already used (the earlier ones were killed) fails the review and
     asks for a Re-run or a smaller PR.
   - A deployment with a custom `NPM_REGISTRY` (`publicDiffEgressAllowed`, the
     same killswitch as the anonymous `/diff` surface) diffs nothing, proves no
     pin, and looks up no publish time, so every pinned bump is
     `unverified-pin`.

8. **Decide.** `server/lib/dependency-review/policy.ts` reads the release delta
   only. Context findings describe code the previous version already shipped,
   and this bump does not introduce them. The organization's policy decides
   which facts hold:

   | Policy field             | Default | Holds when the new version…                                                         |
   | ------------------------ | ------- | ----------------------------------------------------------------------------------- |
   | `holdOnInstallScripts`   | on      | adds or changes `preinstall` / `install` / `postinstall`                            |
   | `holdOnNativeBinaries`   | on      | adds a native binary (magic-byte sniffed, or a native extension)                    |
   | `holdOnNewDependencies`  | on      | declares a dependency no section declared before                                    |
   | `holdOnNewBinCommands`   | off     | adds a `bin` command                                                                |
   | `holdAtReleaseRisk`      | `high`  | has release risk at or above the threshold (`null` turns it off)                    |
   | `holdOnUninspectedFiles` | off     | has unread content (below)                                                          |
   | `holdOnUnreviewed`       | off     | has no Drydock verdict: any unreviewed reason, or unread coverage                   |
   | `holdOnNewPackages`      | off     | is a package with no previous version in the lockfile, or a re-pin                  |
   | `unreadMinimumAgeDays`   | 3       | is younger than this many days when nothing vouched for it (`null` turns it off)    |

   _Unread content_ is what a diff left unread: changed native binaries (never
   a `holdOnNativeBinaries` hold), uninspected files, coverage notices, and an
   added native binary when `holdOnNativeBinaries` is off. Images, fonts,
   media, and source maps are not counted. Archives and compressed bodies
   always count, by name or leading magic, as does any file ending in a zip
   directory: the rules never unpack them. A PyPI diff compares one wheel per
   side, so compiled wheels for other platforms are coverage notices.

   The age fallback (`unreadMinimumAgeDays`) covers what nothing vouched for.
   A switch that holds the bump outright takes precedence, and a bump the diff
   already holds gets no age reason on top.

   | Bump | Held outright by | Otherwise, with the fallback on |
   | --- | --- | --- |
   | Diffed, nothing held, with unread content | `holdOnUninspectedFiles` | `too-new` until the target is old enough; then it passes, listed apart from clear bumps |
   | Unreviewed public bump (`not-found`, `unsupported`, `failed`) | `holdOnUnreviewed` | `too-new` until old enough; then it passes as unreviewed |
   | Past the review limit (`over-cap`, or a new package past it) | `holdOnUnreviewed` or `holdOnNewPackages` | Held until approved: Drydock did not look up its publish time |
   | New package, or a proven re-pin | `holdOnNewPackages` | `too-new` until old enough; then it passes as a new package |
   | Remote source, unverified pin (including an unproven mirror bump and an entry with no usable pin) | `holdOnUnreviewed` | Held until approved, however old the version: there is no publish time to wait out |
   | Declared private registry (`private-source`) | `holdOnUnreviewed` | Exempt; passes as unreviewed |
   | Unread coverage: an unread lockfile, manifest, registry config, or committed Yarn install file, or a file listing GitHub cut short (over 3,000 files, or fewer listed than the PR's `changed_files`) | `holdOnUnreviewed` | Holds the review until approved; Approve accepts those changes unread |

   - Age runs from the target's public publish time (npm's `time` entry; for
     PyPI the release's newest non-yanked upload) and the hold records
     `passesAt`. An unknown time (failed lookup, unlisted version, no public
     egress, past the review limit) holds until approved.
   - With the fallback off, those bumps pass unless a switch holds them, and
     unread coverage holds only under `holdOnUnreviewed`.
   - Auto-merge acts on `success`, and GitHub counts `neutral` as passing, so
     whatever this table lets pass merges.

9. **Publish.** The check completes `success` (nothing held, or every hold
   already approved) or `action_required` with an **Approve held updates**
   action. `details_url` opens the review in the dashboard. The summary lists
   held bumps (reasons, release risk, file counts, top findings), the unread
   files, approved holds, then **Not reviewed**, **New packages**, **Same
   version, new pin** (re-pins proven to be the public release), **Passed with
   unread changes** (with what went unread), and **Clear**.

   - Version changes link to their public `/diff` page; new packages, re-pins,
     and private-registry, remote, and unproven bumps get no link.
   - A complete review with no added packages or version changes succeeds with
     **No npm or PyPI dependency updates**. Unread files or an incomplete
     listing never receive that title, even when policy lets them pass. The
     title says "clear" only when every bump's diff was read in full and held
     nothing.
   - An age hold says what nothing vouched for and either when it passes (a
     UTC time on the check, local time in the dashboard) or why it holds until
     approved: an unknown publish time, a git, URL, or tarball source, a bump
     past the review limit, or an unverified pin. An entry with no checkable
     hash reads "the lockfile pins no hash Drydock can check for this update"
     and no Re-run clears it; a failed lookup adds that Re-run checks again,
     and for npm that a self-hosted package belongs under private npm scopes.
   - A coverage-only hold says what Approve accepts (the unread files) or, when
     the check can't list everything, that the PR must be split. An Approve
     over per-update holds also names the unread files it accepts. Past the
     summary limit the output points to the Drydock review for the rest.

10. **Recheck age holds.** A review held only by age holds that all have a
    `passesAt` (no other reason, no unread coverage) re-runs on its own
    (`server/lib/dependency-review/recheck.ts`).

    - On completion it queues a recheck for the earliest `passesAt` plus one
      minute, in hops of at most 12 hours (the Cloudflare Queues delay cap);
      an early arrival queues the next hop without touching GitHub.
    - When due, it acts only if the PR is still open at the reviewed head and
      the review is still the held result on the run it was scheduled for (an
      approval, Re-run, push, or close makes it do nothing), then reviews the
      commit from the start on a new check run under the current policy and
      approvals.
    - A redelivered recheck resumes only the attempt it started (its stored
      progress names the run it rechecks), while that attempt is queued or
      past its lease; it never restarts a review anything else touched since.
    - A failed send is logged (`dependency_review.recheck_not_scheduled`). A
      lost recheck only means the hold stays until someone presses Re-run or
      pushes; nothing passes because of it.

## Approval

The Approve button sends `check_run` `requested_action` to the App. GitHub
signs the webhook and names who clicked (`sender`). The app id on the run must
be this deployment's, and the review is looked up through the installation, so
one account can't reach another's review. The clicker needs `write`,
`maintain`, or `admin` on the repository, the same bar as merging, and the PR's
head must still be the reviewed commit, so nobody approves bumps they weren't
shown. For the same reason Approve is offered only when the review finished its
passes, the check shows every open hold in full (at most 100, inside the
summary limit), names every unread file, and GitHub listed all of the PR's
files; a PR holding more asks for smaller PRs, and a click on it is refused. A
click on a run a Re-run has since replaced approves nothing. A refused click
changes nothing and is logged (`dependency_review.approval_refused`); GitHub
gives the clicker no feedback, so the check stays held.

An approval is stored per repository per exact change
(`dependency_review_approvals`: ecosystem, name, from, to, and source). The
source keeps approvals from crossing between different bytes:

| Source | Change |
| --- | --- |
| `public` | A public bump, including a proven pin or a proven mirror bump |
| `private` | A bump from a declared private registry (already there at the base, or new) or a private scope |
| `remote` | A git, URL, tarball, or other remote source |
| `mirror:<digest>` | An unproven mirror bump; the digest is a sha256 of its pinned hashes |
| `pin:<digest>` | A public bump whose pin did not match the public release, or that has no usable pin where its format always writes one |

Approving `@corp/x` from a private registry doesn't approve the same versions
from npm, and approving an unproven pin covers those hashes only; an approval
recorded as `private` doesn't match a change now placed as remote. A rebase,
regroup, or new commit merging the same change keeps the approval; another
version is another change. A coverage-only approval stores no change, so the
next commit with the same unread file holds again. Each approval writes the
`dependency_review.approved` audit event (with the GitHub login, not a Drydock
user) together with the stored approvals, before the check is updated; a
retried approval whose check update failed republishes it.
Re-running an individual check (`check_run.rerequested`) or using GitHub's
**Re-run all checks** (`check_suite.rerequested`) reviews the recorded head
again from the start against the current policy and approvals. A suite re-run
must name this App and a recorded review in the same installation, repository,
and head.

## Configuration

### Rollout flag

The `dependency-review` Flagship flag (default off) decides which organizations
are offered dependency review (`server/lib/dependency-review/flag.ts`). Outside
it, `/api/v1/dependency-reviews` answers 404, the dashboard hides the
Dependencies link and settings (`GET /api/v1/organizations` carries
`dependencyReview`), and a `pull_request` delivery posts nothing, not even a
skip. A failed lookup reads as off. Existing holds stay approvable; a
repository that required the check stops getting it on new PRs. Without a
`FLAGS` binding (self-hosting) every organization is offered it and still turns
it on in settings.

### Settings

Settings → Integrations → Dependency review (`/api/v1/dependency-reviews`).
Members read it, and owners and admins (`roleCanManageIntegrations`) change it.
Each change writes `dependency_review.settings_updated`. The policy is stored as
JSON and parsed field by field, so a missing or invalid field takes that
field's default (one bad value cannot switch every hold off) and a new field
needs no migration.

| Field | Default | Accepts |
| --- | --- | --- |
| `unreadMinimumAgeDays` | 3 | A whole number of days from 1 to 90, or `null` (off; the form's empty field) |
| `publicMirrors` | none | Up to 10 URL prefixes of registries that only proxy public npm or PyPI |
| `privateRegistries` | none | Up to 10 URL prefixes of the organization's own registries |
| `privateScopes` | none | Up to 50 npm scopes written like `@your-company` (lowercased) |

The settings API refuses, with a message, an age out of range, a list over its
limit, a URL that isn't plain https (a user name, password, query, or fragment),
a malformed scope, and a URL that is both a mirror and a private registry or
sits under one listed as the other. Each prefix is stored ending in `/`, so
`…/npm` cannot also match `…/npm-private`.

Naming a mirror sends the names and versions resolved from it to the public
npm registry or PyPI, to prove their hashes. For pnpm, whose lockfile records
no URL, that is every name the repository routes to the mirror, so list scopes
the organization hosts itself behind the mirror, or whose registry is set
outside the repository, under `privateScopes`. A mirror entry whose hashes
don't match, and every Yarn Berry entry from a mirror, is treated like a git
or URL source. A declared private registry is never contacted and its names
never leave the organization.

A registry that also proxies the public registry must be declared a mirror,
not a private registry: bumps from a private registry are not reviewed. A
release the PR moves onto a declared private registry from the public registry
or a mirror is a remote source, not exempt.

A registry or proxy that is neither declared is a remote source, so under the
default policy every bump resolved through it holds until approved. Declare a
pass-through proxy as a mirror to have its bumps proven and diffed, or the
organization's own registry as private to exempt it from the age fallback.

Extra bot logins identify trusted dependency automation, such as self-hosted
Renovate, whose account may not have repository collaborator permission. Human
repository writers need no allowlist entry. List only trusted automation: these
logins bypass the human author and sender permission checks.

The GitHub App needs **Checks: read and write**, **Pull requests: read**, and
**Contents: read**, and the **Pull request**, **Check run**, and **Check
suite** events (`self-hosting.md`). Until each installation's owner accepts
added permissions, reviews there fail with the check-create error in the
logs.

A deployment with a custom `NPM_REGISTRY` has no public egress: nothing is
diffed, no pin is proven, and no publish time is known. Every pinned bump is an
unverified pin, and under the default policy every public bump holds until
approved. Its operator either approves
each update or turns the minimum age off (leave the field empty), which lets
unreviewed bumps and new packages pass unless `holdOnUnreviewed` or
`holdOnNewPackages` holds them.

To enforce the check, add **Drydock dependency review** as a required status
check in the repository's branch protection or ruleset, with the Drydock App
as its source. Auto-merge (Dependabot `auto-merge`, Renovate `automerge` with
`platformAutomerge`) then merges clean bumps and waits on held ones.

## Data and limits

- Review detail responses include `coverage.unreadLockfiles` and
  `coverage.listingComplete`; the dashboard names unread files and incomplete
  listings even when the review recognizes no version changes, and labels
  updates the way the check does.
- At most 500 bumps are stored per review, open holds first; `bump_count` and
  `held_count` keep the review's real totals, so the detail page says when it
  shows only part. The detail response also returns `approvable`, computed by
  the same `listsEveryHold` the approval handler applies.
- `dependency_review_settings`: one row per organization. `dependency_reviews`:
  one per (installation, repository, head sha), with a bounded `bumps_json`
  (500 entries, holds first) of names, versions, verdicts, and redacted
  evidence. Check-run events find their review by the run's `external_id`
  (the review id) within the installation and repository.
  `dependency_review_approvals`: one per approved change per repository.
- `dependency_reviews.attempt` counts claims and fences each pass's writes.
  `dependency_reviews.progress_json` holds a running review's
  policy-independent per-bump outcomes (evidence, uncached diff outcomes,
  publish times, proofs, cold-diff starts) and its collection when that fits
  in 300,000 characters. It is kept between passes and across a lease takeover,
  cleared on completion, failure, or supersession and when a Re-run or a claim
  of a failed or superseded review starts over, and reset by an age recheck to
  fresh progress naming the run it rechecks.
- The check summary is capped below GitHub's 65,535-character field limit, at
  100 entries per section. Every package name, version, path, rule id, and
  reason renders inside a code span with control, bidi, and zero-width
  characters collapsed.
- What leaves the organization: public package names and version pairs, to
  the public registries the diff already reads, for diffs, pin proofs, and
  publish-time lookups. Names and versions resolved from a declared mirror go
  there too, for the hash proof. Names in a declared private scope, bumps from
  a declared private registry, and remote sources are never sent, and no
  mirror or private registry host is contacted. The shared result cache means a
  public pair one organization diffed is cached for `/diff` visitors, the same
  as a browser visit to that pair.
- The installation token only goes to `api.github.com`; pagination refuses a
  `Link` to any other host, and a 3xx (a renamed or transferred repository)
  fails the review without a retry.
- Analytics: `dependency_review.completed` (conclusion, duration across every
  pass of the attempt, bump and held counts) and `dependency_review.approved`
  (approved count). See `product-analytics.md`.

## Measured

`pnpm run eval:dependency-review-replay` on 2026-11-10: 180 Dependabot and
Renovate PRs from 12 public repositories, 146 of them with an npm or PyPI bump
(2,092 bumps). It is a sample of public repositories on one date, not a target
or a guarantee: a repository's own rate will differ, and lockfile-maintenance
PRs carry far more bumps than single-package ones.

| Policy | PRs with bumps held | All PRs passing with an unvouched bump | Holds per held PR (median / p90 / max) |
| --- | --- | --- | --- |
| Defaults with the age fallback off | 40.4% | 8.9% | 1 / 6 / 23 |
| Defaults (3-day age fallback, unread coverage holds) | 45.2% | 5.6% | 1 / 17 / 73 |
| Every hold switch on | 52.1% | 0% | 2 / 38 / 125 |

- Default policy, held PRs per reason: release risk 41, dependency added 40,
  too new 17, unread coverage 14, native binary added 7. Ten held on coverage
  alone (uncovered manifests, an unparsed `bun.lock`); four on age alone (one an
  unverified pin held until approved, three passed within 70 hours).
- Pin proofs: 1,751 of 1,753 strong pins matched the public registry (both
  misses PyPI); 330 Yarn Berry bumps had no comparable pin.
- Bumps per PR: median 2, p90 41, max 292; one PR with bumps in five needs
  more than one pass on a cold cache. Cold-diff CPU (local Node, not Workers):
  median 211 ms, p90 1.6 s, max 115 s; PyPI pairs median 1.2 s, npm 194 ms.

## Not covered

- Lockfiles other than `package-lock.json`/`npm-shrinkwrap.json` (v2 and v3;
  v1 is unread), `pnpm-lock.yaml`, `yarn.lock`, `uv.lock`, and requirements
  files. The npm and PyPI ones (`bun.lock`, `poetry.lock`, `Pipfile.lock`,
  `pdm.lock`) are named as unread and hold. Other ecosystems' PRs (GitHub
  Actions, Docker, Go) change no lockfile Drydock reads and pass as **No npm or
  PyPI dependency updates**; that result covers only the supported npm and
  PyPI inputs.
- Yarn Berry records no comparable pin, so its public bumps rely on the
  registry route alone, and its entries under a mirror are never proven: they
  are remote sources and, while the age fallback is on, hold until approved.
  Requirements without `--hash` likewise rely on the route.
- A requirements file pulled in by `-r`/`-c` under a name Drydock doesn't
  treat as requirements (such as `-r deps.prod` in an unchanged
  `requirements.txt`) is not read when only that file changes.
- A release Drydock cannot diff (too large, or a diff that ended its pass
  twice) passes once it reaches the minimum age; `holdOnUnreviewed` holds it
  instead.
- A PyPI project whose project-wide JSON metadata exceeds 16 MiB can't have a
  pin proven or a publish time read, so its bumps hold until approved. A uv
  proof needs every pinned file still on PyPI, so a release that later deletes
  a file holds from then on.
- npm lockfile entries left without `integrity` have no usable pin, so their bumps hold while the age fallback or
  `holdOnUnreviewed` is on.
- The age fallback uses the registry's publish time. A version published under
  a non-default dist-tag and promoted later has already aged by then; every
  release-age cooldown shares this limit.
- Up to 500 reviewable bumps per review. The rest are `over-cap` and, while
  the age fallback is on, hold until approved.
- Resolution settings outside the files Drydock reads (environment
  variables, CI configuration, user-level config) are invisible, including
  registries and proxies set there; `privateScopes` is the only way to keep
  such names from being treated as public.
- Renovate branch automerge (`automergeType: branch`) opens no PR, so no
  review runs and the required check doesn't pass on the branch, unless
  someone with write access opens a PR from it, which runs dependency review.
- Fork contributions. Dependency review covers branches in the installed
  repository only. A nonwriter's PR from someone else's branch cannot create a
  review row or earn a passing skip on that branch's commit.
- New packages have no diff. They are listed, and hold under
  `holdOnNewPackages` or while younger than the minimum age.
- Step 2 relies on GitHub reading the newest check run of a name on a commit,
  as GitHub documents it.
