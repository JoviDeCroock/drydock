import { sha1Hex, sha256Hex } from "../../platform/crypto-utils";
import { emitOperationalEvent } from "../../platform/observability";
import {
  MAX_STREAMED_TOTAL_ARTIFACT_ZIP_BYTES,
  WorkflowArtifactError,
} from "../../github-app/artifacts";
import type {
  ParsedGateArtifact,
  PreparedReleaseCandidate,
  StagedReleaseInput,
} from "../../workflow-gates/types";
import type { ReleaseStageBinding } from "../package-adapter";
import { inferPyPiArtifactKind, normalizePyPiProjectName } from "./manifest";
import { preparePyPiArtifact } from "./acquire";
import {
  PYPI_STAGE_REFERENCE_FILENAME,
  PYPI_STAGE_REFERENCE_MAX_BYTES,
  PyPiStageError,
  basename,
  compareDistributionSets,
  digestPrefix,
  duplicateBasenames,
  mergeStageReferences,
  parsePyPiStageReference,
  selectStagedReleaseFiles,
  summarizeProblems,
  type PyPiStageReferenceEntry,
} from "./stage";
import { MAX_STAGED_FILE_BYTES, downloadStagedFile, fetchStageProjectPage } from "./stage-fetch";
import { stageManagedReleases } from "./session-lifecycle";
import { PYPI_ARTIFACT_LIMIT } from "./types";
import { pyPiVersionsEquivalent } from "./version";

// The stage path spends the same release-wide byte budget as the sharded
// artifact path, so neither can be used to make Drydock read more.
const MAX_STAGED_RELEASE_BYTES = MAX_STREAMED_TOTAL_ARTIFACT_ZIP_BYTES;

interface ByteBudget {
  remaining: number;
}

/**
 * PEP 694 releases registered in `pypi-stage.json`.
 *
 * Mode A (`stage-url`): the workflow created a stage. Drydock reads the stage
 * page and downloads every staged file for that version (credential-free,
 * allowlisted origins only), checks each download against the digest the
 * index declares, and parses the staged bytes in the sandbox. Those parsed
 * staged files are the release candidate. If the bundle also carries
 * distributions for the project, both sides must be byte-identical: same
 * filenames, same sha256, nothing extra on either.
 *
 * Mode B (`"session": "drydock"`): the bundle's distributions are the
 * candidate, and Drydock stages exactly those bytes in a session it creates
 * and holds (`stageManagedReleases`).
 *
 * Every mismatch throws a maintainer-facing `WorkflowArtifactError`, which
 * rejects the held deployment; there is no partial review of a stage. A
 * retryable staging fault (`PyPiStagingError`) leaves the gate pending.
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

  // Bundle files bind to staged files by basename, so two bundle files with
  // one basename (`a/x.whl`, `b/x.whl`) would let one ride along unbound.
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

  const reviewed: ParsedGateArtifact[] = [];
  const bindings = new Map<
    string,
    { entry: PyPiStageReferenceEntry; binding: ReleaseStageBinding }
  >();
  const budget: ByteBudget = { remaining: MAX_STAGED_RELEASE_BYTES };
  // Sequential on purpose: one staged distribution is held in memory at a time.
  for (const [project, entry] of references) {
    const bundle = bundleByProject.get(project)?.artifacts ?? [];
    if (entry.stageUrl) {
      reviewed.push(...(await reviewStage(entry, entry.stageUrl, bundle, input, budget)));
      bindings.set(project, {
        entry,
        binding: { protocol: "pep694", index: entry.index, artifactBound: bundle.length > 0 },
      });
      continue;
    }
    // Mode B: the artifact's distributions are the review and the upload source.
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
        `staged files declare project ${candidate.package.name}, which no stage registered`,
      );
    }
    if (!pyPiVersionsEquivalent(candidate.package.version, registered.entry.version)) {
      throw new PyPiStageError(
        "stage_identity_mismatch",
        `staged files for ${registered.entry.name} declare version ${candidate.package.version}, registered as ${registered.entry.version}`,
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
        `staged files for ${registered.entry.name} declare a different project name in their metadata`,
      );
    }
  }

  // Mode B: Drydock stages the reviewed bytes itself and holds the sessions.
  // Every opted-in project is held when this returns, or it threw.
  await stageManagedReleases(
    input,
    [...bindings]
      .filter(([, registered]) => registered.binding.managed)
      .map(([project, registered]) => ({
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
      // Index origin only: stage and session URLs are capabilities, never logged.
      index: registered.binding.index,
      artifactBound: registered.binding.artifactBound,
      managed: registered.binding.managed === true,
    });
  }
  return result;
}

async function reviewStage(
  entry: PyPiStageReferenceEntry,
  stageUrl: URL,
  bundle: ParsedGateArtifact[],
  input: StagedReleaseInput,
  budget: ByteBudget,
): Promise<ParsedGateArtifact[]> {
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
  // Compare declared digests before downloading anything: a mismatch here is
  // already decisive and costs no bytes.
  if (bundle.length > 0) {
    const identity = compareDistributionSets(
      "artifact",
      bundle,
      "stage",
      files.map((file) => ({ path: file.filename, sha256: file.sha256 })),
    );
    if (identity.length > 0) {
      throw new PyPiStageError("stage_identity_mismatch", summarizeProblems(identity));
    }
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

  const bundleByFilename = new Map(bundle.map((artifact) => [basename(artifact.path), artifact]));
  const parsed: ParsedGateArtifact[] = [];
  for (const file of files) {
    const kind = inferPyPiArtifactKind(file.filename);
    if (!kind) {
      throw new PyPiStageError(
        "stage_identity_mismatch",
        `${file.filename} is not a reviewable wheel or sdist`,
      );
    }
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
    // Identical bytes parse identically: reuse the bundle parse when the
    // staged download is byte-for-byte the artifact Drydock already parsed.
    const same = bundleByFilename.get(file.filename);
    if (same && same.sha256 === sha256) {
      parsed.push({ ...same, path: file.filename });
      continue;
    }
    parsed.push(
      await input.parse({
        path: file.filename,
        bytes,
        sha256,
        sha1: await sha1Hex(bytes),
        ecosystem: "pypi",
        kind,
      }),
    );
  }
  return parsed;
}

function groupBundleArtifacts(
  artifacts: ParsedGateArtifact[],
): Map<string, { name: string; artifacts: ParsedGateArtifact[] }> {
  const groups = new Map<string, { name: string; artifacts: ParsedGateArtifact[] }>();
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
