import { sha1Hex, sha256Hex } from "../../platform/crypto-utils";
import { emitOperationalEvent } from "../../platform/observability";
import { WorkflowArtifactError } from "../../github-app/artifacts";
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
  mergeStageReferences,
  parsePyPiStageReference,
  selectStagedReleaseFiles,
  summarizeProblems,
  type PyPiStageReferenceEntry,
} from "./stage";
import { downloadStagedFile, fetchStageProjectPage } from "./stage-fetch";
import { PYPI_ARTIFACT_LIMIT } from "./types";
import { pyPiVersionsEquivalent } from "./version";

/**
 * PEP 694 mode A: review the bytes a PEP 694 stage holds.
 *
 * The workflow registered a stage in `pypi-stage.json`. For each registered
 * project Drydock reads the stage page and downloads every staged file for
 * that version (credential-free, allowlisted origins only), checks each
 * download against the digest the index declares, and parses the staged
 * bytes in the sandbox. Those parsed staged files are the release candidate.
 * If the bundle also carries distributions for the project, both sides must
 * be byte-identical: same filenames, same sha256, nothing extra on either.
 *
 * Every mismatch throws a maintainer-facing `WorkflowArtifactError`, which
 * rejects the held deployment; there is no partial review of a stage.
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

  const bundleByProject = groupBundleArtifacts(input.artifacts);
  for (const [project, group] of bundleByProject) {
    if (!references.has(project)) {
      throw new PyPiStageError(
        "stage_reference_invalid",
        `the artifact carries ${group.name} but ${PYPI_STAGE_REFERENCE_FILENAME} registers no stage for it`,
      );
    }
  }

  const staged: ParsedGateArtifact[] = [];
  const bindings = new Map<
    string,
    { entry: PyPiStageReferenceEntry; binding: ReleaseStageBinding }
  >();
  // Sequential on purpose: one staged distribution is held in memory at a time.
  for (const [project, entry] of references) {
    const bundle = bundleByProject.get(project)?.artifacts ?? [];
    staged.push(...(await reviewStage(entry, bundle, input)));
    bindings.set(project, {
      entry,
      binding: {
        protocol: "pep694",
        index: entry.stageUrl.origin,
        artifactBound: bundle.length > 0,
      },
    });
  }

  const candidates = prepareReleaseCandidates(staged);
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
  for (const [, registered] of bindings) {
    emitOperationalEvent("info", "pypi.stage.reviewed", {
      // Index origin only: the stage URL is a capability and never logged.
      index: registered.binding.index,
      artifactBound: registered.binding.artifactBound,
    });
  }
  return result;
}

async function reviewStage(
  entry: PyPiStageReferenceEntry,
  bundle: ParsedGateArtifact[],
  input: StagedReleaseInput,
): Promise<ParsedGateArtifact[]> {
  const page = await fetchStageProjectPage(entry.stageUrl, entry.name);
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
    const bytes = await downloadStagedFile(file.url, entry.stageUrl.origin, file.filename);
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
