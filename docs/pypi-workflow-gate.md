# PyPI Workflow-Gate Support

PyPI support uses a different product shape from npm staged publishing.

npm owns a pending staged tarball, so Drydock can fetch `/-/stage/<stage-id>/tarball` and leave final approval in npm. PyPI does not expose an equivalent registry-staged artifact. The PyPI path is therefore **workflow gate mode**: CI builds wheels/sdists first, uploads a manifest plus artifacts for review, and a GitHub Environment blocks the publish job until the reviewed artifact digests are approved.

Official references:

- PyPI Trusted Publishers: `https://docs.pypi.org/trusted-publishers/`
- PyPI GitHub Actions publishing setup: `https://docs.pypi.org/trusted-publishers/using-a-publisher/`
- PyPI project JSON API: `https://docs.pypi.org/api/json/`
- Python wheel format: `https://packaging.python.org/specifications/binary-distribution-format/`

## Implemented foundation

The repo now has a backend-only PyPI foundation in `server/lib/pypi.ts`:

- validates `drydock.release-artifacts.v1` manifests for `ecosystem: "pypi"`;
- normalizes PyPI project names using the PEP 503-style `[-_.]+ -> -` convention;
- recognizes wheel (`.whl`) and sdist (`.tar.gz`, `.tgz`) artifacts;
- parses wheel `METADATA`, `WHEEL`, and `RECORD` evidence from ZIP archives;
- strips the common root directory from sdists before reading `PKG-INFO`;
- compares flattened candidate artifact files against optional previous artifacts using stable wheel/sdist namespaces instead of versioned artifact filenames;
- requires the reviewed artifact path set to exactly match the manifest artifact path set;
- adds PyPI-specific deterministic findings for metadata mismatches, missing wheel `RECORD`, `.pth` startup hooks, custom `setup.py` install commands, and `.pyd` native extensions;
- fetches PyPI project metadata from `GET /pypi/<project>/json`;
- selects a default PyPI baseline release from `info.version`, falling back to newest non-yanked upload time;
- extracts wheel/sdist download metadata and SHA-256 digests from non-yanked PyPI release files;
- restricts public PyPI artifact downloads to `https://files.pythonhosted.org`.

The sandbox parser now supports safe ZIP archive parsing for wheels in addition to npm-style gzipped tar archives. ZIP downloads are read through a bounded stream before parsing; ZIP parsing then reads the central directory, accepts stored and deflated entries, rejects traversal paths and Zip64, enforces file/expanded-size caps, and keeps package contents as bounded text samples or binary metadata.

## Manifest contract

The manifest is the boundary between the GitHub workflow and Drydock:

```json
{
  "schema": "drydock.release-artifacts.v1",
  "ecosystem": "pypi",
  "package": "example-package",
  "version": "1.2.3",
  "artifacts": [
    {
      "path": "dist/example_package-1.2.3-py3-none-any.whl",
      "sha256": "..."
    },
    {
      "path": "dist/example_package-1.2.3.tar.gz",
      "sha256": "..."
    }
  ]
}
```

The publish job must verify these digests immediately before publishing. A reviewed wheel/sdist must be the exact file uploaded to PyPI; rebuilding after the gate breaks the security boundary.

## Target workflow

```yaml
jobs:
  build-release-artifacts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: python -m build
      - run: sha256sum dist/* > drydock-sha256.txt
      - run: python scripts/write-drydock-manifest.py
      - uses: actions/upload-artifact@v4
        with:
          name: pypi-release-candidate
          path: |
            dist/*
            drydock-manifest.json
            drydock-sha256.txt

  publish:
    needs: build-release-artifacts
    environment: pypi
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: pypi-release-candidate
      - run: sha256sum --check drydock-sha256.txt
      - uses: pypa/gh-action-pypi-publish@release/v1
```

PyPI strongly encourages configuring a GitHub Environment for Trusted Publishers. Drydock should attach to that same environment as a GitHub custom deployment protection rule when the GitHub App work lands.

## Remaining work

- Add the GitHub App installation model and repository/environment mapping.
- Handle `deployment_protection_rule` webhooks.
- Fetch GitHub Actions artifacts and `drydock-manifest.json` with installation credentials.
- Run the existing PyPI candidate review helper from the gate handler.
- Persist workflow-gate reviews separately from npm `stageId` scans or generalize the scan schema around `release_candidate` records.
- Add UI for workflow-gate reviews and GitHub/PyPI setup guidance.
- Verify artifact digests in the gate path before scanning and record those digests in the report payload.
- Compare against prior PyPI release artifacts by downloading selected `files.pythonhosted.org` URLs through the exact public-artifact allowlist.

Until those items land, the PyPI code is a review engine foundation and testable backend slice, not an end-to-end publish gate.
