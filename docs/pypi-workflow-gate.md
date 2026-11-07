# PyPI workflow gate

PyPI releases use GitHub deployment protection to review immutable wheels and sdists before publishing. **Authority:** enforced. **Owner:** `server/lib/ecosystems/pypi/workflow-gate.ts`.

## At a glance

| Thing | Owner file | Who may call / trigger | Pinned by (test) |
| --- | --- | --- | --- |
| PyPI candidate identity and grouping | `server/lib/ecosystems/pypi/workflow-gate.ts` | Shared workflow gate | `test/pypi.test.mjs` |
| Artifact selection and hashing | `server/lib/github-app/artifacts.ts` | Signed deployment-protection event | `test/github-app-artifacts.test.ts` |
| Sandbox routing | `server/lib/workflow-gates/resolve.ts` | Auto-detect release target | `test/github-app-artifacts.test.ts` |
| Published baseline | `server/lib/ecosystems/pypi/acquire.ts` | PyPI scan pipeline | `test/pypi.test.mjs` |

PyPI has no registry-staged artifact; this gate is its only review-before-publish path. Shared webhook ingestion, persistence, SHA-256 recomputation, callbacks, 2FA, fan-out, notifications and timeouts belong to [workflow gates](./workflow-gates.md).

## Contract

### Release set

| Thing | Contract |
| --- | --- |
| Maintainer manifest | None; CI builds and uploads distributions, not a Drydock manifest |
| Single upload | `pypi-release-candidate` contains wheels, sdist and checksums |
| Large release | `pypi-release-candidate-*` shards; each wheel/sdist gets one bounded shard |
| Recognized files | Every `.whl`, `.tar.gz`, `.tgz` in selected upload/family is reviewed; `SHA256SUMS` is ignored |
| Identity | Wheel `METADATA` / sdist `PKG-INFO`, parsed in credentials-free sandbox |
| Grouping | PEP 503 normalized package name; one scan per package against its own baseline |
| Version consistency | Every file exposes Name/Version; files in one normalized-name group agree on version; distinct names form separate candidates |
| Internal manifest | Synthesized `drydock.release-artifacts.v1`, `ecosystem: "pypi"`, parsed identities and recomputed digests |
| Provenance | Reviewed SHA-256 in report Provenance, scan-detail API (`summary.stagedPublish`) and `report.json` (`provenance.artifacts[].sha256`) |
| Decision | Every package needs approval; rejecting one blocks the whole deployment |
| Analysis | Shared diff, risk, redaction and organization-controlled AI review |

`pypiAdapter` prepares artifacts, acquires baselines, runs `pyPiReleaseFindings` and emits provenance via `summarizeDetails` (`server/lib/ecosystems/pypi/index.ts`). AI uses the shared `ai-review` killswitch in `server/lib/scan/pipeline.ts`; AI cannot downgrade deterministic findings.

### Byte continuity

| Link | Required behavior |
| --- | --- |
| Build | `python -m build`; record each output in `dist/SHA256SUMS`; upload distributions and checksum file |
| Review | Drydock downloads immutable GitHub artifact bytes and independently computes SHA-256 |
| Publish | Download same immutable artifact; `sha256sum --check --strict` fails closed on drift before calling PyPI; remove checksum files before upload |
| Audit | Build digest = Drydock provenance digest = publish digest |
| Scope | Repository-owned checksum step holds only while workflow retains it; never rebuild after the gate, because timestamps/tools/ordering can change bytes |

### Detection and selection

| Release target / content | Behavior |
| --- | --- |
| Pinned `ecosystem: "pypi"` | Optional; bypass content detection |
| Auto-detect tarball | Root `PKG-INFO`, directly or under single top-level directory → PyPI sdist; root `package.json` → npm |
| Nested vendored `PKG-INFO` | Does not claim archive as PyPI |
| `.vsix` | Extension routes to VS Code; unambiguous with tarballs |
| Mixed monorepo | Auto-detect can route npm, PyPI and VS Code candidates together |
| Genuine multi-ecosystem collision | Fails closed with `artifact_identity_inconsistent`; pin ecosystem to resolve |
| Pinned PyPI; artifact override blank | Exact `pypi-release-candidate` plus every `pypi-release-candidate-*`; unrelated artifacts ignored |
| Auto-detect; no artifact narrowing | Every non-expired run artifact; smaller budget prevents downloading unrelated CI output |
| Shard families | PyPI only; npm/VS Code match conventional name exactly |

| Budget | Constant and owner |
| --- | --- |
| Auto-detect: 20 distributions | `MAX_RELEASE_ARTIFACTS` in `server/lib/github-app/artifacts.ts` |
| Auto-detect: 50 MiB artifact ZIP total | `MAX_TOTAL_ARTIFACT_ZIP_BYTES` in `server/lib/github-app/artifacts.ts` |
| Narrowed large release: 128 distributions | `MAX_STREAMED_RELEASE_ARTIFACTS` in `server/lib/github-app/artifacts.ts` |
| Narrowed large release: 768 MiB artifact ZIP total | `MAX_STREAMED_TOTAL_ARTIFACT_ZIP_BYTES` in `server/lib/github-app/artifacts.ts` |

### Baseline

| Condition | Comparison / result |
| --- | --- |
| Comparable release exists | `pickPyPiBaselineRelease` selects currently-published version from public PyPI JSON metadata; `acquireBaselinePyPi` fetches matching platforms anonymously from `files.pythonhosted.org` |
| Many platform wheels | Download and sandbox-parse sequentially, never concurrently |
| No comparable published release | No-baseline full-tree review |
| PyPI metadata fetch fails (non-2xx, timeout, oversized body) | Treated as no baseline (`metadata-unavailable`): full-tree review, every file reads as added, no `comparisonSkipped`; recommendation computed normally (`server/lib/ecosystems/pypi/broker.ts`) |
| Baseline download or parse error | Scan fails; gate stays pending (`server/lib/workflow-gate-job.ts`) |
| Published baseline exceeds download budget (more than `MAX_PYPI_BASELINE_ARTIFACTS` = 128 artifacts or `MAX_PYPI_BASELINE_ADVERTISED_BYTES` = 768 MiB advertised, `server/lib/ecosystems/pypi/acquire.ts`) | Set `BaselineInfo.comparisonSkipped: "baseline-too-large"`; findings have `unknown` package context, not release delta; report leads with “no baseline to compare” and skipped version |
| Comparison skipped | Advisory recommendation `manual_review`; the gate stays pending until a maintainer decides (Drydock never auto-decides a gate) |

### Single-upload workflow

Map repository + environment in Organization settings → GitHub App; attach Drydock as custom deployment protection on `pypi`. The `environment: pypi` job waits until every package is approved. PyPI Trusted Publishers should use that same environment.

```yaml
jobs:
  build-release-artifacts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: python -m build
      - run: |
          shopt -s nullglob
          cd dist && sha256sum *.whl *.tar.gz *.tgz > SHA256SUMS
      - uses: actions/upload-artifact@v4
        with:
          name: pypi-release-candidate
          path: |
            dist/*.whl
            dist/*.tar.gz
            dist/*.tgz
            dist/SHA256SUMS
          if-no-files-found: error

  publish:
    needs: build-release-artifacts
    runs-on: ubuntu-latest
    environment: pypi
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/download-artifact@v4
        with: { name: pypi-release-candidate, path: dist }
      - run: cd dist && sha256sum --check --strict SHA256SUMS
      - run: rm dist/SHA256SUMS
      - uses: pypa/gh-action-pypi-publish@release/v1
```

### Matrix workflow

Pin the target to PyPI, leave its artifact-name override blank and upload each matrix result separately. Drydock processes shards one at a time without omitting distributions or provenance. Build the sdist once in its own job: repeated identical filenames/bytes deduplicate; differing bytes for one filename fail closed.

```yaml
jobs:
  build-wheel:
    strategy:
      matrix:
        include: # project-specific
          - { shard: linux-x64, os: ubuntu-latest }
          - { shard: macos-arm64, os: macos-14 }
          - { shard: windows-x64, os: windows-latest }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - run: ./ci/build-wheel "${{ matrix.shard }}" # writes one or more dist/*.whl
      - run: cd dist && sha256sum *.whl > "SHA256SUMS-${{ matrix.shard }}"
      - uses: actions/upload-artifact@v4
        with:
          name: pypi-release-candidate-${{ matrix.shard }}
          path: dist/
          if-no-files-found: error

  build-sdist:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: python -m build --sdist
      - run: cd dist && sha256sum *.tar.gz > SHA256SUMS-sdist
      - uses: actions/upload-artifact@v4
        with:
          name: pypi-release-candidate-sdist
          path: dist/
          if-no-files-found: error

  publish:
    needs: [build-wheel, build-sdist]
    runs-on: ubuntu-latest
    environment: pypi
    permissions:
      id-token: write
    steps:
      - uses: actions/download-artifact@v4
        with:
          pattern: pypi-release-candidate-*
          merge-multiple: true
          path: dist
      - run: |
          cd dist
          for sums in SHA256SUMS-*; do sha256sum --check --strict "$sums"; done
          rm SHA256SUMS-*
      - uses: pypa/gh-action-pypi-publish@release/v1
```

## Invariants

1. Every wheel/sdist is reviewed and has a recomputed SHA-256 before scan creation (`server/lib/github-app/artifacts.ts`).
2. A missing Name/Version never silently ships; it rejects with `artifact_identity_missing` (`server/lib/ecosystems/pypi/workflow-gate.ts`).
3. Version skew within a normalized package group never silently ships; it rejects with `artifact_identity_inconsistent` (`server/lib/workflow-gates/group-candidates.ts`).
4. Byte continuity requires publishing the reviewed immutable files; the workflow must never rebuild after approval (checksum steps above).

## Failure modes

| Condition | Cause | What happens | Fix |
| --- | --- | --- | --- |
| Missing metadata | Distribution lacks Name/Version | `artifact_identity_missing`; gate rejects | Produce valid wheel/sdist metadata |
| Conflicting package version | Same normalized name has different versions | `artifact_identity_inconsistent`; gate rejects | Build one version per package |
| Conflicting duplicate filename | Matrix rebuilt same distribution with different bytes | `artifact_identity_inconsistent`; gate rejects | Build sdist once; give each distribution one shard |
| Ambiguous auto-detection | Archive claims multiple ecosystems | Fails closed | Pin release target ecosystem |
| Large auto-detect upload | Run is not narrowed to release family | Smaller budget applies | Pin PyPI target and use conventional shard family |
| Digest mismatch at publish | Downloaded bytes differ from checksum | CI fails closed before PyPI upload | Download the same immutable reviewed artifacts |

## Change checklist

| If you change | Also update | Run |
| --- | --- | --- |
| Artifact names, budgets or routing | [Workflow gates](./workflow-gates.md) and workflow examples above | `pnpm exec vitest run --project node test/github-app-artifacts.test.ts test/pypi.test.mjs` |
| Baseline selection or scoring | [Diff baseline](./diff-baseline.md) and no-baseline recommendation | `pnpm exec vitest run --project node test/pypi.test.mjs test/review-risk.test.mjs` |
