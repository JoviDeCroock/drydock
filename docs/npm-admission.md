# npm pre-install admission

`drydock admit` checks a complete npm lockfile graph before the caller permits installation. **Authority:** process exit status, enforced only by a trusted caller that stops on failure and preserves the reviewed lockfile. **Owner:** `cli/src/admission.mjs`.

## At a glance

| Item | Contract |
| --- | --- |
| Command | `drydock admit package-lock.json --baseline trusted-package-lock.json --output NEW_FILE` |
| Supported | npm 9+ `npm ci`, package-lock v2/v3 or active npm-shrinkwrap with a `packages` graph, exact public npm tarballs |
| Inputs | Explicitly trusted baseline; complete candidate lockfile including development, optional, peer, direct and transitive dependency entries; actual sibling package.json |
| Authority | Exit `0` admits the locked graph under `npm-admission.v1`; `3` holds; other nonzero exits mean admission failed |
| Unsupported | First-time packages, ambiguous baselines, aliases, workspaces, local/git/custom/private registry sources, bundled dependencies, nested shrinkwrap graphs, SHA-1-only pins |
| Limits | 8 MiB per lockfile/JSON response; 2,000 dependency entries; 40 changed artifact pairs; 64 MiB per archive; 1 GiB total network data; 30 seconds per response; eight minutes total |
| Execution | No installer, shell, package import, extraction, or lifecycle execution; archive bytes are hashed only |

## Contract

Use a pinned, independently provisioned Drydock CLI outside the candidate dependency graph. Do not bootstrap it with `npx` from the graph it is about to review. Run in a clean checkout before any project dependency install. The baseline must come from a protected branch or another independently reviewed artifact inventory; selecting the candidate as its own baseline explicitly trusts the whole candidate and defeats change review.

1. Read the actual sibling `package.json` and require its dependency/development/optional/peer declarations and optional-peer metadata to exactly match the active lock root. Reject overrides, workspaces, alternate sources and unknown resolver fields; ordinary metadata and later-execution fields are allowed by an explicit allowlist. Validate every target dependency source, exact identity, strong SRI pin and graph reference locally. Missing graph entries and unsupported sources block before any request to Drydock. A sibling `npm-shrinkwrap.json` takes precedence: when it exists, admit that file instead of `package-lock.json`.
2. An identical name, version, resolved URL, strongest integrity pin and dependency-resolution metadata in the trusted baseline remains explicitly trusted. A same-version change of artifact identity holds. Every other target entry needs an unambiguous baseline version; new packages hold for independent review.
3. Download each changed pair's two exact locked tarballs anonymously from `registry.npmjs.org`. No registry configuration, token, cookie or credential is read or forwarded. Both downloads must satisfy their strongest SHA-256/384/512 SRI pins before their package name is sent to Drydock. Failed anonymous retrieval does not disclose the name to Drydock.
4. Read the public deterministic diff and bind **both** archive SHA-256 values to the downloaded locked bytes. Package/version identity, digest mismatch, missing fields, unavailable evidence or unknown risk fails admission. The reviewed target artifact's dependency/optional/peer declarations must also match its target lock node and use registry sources; a deceptive lock graph cannot hide alternate sources.
5. Hold high/critical release risk, new/changed install hooks, added dependency declarations or commands, changed native/uninspected content, coverage notices or omitted samples, and nested installation graphs. The local policy has no bypass flag. A low-risk result does not establish that the artifact is safe.
6. Re-read and hash both lockfiles and the actual manifest, then recheck active-lock precedence before producing the receipt. Existing output files are refused; use a new path on each run. A held receipt says `status: held`; a failed command creates no receipt. The exit code is the gate, never the existence of a file.

The unsigned `drydock.npm-admission.v1` receipt records both raw lockfile SHA-256 values and `packageJsonSha256`, target/trusted entry counts, exact reviewed pairs and archive digests, policy, analysis versions/times, and held reasons. It is evidence of that invocation, not a reusable installation authorization or malware-free attestation.

### Compose with Safe Chain

Provision and verify a pinned Safe Chain release in the trusted runner image. Its [official CI setup](https://github.com/AikidoSec/safe-chain#usage-in-cicd) installs executable package-manager shims with the installer's `--ci` option; normal `npm` commands then use those shims. No separate `safe-chain npm ci` dispatch is required.

```sh
set -euo pipefail
npm safe-chain-verify
drydock admit package-lock.json \
  --baseline "$TRUSTED_BASE_LOCK" \
  --output "$NEW_ADMISSION_RECEIPT"
npm --prefix "$PWD" --workspaces=false ci --ignore-scripts --registry=https://registry.npmjs.org
```

`TRUSTED_BASE_LOCK` must identify independently trusted bytes and `NEW_ADMISSION_RECEIPT` must not exist. These are caller-provided file paths, not npm credentials. Require the trusted CI job's check in branch protection and make subsequent install/build jobs depend on it at the same candidate commit. Keep its workflow and tool installation outside candidate-controlled modifications. Do not use `continue-on-error`, `always()` on an install job, package-manager alternatives, or cached project `node_modules` before admission.

Run this sequence from the admitted lockfile/manifest directory. The explicit prefix and disabled workspace selection prevent npm from selecting an ancestor workspace graph. The caller must install the same active lockfile and manifest, with no intervening mutation or npm configuration that disables lockfile integrity. npm enforces its SRI pins; `--ignore-scripts` prevents lifecycle execution. Safe Chain provides its own install-time checks.

Intentional execution of installed code, tests, builds or later lifecycle scripts remains a separate trusted workflow step; this preflight neither intercepts other machines nor makes those programs harmless. npm's [lockfile contract](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json/) defines the modern `packages` graph and strong artifact integrity fields.

## Failure modes

| Condition | Result | Remedy |
| --- | --- | --- |
| New package or no unique baseline | Hold before external review | Independently review the exact new artifact and update the protected trusted inventory through its review process; never copy the candidate wholesale to silence a hold |
| Policy hold | Held receipt; exit 3 | Read the exact diff and review the change through the trusted baseline process; no automatic exception is created |
| Unsupported source/graph | Admission fails locally | Use a supported registry-only lock or a separate independently enforced review process |
| Registry/diff rate limit, outage, redirect or over-budget response | Nonzero; no admission | Retry later, split the update or repair the evidence path |
| SRI/digest/identity disagreement | Nonzero; no admission | Investigate the bytes and source; no policy override applies |
| Existing receipt path | Usage error before network reads | Choose a fresh path; do not treat an old receipt as this run's result |
| Candidate/baseline/manifest or active lock changes during review | Nonzero; no admission | Start from immutable inputs and rerun |

## Change checklist

- CLI admission changes: `test/cli-admission.test.ts`; never execute reviewed dependency content in validation.
- Public digest/version contract changes: `test/public-diff-npm-provenance.test.ts`, `test/workers/public-diff-routes.test.ts`, `test/public-mcp.test.ts`, OpenAPI document parity.
