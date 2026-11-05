import { sha256Hex } from "../../platform/crypto-utils";
import { isRecord } from "../../platform/guards";
import { emitOperationalEvent } from "../../platform/observability";
import {
  MAX_STREAMED_TOTAL_ARTIFACT_ZIP_BYTES,
  WorkflowArtifactError,
} from "../../github-app/artifacts";
import {
  type ApprovedRunReview,
  getGateForOrganization,
  listApprovedRunReviews,
  readStageVerification,
} from "../../github-app/webhook-gates";
import type {
  ParsedGateArtifact,
  PreparedReleaseCandidate,
  StagedReleaseInput,
} from "../../workflow-gates/types";
import type { ReleaseStageBinding } from "../package-adapter";
import { normalizePyPiProjectName } from "./manifest";
import { preparePyPiArtifact } from "./acquire";
import {
  PYPI_STAGE_REFERENCE_FILENAME,
  PYPI_STAGE_REFERENCE_MAX_BYTES,
  PyPiStageError,
  type NamedDigest,
  type PyPiStageReferenceEntry,
  type StagedReleaseFile,
  compareDistributionSets,
  digestPrefix,
  duplicateBasenames,
  mergeStageReferences,
  parsePyPiStageReference,
  selectStagedReleaseFiles,
  summarizeProblems,
} from "./stage";
import { MAX_STAGED_FILE_BYTES, downloadStagedFile, fetchStageProjectPage } from "./stage-fetch";
import { stageManagedReleases } from "./session-lifecycle";
import { PYPI_ARTIFACT_LIMIT, SHA256_RE } from "./types";
import { pyPiVersionsEquivalent } from "./version";

// A stage verification spends the same release-wide byte budget as the
// sharded artifact path, so neither can be used to make Drydock read more.
const MAX_STAGED_RELEASE_BYTES = MAX_STREAMED_TOTAL_ARTIFACT_ZIP_BYTES;

interface ByteBudget {
  remaining: number;
}

type BundleByProject = Map<string, { name: string; artifacts: ParsedGateArtifact[] }>;

/**
 * PEP 694 releases registered in `pypi-stage.json`.
 *
 * Mode A (`stage-url`), the second of two gates: an earlier gate of the same
 * workflow run reviewed the build artifact and a human approved it, and only
 * then did the workflow's stage job create the stage and upload those files.
 * This gate links to that approved review (`listApprovedRunReviews`), reads the
 * stage page and downloads every staged file for the version (credential-free,
 * allowlisted origins only), and requires the staged set to be exactly the
 * reviewed set: same filenames, same sha256, nothing extra or missing. Nothing
 * is reviewed again; the candidate carries a `linkedReview` and the gate job
 * reuses the approved scan's report for a fresh human decision.
 *
 * Mode B (`"session": "drydock"`): the bundle's distributions are the
 * candidate, and Drydock stages exactly those bytes in a session it creates
 * and holds (`stageManagedReleases`).
 *
 * Every mismatch throws a maintainer-facing `WorkflowArtifactError`, which
 * rejects the held deployment. A retryable staging fault (`PyPiStagingError`)
 * leaves the gate pending.
 */
export async function preparePyPiStagedCandidates(
  input: StagedReleaseInput,
  prepareReleaseCandidates: (artifacts: ParsedGateArtifact[]) => PreparedReleaseCandidate[],
): Promise<PreparedReleaseCandidate[]> {
  try {
    return await prepareStaged(input, prepareReleaseCandidates);
  } catch (err) {
    if (err instanceof PyPiStageError) {
      throw new WorkflowArtifactError(err.code, err.message, { maintainerFacing: true });
    }
    throw err;
  }
}

async function prepareStaged(
  input: StagedReleaseInput,
  prepareReleaseCandidates: (artifacts: ParsedGateArtifact[]) => PreparedReleaseCandidate[],
): Promise<PreparedReleaseCandidate[]> {
  const references = mergeStageReferences(
    input.sidecars.map((sidecar) => {
      if (sidecar.bytes.byteLength > PYPI_STAGE_REFERENCE_MAX_BYTES) {
        throw new PyPiStageError(
          "stage_reference_invalid",
          `${PYPI_STAGE_REFERENCE_FILENAME} exceeds ${PYPI_STAGE_REFERENCE_MAX_BYTES} bytes`,
        );
      }
      return parsePyPiStageReference(new TextDecoder().decode(sidecar.bytes));
    }),
  );

  // Bundle files bind by basename, so two bundle files with one basename
  // (`a/x.whl`, `b/x.whl`) would let one ride along unbound.
  const duplicates = duplicateBasenames(input.artifacts);
  if (duplicates.length > 0) {
    throw new PyPiStageError(
      "stage_identity_mismatch",
      summarizeProblems(duplicates.map((name) => `${name} appears more than once in the artifact`)),
    );
  }
  const bundleByProject = groupBundleArtifacts(input.artifacts);
  for (const [project, group] of bundleByProject) {
    if (!references.has(project)) {
      throw new PyPiStageError(
        "stage_reference_invalid",
        `the artifact carries ${group.name} but ${PYPI_STAGE_REFERENCE_FILENAME} registers no stage for it`,
      );
    }
  }

  const entries = [...references.values()];
  const workflowStaged = entries.filter((entry) => entry.stageUrl !== null).length;
  if (workflowStaged === entries.length) {
    return verifyStagesAgainstReview(input, references, bundleByProject);
  }
  if (workflowStaged > 0) {
    // The two modes answer different gates (verify an approved review vs.
    // review and hold), so one gate cannot be both.
    throw new PyPiStageError(
      "stage_reference_invalid",
      `${PYPI_STAGE_REFERENCE_FILENAME} mixes stage-url entries with Drydock-held sessions`,
    );
  }
  return prepareManagedStaging(input, references, bundleByProject, prepareReleaseCandidates);
}

// ── Mode A: verify a workflow-created stage against the approved review ─────

interface LinkableReview extends ApprovedRunReview {
  packageName: string;
  stagedVersion: string;
  files: NamedDigest[];
}

async function verifyStagesAgainstReview(
  input: StagedReleaseInput,
  references: Map<string, PyPiStageReferenceEntry>,
  bundleByProject: BundleByProject,
): Promise<PreparedReleaseCandidate[]> {
  const gate = await getGateForOrganization(input.db, input.organizationId, input.gateId);
  if (!gate) throw new Error("workflow gate disappeared while verifying its stage");
  const reviews = (await listApprovedRunReviews(input.db, gate)).flatMap((review) => {
    const linkable = linkableReview(review);
    return linkable ? [linkable] : [];
  });

  const candidates: PreparedReleaseCandidate[] = [];
  const budget: ByteBudget = { remaining: MAX_STAGED_RELEASE_BYTES };
  // Sequential on purpose: one staged distribution is held in memory at a time.
  for (const [project, entry] of references) {
    const matching = reviews.filter(
      (review) =>
        normalizePyPiProjectName(review.packageName) === project &&
        pyPiVersionsEquivalent(review.stagedVersion, entry.version),
    );
    if (matching.length === 0) {
      throw new PyPiStageError(
        "stage_review_unlinked",
        `${entry.name} ${entry.version} has no approved Drydock review in this workflow run; the stage gate only verifies a release the review gate approved`,
      );
    }
    const { review, files } = await verifyStage(entry, entry.stageUrl as URL, matching, budget);
    const bundle = bundleByProject.get(project)?.artifacts ?? [];
    if (bundle.length > 0) {
      const identity = compareDistributionSets(
        "reviewed release",
        review.files,
        "artifact",
        bundle,
      );
      if (identity.length > 0) {
        throw new PyPiStageError("stage_identity_mismatch", summarizeProblems(identity));
      }
    }
    candidates.push({
      ecosystem: "pypi",
      pipelineInput: {},
      package: { name: review.packageName, version: review.stagedVersion },
      linkedReview: {
        gateId: review.gateId,
        scanId: review.scanId,
        verification: {
          protocol: "pep694",
          index: entry.index,
          reviewedGateId: review.gateId,
          reviewedScanId: review.scanId,
          files: files.map((file) => ({ filename: file.filename, sha256: file.sha256 })),
          verifiedAt: new Date().toISOString(),
        },
      },
    });
    emitOperationalEvent("info", "pypi.stage.verified", {
      // Index origin only: stage URLs are capabilities, never logged.
      index: entry.index,
      fileCount: files.length,
    });
  }
  return candidates;
}

/**
 * A review this gate may link to: an artifact review (not itself a stage
 * verification or a held session) with a sha256 for every reviewed file.
 */
function linkableReview(review: ApprovedRunReview): LinkableReview | null {
  if (!review.packageName || !review.stagedVersion) return null;
  if (readStageVerification(review.summaryJson)) return null;
  const stagedPublish = isRecord(review.summaryJson) ? review.summaryJson.stagedPublish : null;
  const provenance = isRecord(stagedPublish) ? stagedPublish.provenance : null;
  if (
    !isRecord(provenance) ||
    provenance.ecosystem !== "pypi" ||
    provenance.mode !== "workflow_gate" ||
    provenance.stage !== undefined ||
    !Array.isArray(provenance.artifacts) ||
    provenance.artifacts.length === 0
  ) {
    return null;
  }
  const files: NamedDigest[] = [];
  for (const artifact of provenance.artifacts) {
    if (
      !isRecord(artifact) ||
      typeof artifact.path !== "string" ||
      typeof artifact.sha256 !== "string" ||
      !SHA256_RE.test(artifact.sha256)
    ) {
      return null;
    }
    files.push({ path: artifact.path, sha256: artifact.sha256 });
  }
  return { ...review, packageName: review.packageName, stagedVersion: review.stagedVersion, files };
}

/**
 * Read the stage, pick the approved review whose files it holds exactly, and
 * download every staged file to prove the served bytes hash to the reviewed
 * digests. Several reviews can match a project version when the review gate
 * ran in more than one attempt of the run; only an exact match is accepted.
 */
async function verifyStage(
  entry: PyPiStageReferenceEntry,
  stageUrl: URL,
  reviews: LinkableReview[],
  budget: ByteBudget,
): Promise<{ review: LinkableReview; files: StagedReleaseFile[] }> {
  const page = await fetchStageProjectPage(stageUrl, entry.name);
  const { files, problems } = selectStagedReleaseFiles(page, entry.name, entry.version);
  if (problems.length > 0) {
    throw new PyPiStageError("stage_identity_mismatch", summarizeProblems(problems));
  }
  if (files.length > PYPI_ARTIFACT_LIMIT) {
    throw new PyPiStageError(
      "stage_identity_mismatch",
      `stage lists more than ${PYPI_ARTIFACT_LIMIT} files for ${entry.name} ${entry.version}`,
    );
  }
  // Declared sizes (PEP 700) are checked before any download; undeclared
  // sizes are bounded while streaming against the same budget.
  for (const file of files) {
    if (file.size !== null && file.size > MAX_STAGED_FILE_BYTES) {
      throw new PyPiStageError(
        "stage_unavailable",
        `staged file ${file.filename} declares ${file.size} bytes, over the ${MAX_STAGED_FILE_BYTES}-byte cap`,
      );
    }
  }
  const declared = files.reduce((sum, file) => sum + (file.size ?? 0), 0);
  if (declared > budget.remaining) {
    throw new PyPiStageError(
      "stage_unavailable",
      `staged release exceeds the ${MAX_STAGED_RELEASE_BYTES}-byte review budget`,
    );
  }

  // Compare declared digests before downloading anything: a mismatch here is
  // already decisive and costs no bytes. The newest review's problems are the
  // ones reported.
  const staged = files.map((file) => ({ path: file.filename, sha256: file.sha256 }));
  let reported: string[] | null = null;
  const review = reviews.find((candidate) => {
    const identity = compareDistributionSets("reviewed release", candidate.files, "stage", staged);
    reported ??= identity;
    return identity.length === 0;
  });
  if (!review) {
    throw new PyPiStageError("stage_identity_mismatch", summarizeProblems(reported ?? []));
  }

  // The index's declared digest is its own claim; only the downloaded bytes
  // show what a consumer of the stage, and then of the release, receives.
  for (const file of files) {
    if (budget.remaining <= 0) {
      throw new PyPiStageError(
        "stage_unavailable",
        `staged release exceeds the ${MAX_STAGED_RELEASE_BYTES}-byte review budget`,
      );
    }
    const bytes = await downloadStagedFile(file.url, entry.index, file.filename, budget.remaining);
    budget.remaining -= bytes.byteLength;
    const sha256 = await sha256Hex(bytes);
    if (sha256 !== file.sha256) {
      throw new PyPiStageError(
        "stage_identity_mismatch",
        `${file.filename} downloaded bytes hash to ${digestPrefix(sha256)}, the stage index declares ${digestPrefix(file.sha256)}`,
      );
    }
  }
  return { review, files };
}

// ── Mode B: Drydock stages the reviewed bytes and holds the session ─────────

async function prepareManagedStaging(
  input: StagedReleaseInput,
  references: Map<string, PyPiStageReferenceEntry>,
  bundleByProject: BundleByProject,
  prepareReleaseCandidates: (artifacts: ParsedGateArtifact[]) => PreparedReleaseCandidate[],
): Promise<PreparedReleaseCandidate[]> {
  const reviewed: ParsedGateArtifact[] = [];
  const bindings = new Map<
    string,
    { entry: PyPiStageReferenceEntry; binding: ReleaseStageBinding }
  >();
  for (const [project, entry] of references) {
    // The artifact's distributions are the review and the upload source.
    const bundle = bundleByProject.get(project)?.artifacts ?? [];
    if (bundle.length === 0) {
      throw new PyPiStageError(
        "stage_reference_invalid",
        `${entry.name} opts into Drydock-held staging, but the artifact carries no distributions for it`,
      );
    }
    reviewed.push(...bundle);
    bindings.set(project, {
      entry,
      binding: { protocol: "pep694", index: entry.index, artifactBound: true, managed: true },
    });
  }

  const candidates = prepareReleaseCandidates(reviewed);
  const bound = new Set<string>();
  const result = candidates.map((candidate) => {
    const project = normalizePyPiProjectName(candidate.package.name);
    const registered = bindings.get(project);
    if (!registered) {
      throw new PyPiStageError(
        "stage_identity_mismatch",
        `the artifact declares project ${candidate.package.name}, which no stage registered`,
      );
    }
    if (!pyPiVersionsEquivalent(candidate.package.version, registered.entry.version)) {
      throw new PyPiStageError(
        "stage_identity_mismatch",
        `the artifact for ${registered.entry.name} declares version ${candidate.package.version}, registered as ${registered.entry.version}`,
      );
    }
    bound.add(project);
    return {
      ...candidate,
      pipelineInput: { ...candidate.pipelineInput, stage: registered.binding },
    };
  });
  for (const [project, registered] of bindings) {
    if (!bound.has(project)) {
      throw new PyPiStageError(
        "stage_identity_mismatch",
        `the artifact for ${registered.entry.name} declares a different project name in its metadata`,
      );
    }
  }

  // Every opted-in project is held when this returns, or it threw.
  await stageManagedReleases(
    input,
    [...bindings].map(([project, registered]) => ({
      name: registered.entry.name,
      version: registered.entry.version,
      index: registered.entry.index,
      reviewed: (bundleByProject.get(project)?.artifacts ?? []).map((artifact) => ({
        path: artifact.path,
        sha256: artifact.sha256,
      })),
    })),
  );
  for (const registered of bindings.values()) {
    emitOperationalEvent("info", "pypi.stage.reviewed", {
      // Index origin only: session URLs are capabilities, never logged.
      index: registered.binding.index,
      managed: true,
    });
  }
  return result;
}

function groupBundleArtifacts(artifacts: ParsedGateArtifact[]): BundleByProject {
  const groups: BundleByProject = new Map();
  for (const artifact of artifacts) {
    const prepared = preparePyPiArtifact({ path: artifact.path, files: artifact.files });
    const name = prepared.summary.name;
    if (!name) {
      throw new WorkflowArtifactError(
        "artifact_identity_missing",
        `${artifact.path} does not expose a PyPI Name/Version in its metadata`,
      );
    }
    const key = normalizePyPiProjectName(name);
    const group = groups.get(key);
    if (group) group.artifacts.push(artifact);
    else groups.set(key, { name, artifacts: [artifact] });
  }
  return groups;
}
