# Dependency-artifact review

Drydock reviews the exact bytes of a candidate release. A release can also introduce third-party code with a one-line manifest change, while none of that dependency's bytes appear in the parent artifact. Dependency-artifact review closes that gap for newly added direct npm dependencies without installing or executing package code.

## Scope

The pass runs for npm staged-publish and workflow-gate reviews when a baseline `package.json` is available. `selectAddedDependencyDeclarations` selects, in deterministic section order:

- newly added `dependencies`;
- newly added `optionalDependencies`;
- newly added required `peerDependencies`;
- different-spec relocations or optional overrides that change the installed bytes;
- optional peers becoming required when their spec was not already installed.

It excludes development dependencies, optional peers, declarations already represented by the previous release's installed set, and all registry dependencies of a release with no baseline. Declared bundled children are inspected from their exact `node_modules/` subtree in the parent artifact rather than resolved from the registry. It reviews direct additions only; recursive transitive inspection is out of scope.

The existing `dependency.added` manifest finding remains in the report. Artifact findings are separate evidence about the bytes selected by that declaration.

## Resolution and acquisition

`server/lib/review/dependency-specs.ts` classifies a declaration as exact, range, dist-tag, or unresolvable. Empty and wildcard declarations resolve through `latest`; exact versions select only themselves; ranges select the highest satisfying published version; tags use the matching packument dist-tag. Git, URL, file, workspace, and otherwise unsupported specs fail visibly as unresolved.

`server/lib/ecosystems/npm/dependency-artifacts.ts` resolves and downloads only from the public npm registry, `https://registry.npmjs.org`. Localhost HTTP is allowed only in the explicit e2e environment. Packument and tarball requests are credential-free and never pass through `NpmStageGateway`; a private dependency therefore becomes an inspection gap instead of receiving the organization's token.

The pass is bounded per release:

- at most 8 dependency artifacts are inspected;
- at most 2 inspections run concurrently;
- the pass has a 30-second wall-clock budget;
- each tarball is capped at 25 MiB and 800 files.

Up to 64 selected declarations receive individual evidence rows across bundled and registry-backed dependencies together. If more declarations are selected, one aggregate `dependency.artifact-unavailable` finding records the omitted count so the report stays bounded without presenting the remainder as reviewed. Results retain declaration order even though acquisition is concurrent.

The sandbox parses bytes without lifecycle scripts, dependency installation, imports, builds, or active rendering. While raw dependency files are available, the ordinary deterministic scanner runs with npm entrypoint resolution. Raw files are then discarded.

## Evidence contract

Each persisted `DependencyEvidence` row records:

- the dependency name, section, declared spec, and parent-to-child path;
- an outcome: `inspected`, `unresolved-spec`, `no-matching-version`, `metadata-unavailable`, `fetch-failed`, `too-large`, `count-capped`, or `time-capped`;
- the review-time resolution kind, version, public tarball URL, registry integrity, and timestamp when resolution succeeded;
- recomputed SHA-256/SHA-512, file count, byte count, and integrity comparison when bytes were read;
- lifecycle, `gypfile`, and binary-entrypoint observations;
- the number of findings joined to that dependency.

A review-time range or tag resolution is a snapshot, not permanent provenance. Integrity disagreement is a critical inspection failure: untrusted bytes are not scanned as though the advertised artifact had been reviewed. A truncation or ambiguous archive still retains any higher-severity install-time behavior already proven by readable bytes while separately reporting the coverage gap.

Persisted and exported evidence is shape-validated. Retained tarball URLs must be credential-free public npm URLs (or localhost URLs in e2e data), so registry-controlled signed URLs and alternate hosts cannot enter a public report.

## Findings and risk

Findings produced inside a dependency preserve their ordinary deterministic rule IDs and carry structured dependency coordinates. Their synthetic file is namespaced as:

```text
dependency/<name>@<resolved-version>/<path>
```

That namespace is release-scoped but is never treated as a parent-package file in the diff workbench. Dependency findings are normally capped at `medium`; `file.secret-content` retains its scanner severity.

Two dependency-specific rules express the release-level conclusion:

| Rule ID                              | Severity               | Meaning                                                                                                                                                                                    |
| ------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dependency.install-time-capability` | `high` or `critical`   | An automatic install/build entrypoint combines with a non-test capability. Remote shell, credential plus network access, or obfuscated execution is critical; other combinations are high. |
| `dependency.artifact-unavailable`    | `medium` or `critical` | The exact dependency artifact could not be resolved, fetched, parsed, or inspected within a bound; a proven registry-integrity mismatch is critical.                                       |

The composer is `dependencyScanFindings` in `server/lib/review/rules/dependency-artifact.ts`. It reuses the production deterministic matcher, drops rules that are meaningless for a dependency sub-artifact (`file.outside-files-list` and `package-json.entrypoint-missing`), and stamps the current deterministic rules version. AI review may explain these findings but cannot downgrade them.

## Persistence and UI

The pipeline runs dependency acquisition after the parent release artifacts are resolved, then merges artifact findings into the ordinary finding/risk path. Redacted evidence is stored in the canonical `report.json`, exposed on scan detail as `dependencyEvidence`, and exported in `drydock.report.v2` as `dependencies.evidence`. Structured dependency coordinates are also retained on exported findings.

The authenticated scan view and public report use the same `DependencyReviewSection`. It distinguishes reviewed rows from manual-review gaps, shows exact/range/tag resolution honestly, and links an added `package.json` row to its dependency evidence card. Declaration identity includes section, name, and declared spec so the same package in multiple manifest sections remains tied to the correct artifact and findings. Risk-signal navigation selects that exact dependency card rather than trying to open a synthetic path in the parent diff.

## Verification

- `test/dependency-resolution.test.mjs` covers spec classification and highest-satisfying selection.
- `test/dependency-artifact-findings.test.mjs` covers namespacing, severity caps, install-time roll-ups, and unavailable evidence.
- `test/npm-dependency-artifacts.test.mjs` covers anonymous acquisition, integrity, budgets, and ordering.
- `test/fixtures/security-corpus/cases/dependency-artifact-*.json` and the npm frontier fixture exercise the production composer in the golden corpus and eval harness.
- `test/scan-pipeline-phases.test.mjs` covers pipeline integration and fail-visible adapter errors.
- `test/e2e/local-registry.spec.ts` covers the added-dependency flow and asserts that dependency registry requests carry no npm authorization.

## Follow-up scope

- recursive, depth- and node-bounded transitive inspection;
- lockfile-aware consumer review;
- re-evaluation after yanks, deletion, or new advisories;
- equivalent adapters for other ecosystems.
