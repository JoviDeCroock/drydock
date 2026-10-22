import { npmRegistryProvenance } from "../../server/lib/ecosystems/npm/provenance";
import {
  classifyPyPiProvenanceResponse,
  combinePyPiFileProvenance,
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

function sideProvenance(ecosystem, packageName, side) {
  if (ecosystem === "pypi") {
    return combinePyPiFileProvenance(
      side.files.map((file) =>
        classifyPyPiProvenanceResponse(file.status, file.body ?? null, file.filename),
      ),
    );
  }
  return npmRegistryProvenance({
    hasProvenance: side.packumentProvenance,
    attestations: npmAttestationsDocument(side),
    packageName,
    version: side.version,
  });
}

/** Run one registry provenance fixture through the production readers and rule. */
export function createProvenanceCorpusReview(fixture) {
  const { packageName, baseline, candidate } = fixture.registryProvenance;
  const findings = provenanceContinuityFindings({
    registry: fixture.ecosystem === "pypi" ? "PyPI" : "npm",
    baseline: {
      version: baseline.version,
      provenance: sideProvenance(fixture.ecosystem, packageName, baseline),
    },
    candidate: {
      version: candidate.version,
      provenance: sideProvenance(fixture.ecosystem, packageName, candidate),
    },
  });
  return { findings, risk: computeRisk(findings) };
}
