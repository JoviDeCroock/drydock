import {
  npmPackumentProvenanceStatus,
  npmProvenanceLineage,
  npmRegistryProvenance,
} from "../../server/lib/ecosystems/npm/provenance";
import { projectRegistryMetadata } from "../../server/lib/ecosystems/npm/registry";
import {
  classifyPyPiProvenanceResponse,
  combinePyPiFileProvenance,
  pypiProvenanceLineage,
} from "../../server/lib/ecosystems/pypi/provenance";
import { provenanceContinuityFindings } from "../../server/lib/provenance-continuity";
import { computeRisk } from "../../server/lib/review";

const SLSA_V1 = "https://slsa.dev/provenance/v1";

// Fixtures hold decoded in-toto statements for readability; the registry
// serves them base64-encoded inside a DSSE envelope, so wrap them the same way
// before the production parser sees them.
function npmAttestationsDocument(side) {
  if (side.attestations !== undefined) return side.attestations;
  if (!side.statements) return null;
  return {
    attestations: side.statements.map((statement) => ({
      predicateType: statement.predicateType ?? SLSA_V1,
      bundle: {
        mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
        dsseEnvelope: {
          payloadType: "application/vnd.in-toto+json",
          payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
          signatures: [],
        },
      },
    })),
  };
}

// The provenance marker is read the way production reads it: from a packument
// version entry through the registry projection. An omitted marker means the
// entry carried no dist object, which projects to unknown.
function npmPackument(packageName, sides) {
  const versions = {};
  const time = {};
  for (const side of sides) {
    versions[side.version] =
      side.packumentProvenance === undefined
        ? {}
        : {
            dist: {
              tarball: `https://registry.npmjs.org/${packageName}/-/${packageName}-${side.version}.tgz`,
              ...(side.packumentProvenance
                ? { attestations: { provenance: { predicateType: SLSA_V1 } } }
                : {}),
            },
          };
    if (side.publishedAt) time[side.version] = side.publishedAt;
  }
  return projectRegistryMetadata({ versions, time });
}

function pypiMetadata(sides) {
  const releases = {};
  for (const side of sides) {
    releases[side.version] = side.files.map((file) => ({
      filename: file.filename,
      packagetype: file.filename.endsWith(".whl") ? "bdist_wheel" : "sdist",
      ...(side.publishedAt ? { upload_time_iso_8601: side.publishedAt } : {}),
    }));
  }
  return { releases };
}

function pypiSideProvenance(side) {
  return combinePyPiFileProvenance(
    side.files.map((file) =>
      classifyPyPiProvenanceResponse(file.status, file.body ?? null, file.filename),
    ),
  );
}

/**
 * Run one registry provenance fixture through the production lineage, readers,
 * and rule. `history` lists earlier published releases (any channel, optional
 * `publishedAt`); the lineage picks the baseline and prior releases from them
 * the way the public-diff adapters do.
 */
export function createProvenanceCorpusReview(fixture) {
  const { packageName, baseline, candidate, history = [] } = fixture.registryProvenance;
  const sides = [...history, baseline, candidate];
  const byVersion = new Map(sides.map((side) => [side.version, side]));
  const side = (version, provenance) => (version === null ? null : { version, provenance });
  let findings = [];
  if (fixture.ecosystem === "pypi") {
    const lineage = pypiProvenanceLineage(pypiMetadata(sides), baseline.version, candidate.version);
    if (lineage) {
      const base = lineage.baseline && pypiSideProvenance(byVersion.get(lineage.baseline));
      const candidateProvenance = pypiSideProvenance(candidate);
      // Production reads history only when the drop rule needs it.
      const drop = base?.status === "present" && candidateProvenance.status === "absent";
      findings = provenanceContinuityFindings({
        registry: "PyPI",
        baseline: side(lineage.baseline, base),
        candidate: { version: candidate.version, provenance: candidateProvenance },
        prereleaseBaseline: side(
          lineage.prerelease,
          lineage.prerelease && pypiSideProvenance(byVersion.get(lineage.prerelease)),
        ),
        prior: drop
          ? lineage.prior.map((version) => pypiSideProvenance(byVersion.get(version)).status)
          : [],
        absenceScope: "checked-files",
      });
    }
  } else {
    const packument = npmPackument(packageName, sides);
    const lineage = npmProvenanceLineage(packument, baseline.version, candidate.version);
    const read = (entry) =>
      npmRegistryProvenance({
        hasProvenance: packument.versions?.[entry.version]?.hasProvenance,
        attestations: npmAttestationsDocument(entry),
        packageName,
        version: entry.version,
      });
    if (lineage) {
      findings = provenanceContinuityFindings({
        registry: "npm",
        baseline: side(lineage.baseline, lineage.baseline && read(byVersion.get(lineage.baseline))),
        candidate: { version: candidate.version, provenance: read(candidate) },
        prereleaseBaseline: side(
          lineage.prerelease,
          lineage.prerelease && read(byVersion.get(lineage.prerelease)),
        ),
        prior: lineage.prior.map((version) => npmPackumentProvenanceStatus(packument, version)),
      });
    }
  }
  return { findings, risk: computeRisk(findings) };
}
