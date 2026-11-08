# Sandbox archive parser

Untrusted tarballs, wheels, sdists, and VSIX files are parsed as streams inside a Dynamic Worker that never executes package code and never sees credentials. **Authority:** internal trust boundary. **Owner:** `server/lib/sandbox.ts`, `server/lib/tar-parser.js`.

## At a glance

| Thing | Owner | Pinned by |
| --- | --- | --- |
| Dynamic Worker + limits | `server/lib/sandbox.ts` | `test/sandbox-boundary-invariants.test.mjs` |
| Tar reader (node-tar parity) | `server/lib/tar-parser.js` | `test/tar-parser.test.mjs` |
| ZIP reader (wheel, VSIX) | `server/lib/sandbox.ts` | `test/zip-parser.test.mjs`, adapter tests |
| Retention budgets | `server/lib/sample-retention.ts` | — |
| Staged digest check | `evaluateStagedArtifactIntegrity` in `server/lib/ecosystems/artifact-integrity.ts` | — |
| Fixture writers | `test/helpers/archive-fixtures.ts` | `test/test-helper-invariants.test.mjs` rejects local copies |
| Parser-differential shapes | [`security-detection-corpus.md`](./security-detection-corpus.md) | corpus fixtures |
| Deeper property exploration | `pnpm run fuzz` | — |
| Reader parity with real consumers | `test/helpers/archive-consumers.mjs` | `test/archive-differential.test.mjs` ([below](#differential-harness)) |

## Limits

| Limit | Value | Constant | Over the limit |
| --- | --- | --- | --- |
| Per-file inspected body, and shared retained-bytes budget | 25 MiB each (manifests get 2× headroom on the shared budget) | `SANDBOX_MAX_TAR_BYTES` | over per-file: body skipped, hashed in passing, `content-skipped` with path, size, sha256; budget spent: hash-only + one `retention-tier` entry |
| Total stream (compressed wire **and** decompressed output) | 250 MiB | `SANDBOX_MAX_STREAM_TAR_BYTES` | parse fails closed; also the archive-digest cap |
| Full-inspection tier | 2,500 files | `SANDBOX_MAX_FILES` | later files recorded hash-only |
| Entries walked at all | 20,000 | `SANDBOX_MAX_ENTRIES` | parse fails: `archive contains too many files` |
| Persisted display sample | 128 KiB per file | `SCAN_FILE_SAMPLE_LIMIT` | `truncated` flag on the reviewed file's display sample |
| Baseline text sample | 1 MiB per file (8× display) | `BASELINE_TEXT_SAMPLE_LIMIT` | cut on a line boundary, flagged `baseline-truncated` |

Bulk demotions (budget spent, tier full) produce one `retention-tier` suspicious entry per cause, not one per file. Per-file `content-skipped` is reserved for bodies over the per-file limit.

## Tar reading rules (match node-tar, which `npm install` extracts with)

| Shape | Behavior |
| --- | --- |
| End of archive | two consecutive all-zero blocks |
| Header npm's reader rejects (bad checksum, undecodable base-256 field, empty path, linkname the type does not allow) | npm: block skipped without consuming its body, disclosed archive-wide; parses pip may read (PyPI, gate) fail closed, since CPython consumes the body or ends the archive there |
| PAX `size` | overrides the header size |
| `X` / `N` / `K` extended headers, 1 MiB metadata limit | as node-tar |
| Typeflag `7` | regular file |
| Root stripping | npm and atpm: `strip: 1` (first component, any name); PyPI: keep the sdist root; workflow gate with unknown ecosystem: strip a literal `package/` |
| Body sizing pip disagrees with (directory-by-name where node-tar and CPython disagree; link, device, FIFO) and old GNU sparse `S` | a declared body, or any `S`, fails closed in parses pip may read (PyPI, gate); size 0 on the directory shape is a `parser-differential` |
| Anything that makes readers disagree, including a path not representable as a safe relative path | `parser-differential` suspicious entry, never silently resolved or dropped |

## ZIP reading rules

| Shape | Behavior |
| --- | --- |
| Wheels | streamed over local headers; every central-directory record cross-checked; mismatch fails closed |
| Data-descriptor, encrypted, zip64 entries | fail closed |
| VSIX (yazl-packed with data descriptors) | buffered central-directory-first parse under the wire cap |
| End record | must name exactly the central directory read (wheels: the one streamed; VSIX and GitHub artifact zips: ending at the end record, filled by its records), with the comment reaching the file end, no second signature in it, and no zip64 locator before it; otherwise fail closed |
| VSIX paths | mapped through VS Code's `extension` prefix strip (no slash required); a path two entries map to fails closed |
| Entry names | cp437 unless general-purpose bit 11 marks UTF-8, as pip's `zipfile` and yauzl decode the raw name |
| Info-ZIP Unicode Path field (0x7075) | CPython 3.12+ and yauzl rename by it, CPython 3.11 does not: an applicable field (version 1, CRC of the raw name) naming a different path, or holding invalid UTF-8, fails closed; malformed extra-field framing fails closed |

## Differential harness

`test/archive-differential.test.mjs` feeds the same bytes to Drydock's reader and to the reader each ecosystem installs with, and compares the installed entry sets (path, type, body sha256). Consumers only list entries; nothing from an archive is extracted to disk or executed.

| Ecosystem | Drydock path | Consumer model |
| --- | --- | --- |
| npm | gzip `DecompressionStream` + `readTarStream`, `strip1` | node-tar `Parser` with pacote's filter (links dropped, `.gitignore` rename) and an in-memory model of `Unpack`'s path checks and file/directory conflicts. Checked against both node-tar 7.5.22 (npm 12) and 7.5.15 (npm 11, bundled with Node 22 and 24), which size a pax `size` before a long-name header differently |
| PyPI sdist | `readTarStream`, `keep`, then `preparePyPiArtifact`'s root strip | `test/helpers/cpython-archive-consumer.py`: pip 25.1's `untar_file` (leading-dir strip on names and same-root hardlink targets, `data_filter`), replayed in memory; no `pyproject.toml`/`setup.py` at the top is a refused build |
| PyPI wheel | `readZipStream` | the same script: `zipfile` `namelist()` + `normpath` + `open(getinfo(name))` |
| VS Code | `readZipArchiveBuffered`, then the adapter's `normalizeVsixFiles` | yauzl as VS Code's `vs/base/node/zip` extractor drives it (`^extension` stripped, `extension.vsixmanifest` aliased to `.vsixmanifest`) |

| Outcome | Passes |
| --- | --- |
| Same entry set | yes |
| Consumer refuses the archive, or Drydock's parse throws | yes (fail closed) |
| Every disagreement covered by a disclosure the review raises at high severity (in the ecosystem's dialect) that names its path, or by bytes Drydock reviewed under such a path; an archive-level `parser-differential` covers everything except, for pip, a `body` or `missing` disagreement | yes |
| Only extra reviewed files the consumer could not write (a file already at a parent path, or a populated directory at the same path) | yes: the reviewer sees more than is installed |
| Anything else | no; the message names each `missing`/`extra`/`body`/`type` path |

| Input | Source |
| --- | --- |
| Repository fixtures | e2e package directories packed as `npm pack` lays them out; security-corpus file layouts packed into their ecosystem's archive kind |
| Crafted shapes | `NPM_CASES`, `PYPI_CASES`, `VSIX_CASES` in the test |
| Properties | fast-check structural tar/zip mutations over six fixed seeds, `DIFFERENTIAL_RUNS` (default 250) each. `DIFFERENTIAL_SEED` pins one seed; `DIFFERENTIAL_RANDOM_SEEDS=<n>` draws fresh ones for a long local run. Samples are drawn up front (PyPI's in one interpreter); failures print the seed, run, and generated shape |

1. Python: `DRYDOCK_DIFFERENTIAL_PYTHON`, else `/opt/homebrew/bin/python3.13`, `python3.13`, `python3`, always with `-I`. Without one the PyPI block skips with a warning locally and fails under `CI`. CI pins 3.13; 3.12+ is needed for the Unicode Path cases.
2. Fix a new differential rather than widening the passing outcomes; only the reviewer-sees-more direction is accepted.
3. Not modeled: case-insensitive or Windows filesystems, workerd's `DecompressionStream` (Node's stands in), and build steps after extraction.

## Native-binary sniffing

The first 64 bytes of every skipped body are kept and sniffed (`sniffNativeArtifact`) into `native-elf`, `native-macho`, `native-pe`, `native-wasm`, so extensionless platform binaries still raise `file.native-artifact`.

## Text classification

| Body | Flag | Text sample |
| --- | --- | --- |
| UTF-8 with no NUL and C0 controls ≤ max(5, 2% of length) | none | decoded as is |
| Otherwise, empty | `binary` | none |
| Otherwise, script source (`isScriptSourcePath`: JS/TS, Python, `.pth`, `.gyp`, shell, PowerShell, batch) or a `#!` file, native magic or not | `control-bytes` | decoded, controls other than tab/LF/VT/FF/CR shown as U+FFFD |
| Otherwise, native magic or `.node` (Node loads it with dlopen); or an inert asset (`isInertAssetPath`: images, fonts, audio/video, PDF), packed archive (`isPackedArchivePath`: zip/gzip/tar/jar/wasm and similar) or `.dll`/`.so`/`.dylib`/`.exe` whose first byte Node cannot run (`mayStartScript`) | `binary` | none |
| Otherwise (unknown extension, `.txt`, `.dat`, extensionless) | `binary`, `control-bytes` | decoded as above for the deterministic rules only |

Source maps (`*.map`) alone are hashed but never sampled (`text-sample-skipped`, `shouldSkipTextSample`); minified bundles are sampled like any file. `decodeBodyText` decides the rest. Node runs whatever a manifest or `require()` names, whatever its extension, so an extension alone never decides whether a body is decoded: a media or archive name with a scriptable first byte may be a polyglot and is decoded. Interpreters ignore control bytes in comments and strings, so a byte-level binary verdict would hide code from the rules.

A `binary` body's decoded text never leaves memory: `withoutOpaqueSample` drops it from stored scan files, the public diff payload and the compare cache, and display, line diffing, AI evidence and the injection screen treat `binary` as opaque. Where the package loads such a body, `file.control-bytes` reports it; a loaded file with no sample at all (source map, hash-only) raises `file.unsampled-entrypoint` ([rules](./detection-rule-behavior.md)).

## Archive digests (`digestArchiveStream`)

| Ecosystem | Algorithms requested | Checked against |
| --- | --- | --- |
| npm staged | SHA-1 (default) | the `shasum` npm recorded for the stage (`evaluateStagedArtifactIntegrity`) |
| atpm | SHA-256, SHA-512 | SHA-256 = release blob CID; SHA-512 = declared `dist.integrity` |
| others | SHA-1 | — |

Returned as `DownloadResult.archiveSha1` / `archiveSha256` / `archiveSha512`.

1. Digests are reported only after the source's own EOF. Cancelled, errored, or over-cap streams return `null`, never a partial digest.
2. A successful parse calls `digest()` to drain the tar tail past the end marker; a parse failure calls `abort()` so hostile bytes are not hashed for a discarded verdict.
3. The digest cap is the wire budget (`SANDBOX_MAX_STREAM_TAR_BYTES`), not the decompressed cap, so large artifacts (the ones most likely to truncate) stay verified.
4. Result: a truncated or substituted download cannot be reported as a publisher deleting files.

## Retention across the sandbox → parent hop

Retained bodies return as one buffered JSON response, so retained text is parent memory.

| Side | Retention | Why |
| --- | --- | --- |
| Reviewed (staged / gated) | whole bodies | rules scan `textSample`; a clipped window lets a payload hide past it |
| Baseline | `BASELINE_TEXT_SAMPLE_LIMIT`, via `maxTextSampleChars` → `MAX_TEXT_SAMPLE_CHARS` → `summarizeFile` | never persisted; a short baseline only makes the diff louder (more release-delta findings) |
| Manifest paths | never capped | manifest diffing is structural; clipping would null package identity |

Invariants for the baseline cap:

1. `size` and `sha256` always cover every byte, so the diff still proves whether the file changed.
2. `createPackageDiff` strips `baseline-truncated` instead of unioning it into `DiffEntry.flags`; canonical report data (`summary_json.diff`, R2 `diff.json`, exported `report.json`) never says the reviewed release was clipped.
3. The flag stays on the baseline `FileRecord`, where the AI evidence builder notes that a capped baseline renders its tail as additions.
4. Binary/control-character classification reads the full body, so `binary` means the same thing capped or not.

See [`diff-baseline.md`](./diff-baseline.md) for baseline selection.
