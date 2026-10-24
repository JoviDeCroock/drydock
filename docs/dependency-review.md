# Dependency review (evidence-based cooldown)

Release-age cooldowns (pnpm `minimumReleaseAge`, Renovate `minimumReleaseAge`,
uv `exclude-newer`) delay every dependency update by the same number of days
and hope someone else notices a bad release first. Dependency review replaces
the timer with the diff: the Drydock GitHub App posts a **Drydock dependency
review** check on each Dependabot or Renovate PR. A version change that adds
no capability passes and can auto-merge the same day. A change that adds one
is held until someone with write access to the repository reads the diff and
approves it.

The free PR comment workflow (`dependency-pr-diff-links.md`) shows the same
diffs without the App. It informs; this check decides, because a repository can
make it required.

## Flow

1. GitHub sends `pull_request` (`opened`, `synchronize`, `reopened`) to
   `POST /webhooks/github`. `server/lib/dependency-review/webhook.ts` records a
   review only when the installation is active and mapped to an organization,
   the organization turned dependency review on, the PR's author is
   `dependabot[bot]` or `renovate[bot]` with account type `Bot` (or a login
   the organization listed, for self-hosted Renovate), and the head branch is in
   the same repository. A fork's head is someone else's commit. Each
   (installation, repository, head sha) gets one `dependency_reviews` row. A
   redelivered event enqueues a row again when it is `queued` or `failed` (the
   first enqueue may have been lost), `superseded` (the PR was reopened), or
   `running` past its 15-minute claim lease (its worker died). A completed row
   is left alone. A PR anyone else opened gets a `skipped` check, which GitHub
   counts as passing, so a required check doesn't block people's own PRs.
2. **Newest run wins.** Check runs belong to a commit, and GitHub reads the
   newest run of a name. Anyone can open a PR from a fork at a bot PR's head
   commit, so a skip is never posted on a commit that has a review. A skip is
   created `in_progress`, which doesn't pass, and completed `skipped` only after
   a second look finds no review; one that dies part way never passes. A skip on
   a commit that is the tip of a branch in the repository (always so for a
   same-repo PR, and possible from a fork) completes `skipped` only when the
   PR's author and the event's sender (the pusher, on a new commit) both have
   write access, and `cancelled` otherwise. Renovate pushes its
   branch before opening the PR and can automerge it on a green check, and
   anyone who can read the repository can open a PR from that branch. An author
   stuck behind such a skip pushes a new commit. If a
   review appeared meanwhile, the skip completes `cancelled` and the review
   re-runs (a re-run asked for while the review is running is retried, not
   dropped, and Re-run on the cancelled skip re-runs the review too). Before
   publishing, the review lists the commit's Drydock runs (`check_name` plus
   the App id). When the newest is a skip, it publishes to a fresh run and
   closes its old one `cancelled`. When the newest is a run of the same review
   that the review records, a later attempt (a Re-run) owns the result; one it
   doesn't record (a create whose response was lost) is adopted. In the branch rule, set the required
   check's source to the Drydock App, so another App can't post a passing run
   under the same name.
3. The route enqueues `{ kind: "dependency_review" }` on `SCAN_QUEUE`. The
   consumer (`server/lib/dependency-review/job.ts`) mints an installation token,
   creates the check run in progress, and confirms the PR is still open at that
   head. The claim is compare-and-set: a queued, failed, or superseded review,
   a completed one only for Re-run, and a running one only past its lease. A
   duplicate message therefore exits instead of posting a second run, and a
   retryable failure gives the claim back before the queue retries. Webhook
   deliveries can arrive out of order, so only the head comparison
   decides which commit is stale. A commit that is no longer the open PR's head
   is superseded and its check ends `cancelled`, not `neutral`, which GitHub
   counts as passing. Reopening the PR or pressing Re-run reviews it again.
4. **Collect.** It lists the PR's files, reads each supported lockfile at the
   merge base and at the head through the contents API, and diffs the two
   snapshots (`server/lib/dependency-review/lockfiles/`). Direct and transitive
   packages both count: worms spread through transitive dependencies. A
   package version the PR adds with nothing to compare against is a _new
   package_. Lockfile bytes are repository data and are only parsed. A lockfile whose
   bumps are unknown is _unread_, and an unread lockfile holds the review under
   `holdOnUnreviewed`: an npm or PyPI format Drydock doesn't parse (`bun.lock`,
   `poetry.lock`, `Pipfile.lock`, `pdm.lock`, `pylock*.toml`), one past the
   20-per-review cap, one over 8 MiB, one the PR deletes, or one the parser
   couldn't finish (malformed, over its entry caps, a requirements file with a
   non-PyPI index option, or a name pinned to two versions). An incomplete
   snapshot diffs to nothing, which must not read as "nothing changed". A
   dependency manifest (`package.json`, `pyproject.toml`, `setup.cfg`,
   `setup.py`, `Pipfile`, pip-tools `*.in`) is unread too unless the PR changes
   a parsed lockfile of its ecosystem that covers it: one in the same
   directory, or one above it that records the directory as a workspace (npm
   `packages`, pnpm `importers`, Yarn `workspace:` entries or the root
   `workspaces` globs, a uv source path). A requirements file covers only its own
   pip-tools input (`X.in` for `X.txt`), or a manifest its `pip-compile` or
   `uv pip compile` header line names. Otherwise its new versions were never
   resolved where Drydock can see them. A requirements file whose unpinned lines
   (ranges such as `foo>=1.3`, URLs, VCS lines, `-r` includes) changed is unread
   too. pip follows `-r`/`-c` into files of any name, so any other `.txt` a bot
   changed is read as requirements: one that isn't holds on its text change.
5. **Private names stay home.** An npm name the repository's committed
   `.npmrc` or `.yarnrc.yml` routes to a non-public registry (a scope or the
   default) is never diffed, the same rule as the PR comment workflow. Neither is
   a lockfile entry resolved from a non-public registry on either side of the
   change (an npm or Yarn `resolved` URL or a pnpm `resolution.tarball` on another host, a uv
   registry other than PyPI), nor a git, GitHub, or URL source, whose version is
   its resolved ref. Only sources whose code is in the PR itself (`file:`,
   `link:`, `workspace:`, paths) are left out. All of these stay in the review as _unreviewed_
   (`private-source`) and hold under `holdOnUnreviewed`, because dropping them
   would let their change pass unseen. A repository that proxies every package
   through a mirror therefore holds every bump until it turns `holdOnUnreviewed`
   off. Config set outside the repository (environment, user-level files,
   Dependabot `registries:`) is invisible here.
6. **Diff.** Each bump runs through `loadPublicPackageDiff`, the same pipeline,
   rules, and versioned KV cache as `/diff`. Direct bumps go first. At most 40
   bumps are diffed per review, four at a time, inside an eight-minute budget.
   The rest are _unreviewed_ (`over-cap`, `timed-out`), as are bumps the public
   diff can't serve (`not-found`, `unsupported`, `failed`). A deployment with a
   custom `NPM_REGISTRY` diffs nothing (`publicDiffEgressAllowed`, the same
   killswitch as the anonymous `/diff` surface), so every bump is unreviewed.
7. **Decide.** `server/lib/dependency-review/policy.ts` reads the release delta
   only. Context findings describe code the previous version already shipped,
   and this bump does not introduce them. The organization's policy decides
   which facts hold:

   | Policy field             | Default | Holds when the new version…                                                         |
   | ------------------------ | ------- | ----------------------------------------------------------------------------------- |
   | `holdOnInstallScripts`   | on      | adds or changes `preinstall` / `install` / `postinstall`                            |
   | `holdOnNativeBinaries`   | on      | adds a native binary (magic-byte sniffed, or a native extension)                    |
   | `holdOnNewDependencies`  | on      | declares a dependency no section declared before                                    |
   | `holdOnNewBinCommands`   | on      | adds a `bin` command                                                                |
   | `holdAtReleaseRisk`      | `high`  | has release risk at or above the threshold (`null` turns it off)                    |
   | `holdOnUninspectedFiles` | on      | adds or changes files no rule read: minified JS, oversized bodies, unknown binaries |
   | `holdOnUnreviewed`       | on      | could not be diffed at all                                                          |
   | `holdOnNewPackages`      | off     | is a package with no previous version in the lockfile                               |

   `holdOnUninspectedFiles` and `holdOnUnreviewed` default on because a
   `success` is what auto-merge acts on. GitHub treats a `neutral` check as
   passing, so "we didn't look" must hold, not pass quietly. Images, fonts, and
   media are binary but inert and are not counted. Source maps aren't either.
   A file listing GitHub cut short (over 3,000 files, or fewer listed than the
   PR's `changed_files`) holds the review under `holdOnUnreviewed`, because a
   lockfile may have gone unread. A coverage notice on the diff counts as
   uninspected too. For PyPI that includes the wheels the diff did not read: it
   compares one wheel per side, so a package that ships compiled wheels for
   other platforms holds under `holdOnUninspectedFiles`.

8. **Publish.** The check completes `success` (nothing held, or every hold
   already approved) or `action_required` with an **Approve held updates**
   action. Its summary lists held bumps with their reasons, release risk, file
   counts, and the top findings, then unreviewed bumps, new packages, and clear
   bumps, each linked to its public `/diff` page (private-source bumps get no
   link). The title says "clear" only when every bump's diff was read and held
   nothing. `details_url` opens the review in the dashboard.

## Approval

The Approve button sends `check_run` `requested_action` to the App. GitHub
signs the webhook and names who clicked (`sender`). The app id on the run must
be this deployment's, and the review is looked up through the installation, so
one account can't reach another's review. The job then checks that the clicker
has `write`, `maintain`, or `admin` on the repository. That is the same bar as
merging, and a person who can merge could already bypass a non-required check.
It also checks that the PR's head is still the reviewed commit, so nobody
approves bumps they weren't shown. For the same reason Approve is offered only
when the check shows every open hold in full (at most 100, inside the summary
limit), names every unread lockfile, and GitHub listed all of the PR's files. A PR holding more says so and asks for smaller PRs, and a click on it
is refused. The approval message names the clicked run, so a click on a run a
Re-run has since replaced approves nothing.
A refused click changes nothing and is logged
(`dependency_review.approval_refused`). GitHub gives the clicker no feedback
channel, so the check simply stays held.

An approval is stored per repository per exact change
(`dependency_review_approvals`: ecosystem, name, from, to, and whether it came
from a private source, so approving `@corp/x` from a private registry doesn't
approve the same versions resolved from npm). A rebase, a regroup,
or a new commit that merges the same change keeps the approval without another
click. A different version is a different change. Each approval writes the
`dependency_review.approved` audit event together with the stored approvals,
before the check is updated. A retried approval whose check update failed
republishes it. The event carries the GitHub login, not a Drydock user. The check's **Re-run** button (`check_run` `rerequested`) runs
the review again against the current policy and approvals.

## Configuration

Settings → Integrations → Dependency review (`/api/v1/dependency-reviews`).
Members read it, and owners and admins (`roleCanManageIntegrations`) change it.
Each change writes `dependency_review.settings_updated`. The policy is stored as
JSON and parsed field by field with defaults, so a missing or invalid field
holds more, never less, and a new field needs no migration.

The GitHub App needs **Checks: read and write**, **Pull requests: read**, and
**Contents: read**, and must subscribe to the **Pull request** and **Check run**
events (`self-hosting.md`). Adding permissions to an existing App makes GitHub
ask every installation's owner to accept them. Until they do, check runs can't
be created and reviews fail with the check-create error in the logs.

To enforce the check, add **Drydock dependency review** as a required status
check in the repository's branch protection or ruleset, with the Drydock App
as its source. Auto-merge (Dependabot
`auto-merge`, Renovate `automerge` with `platformAutomerge`) then merges clean
bumps and waits on held ones.

## Data and limits

- `dependency_review_settings`: one row per organization. `dependency_reviews`:
  one per (installation, repository, head sha), with a bounded `bumps_json`
  (500 entries, holds first) of names, versions, verdicts, and redacted
  evidence. Check-run events find their review by the run's `external_id`
  (the review id) within the installation and repository.
  `dependency_review_approvals`: one per approved change per repository.
- The check summary is capped below GitHub's 65,535-character field limit, at
  100 entries per section. Every package name, version, path, rule id, and
  reason renders inside a code span with control, bidi, and zero-width
  characters collapsed.
- What leaves the organization: public package names and version pairs, to
  the public registries the diff already reads. The shared result cache means a
  public pair one organization diffed is cached for `/diff` visitors, the same
  as a browser visit to that pair.
- The installation token only goes to `api.github.com`. Listing pagination
  refuses a `Link` to any other host, and no request follows a redirect: a 3xx
  (a renamed or transferred repository) fails the review without a retry.
- Analytics: `dependency_review.completed` (conclusion, duration, bump and held
  counts) and `dependency_review.approved` (approved count). See
  `product-analytics.md`.

## Not covered

- Lockfiles other than `package-lock.json`/`npm-shrinkwrap.json`,
  `pnpm-lock.yaml`, `yarn.lock`, `uv.lock`, and requirements files
  (`requirements*.txt`, `constraints*.txt`, `requirements/*.txt`, and any other
  `.txt` a bot changes). The npm
  and PyPI ones (`bun.lock`, `poetry.lock`, `Pipfile.lock`, `pdm.lock`) are
  named as unread and hold. Other ecosystems' PRs (GitHub Actions, Docker, Go)
  change no lockfile Drydock reads and pass as "No reviewable package updates".
- Renovate branch automerge (`automergeType: branch`) opens no PR, so no
  review runs and the required check doesn't pass on the branch, unless
  someone with write access opens a PR from it, which skips the check like any
  person's PR.
- PRs opened by people. Only dependency bots' PRs are reviewed; the rest get a
  `skipped` check. A person's commit pushed onto a bot's PR is reviewed, because
  the PR's author is still the bot.
- New packages have no diff. They are listed, and hold only under
  `holdOnNewPackages`.
