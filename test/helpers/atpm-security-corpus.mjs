import { atpmRecordFindings } from "../../server/lib/ecosystems/atpm/findings";
import { computeRisk } from "../../server/lib/review";

const DEFAULT_PACKAGE_NAME = "@publisher.example/package";
const DEFAULT_VERSION = "1.1.0";

function version(input = {}) {
  return {
    version: DEFAULT_VERSION,
    cid: "bafkreigh2akiscaildc4s5x5v6xv5h5q5v5h5q5v5h5q5v5h5q5v5h5qe",
    size: 512,
    mimeType: "application/gzip",
    createdAt: "2026-08-21T12:00:00.000Z",
    declaredName: DEFAULT_PACKAGE_NAME,
    declaredVersion: DEFAULT_VERSION,
    declaredShasum: null,
    declaredTarball: null,
    declaredIntegrity: null,
    provenance: { status: "absent" },
    ...input,
  };
}

/** Run one synthetic atpm provenance fixture through the production finding path. */
export function createAtpmCorpusReview(fixture) {
  const entry = version(fixture.target);
  const baseline = fixture.baseline ? version(fixture.baseline) : null;
  const findings = atpmRecordFindings({
    entry,
    manifest:
      fixture.manifest === null
        ? null
        : (fixture.manifest ?? {
            name: entry.declaredName,
            version: entry.version,
          }),
    archiveSha1: fixture.archiveSha1 ?? null,
    archiveSha512: fixture.archiveSha512 ?? null,
    recordName: fixture.recordName ?? "package",
    trustPublisher: fixture.trustPublisher ?? null,
    baseline,
    baselineArchiveSha512: fixture.baselineArchiveSha512 ?? null,
  });
  return { findings, risk: computeRisk(findings) };
}
