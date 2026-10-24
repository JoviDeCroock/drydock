# Aikido dependency intelligence

Drydock adds advisory Aikido Intel results to added and changed npm dependency declarations. The shared manifest view displays them on authenticated scan reports and anonymous package diffs. Runtime, optional and peer dependency changes are checked; unchanged and removed declarations are outside this delta review. PyPI and other ecosystems are not checked against the npm feed.

## Evidence and version semantics

The integration downloads Aikido's complete public [npm malware feed](https://malware-list.aikido.dev/malware_predictions.json). Its schema and matching conventions come from the official [Safe Chain client](https://github.com/AikidoSec/safe-chain/blob/main/packages/safe-chain/src/api/aikido.js) and [malware database](https://github.com/AikidoSec/safe-chain/blob/main/packages/safe-chain/src/scanning/malwareDatabase.js). Only entries classified as `MALWARE` contribute a malware match; telemetry and protestware classifications do not.

- **Known malware:** the exact declared version is listed, the declared semver range admits a listed version, or Aikido lists every version of the package (`*`). A range match does not identify a resolved or installed version. Exact checks preserve registry version identity, including build metadata.
- **No known malware match:** no listed malware version matches the declaration in this feed snapshot. This is not proof of a completed scan or safety.
- **Spec not checked:** a dist-tag, git/URL/file/workspace declaration, malformed identity or unsupported spec cannot be matched locally. npm aliases check the target package and range, rather than the local alias name.
- **Intel unavailable:** the feed could not be fetched or validated. An outage, oversized response, timeout or malformed feed never becomes a negative malware result.

Results name Aikido, carry the feed check time when available, and link to its npm malware directory. At most five matching versions are displayed, with the complete match count retained. No package contents or vendor prose are rendered.

## Advisory scope and snapshots

Intel results do not create findings, enter the AI review, change risk scores or affect workflow-gate decisions. The scan pipeline enriches the manifest diff after AI review and scoring, then persists the dated snapshot in the canonical report and its digest. Historical reports retain that snapshot.

Anonymous diffs refresh intelligence separately from the immutable package-pair cache, including on cache hits. A feed snapshot is fresh for at most 15 minutes from its original check time. Failed refreshes expose unavailable results; stale negative results are not reused. Unavailable results are retried after 30 seconds.

## Egress and operations

The parent Worker performs a tokenless GET to one fixed HTTPS feed URL, with redirects rejected, a five-second fetch/body deadline and a 16 MiB response cap. Reviewed dependency names, registry URLs, manifest contents, organization IDs and npm credentials are never sent. The sandbox has no new network authority. Matching is local, including for scans acquired from a private registry; a registry's private package identity is not independently verified as the same public npm package.

The validated malware index uses a short per-isolate and per-colo cache. A `dependency.intel.unavailable` operational event records only provider, status and a safe error code. No new bindings, secrets or migrations are required.

Aikido also offers an authenticated [research API](https://apidocs.aikido.dev/reference/getmalwarepackages) and [commercial Intel licensing](https://www.aikido.dev/blog/launching-aikido-malware---open-source-threat-feed). Confirm applicable data-use rights with Aikido for a production product integration; public feed availability does not establish licensing terms.
