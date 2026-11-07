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
| Bad header checksum, undecodable base-256 field | block skipped without consuming its body |
| PAX `size` | overrides the header size |
| `X` / `N` / `K` extended headers, 1 MiB metadata limit | as node-tar |
| Typeflag `7` | regular file |
| Root stripping | npm and atpm: `strip: 1` (first component, any name); PyPI: keep the sdist root; workflow gate with unknown ecosystem: strip a literal `package/` |
| Anything that makes readers disagree, including a path not representable as a safe relative path | `parser-differential` suspicious entry, never silently resolved or dropped |

## ZIP reading rules

| Shape | Behavior |
| --- | --- |
| Wheels | streamed over local headers; every central-directory record cross-checked; mismatch fails closed |
| Data-descriptor, encrypted, zip64 entries | fail closed |
| VSIX (yazl-packed with data descriptors) | buffered central-directory-first parse under the wire cap |

## Native-binary sniffing

The first 64 bytes of every skipped body are kept and sniffed (`sniffNativeArtifact`) into `native-elf`, `native-macho`, `native-pe`, `native-wasm`, so extensionless platform binaries still raise `file.native-artifact`.

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
