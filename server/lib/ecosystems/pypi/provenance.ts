import { readBoundedJson } from "../../platform/bounded-body";
import { mapWithConcurrency } from "../../platform/concurrency";
import { isRecord } from "../../platform/guards";
import { emitOperationalEvent } from "../../platform/observability";
import { reliableFetch } from "../../platform/reliable-fetch";
import {
  attestedField,
  evaluateProvenanceContinuity,
  PROVENANCE_NOT_EVALUATED,
  PROVENANCE_UNKNOWN,
  provenanceLineage,
  sameAttestedPublisher,
  type AttestedPublisher,
  type ProvenanceContinuityOutcome,
  type ProvenanceLineage,
  type ProvenanceVersionScheme,
  type RegistryProvenance,
} from "../../provenance-continuity";
import { normalizePyPiProjectName } from "./manifest";
import type { PyPiProjectMetadata, PyPiReleaseFile } from "./types";
import { compareParsedPyPiVersions, parsePyPiVersion, type ParsedPyPiVersion } from "./version";

/**
 * PyPI's served provenance (PEP 740) for one release, reduced for
 * `provenanceContinuityFindings`.
 *
 * Read from the integrity API, `GET /integrity/<project>/<version>/<file>/provenance`.
 * The `publisher` object in each attestation bundle is written by PyPI from the
 * Trusted Publisher that uploaded the file, not taken from the bundle, and PyPI
 * verifies the attestations against that publisher at upload. Signatures are
 * not re-verified here: this trusts PyPI's served record over TLS.
 */

const PYPI_INTEGRITY_ORIGIN = "https://pypi.org/integrity";
const INTEGRITY_ACCEPT = "application/vnd.pypi.integrity.v1+json";
// A real response is ~9 KB per file.
const MAX_PROVENANCE_BYTES = 256 * 1024;
const MAX_BUNDLES = 8;
const FETCH_TIMEOUT_MS = 5_000;
const FETCH_CONCURRENCY = 2;

type FileProvenance =
  | { status: "present"; publishers: AttestedPublisher[] }
  | { status: "absent" }
  | { status: "unknown" };

type ReadReleaseProvenance = (version: string, filenames: string[]) => Promise<RegistryProvenance>;

/**
 * Provenance continuity for a published PyPI pair. Each compared side is read
 * from the files the diff selected (or, when `provenanceLineage` substitutes a
 * baseline, that release's representative file). History costs one integrity
 * request per prior release, so it is read only when the drop rule needs it.
 * `readProvenance` is a seam for tests.
 */
export async function pypiProvenanceContinuity(args: {
  metadata: PyPiProjectMetadata;
  projectName: string;
  fromVersion: string;
  toVersion: string;
  fromFilenames: string[];
  toFilenames: string[];
  readProvenance?: ReadReleaseProvenance;
}): Promise<ProvenanceContinuityOutcome> {
  const lineage = pypiProvenanceLineage(args.metadata, args.fromVersion, args.toVersion);
  if (!lineage) return PROVENANCE_NOT_EVALUATED;
  const read: ReadReleaseProvenance =
    args.readProvenance ??
    ((version, filenames) => readPyPiRegistryProvenance(args.projectName, version, filenames));
  const baselineVersion = lineage.baseline;
  const [baseline, candidate] = await Promise.all([
    baselineVersion === null
      ? null
      : read(
          baselineVersion,
          baselineVersion === args.fromVersion
            ? args.fromFilenames
            : representativeFilenames(args.metadata, baselineVersion),
        ),
    read(args.toVersion, args.toFilenames),
  ]);
  // The set-aside prerelease is the requested baseline, so its checked files
  // are the diff's. Read only when it could still speak.
  const prerelease = lineage.prerelease;
  const prereleaseProvenance =
    prerelease !== null &&
    candidate.status === "absent" &&
    (!baseline || baseline.status === "absent")
      ? await read(prerelease, args.fromFilenames)
      : null;
  const prior =
    baseline?.status === "present" && candidate.status === "absent"
      ? await Promise.all(
          lineage.prior.map(async (version) => {
            const filenames = representativeFilenames(args.metadata, version);
            return filenames.length ? (await read(version, filenames)).status : "unknown";
          }),
        )
      : [];
  return evaluateProvenanceContinuity({
    registry: "PyPI",
    baseline:
      baselineVersion === null || !baseline
        ? null
        : { version: baselineVersion, provenance: baseline },
    candidate: { version: args.toVersion, provenance: candidate },
    prereleaseBaseline:
      prerelease === null || !prereleaseProvenance
        ? null
        : { version: prerelease, provenance: prereleaseProvenance },
    prior,
    absenceScope: "checked-files",
  });
}

export function pypiProvenanceLineage(
  metadata: PyPiProjectMetadata,
  fromVersion: string,
  toVersion: string,
): ProvenanceLineage | null {
  return provenanceLineage(
    pypiVersionScheme(metadata),
    Object.keys(metadata.releases ?? {}).filter(
      (version) => representativeFilenames(metadata, version).length,
    ),
    fromVersion,
    toVersion,
  );
}

function pypiVersionScheme(
  metadata: PyPiProjectMetadata,
): ProvenanceVersionScheme<ParsedPyPiVersion> {
  return {
    parse: parsePyPiVersion,
    compare: compareParsedPyPiVersions,
    isPrerelease: (version) => version.pre !== null || version.dev !== null,
    // A release's first upload; wheels for new interpreters arrive later.
    publishedAt: (version) => {
      let earliest: number | null = null;
      for (const file of releaseFiles(metadata, version)) {
        const ms = Date.parse(file.upload_time_iso_8601 ?? "");
        if (Number.isFinite(ms) && (earliest === null || ms < earliest)) earliest = ms;
      }
      return earliest;
    },
  };
}

function releaseFiles(metadata: PyPiProjectMetadata, version: string): PyPiReleaseFile[] {
  const releases = metadata.releases;
  const files = releases && Object.hasOwn(releases, version) ? releases[version] : null;
  return Array.isArray(files) ? files : [];
}

// One file stands for a release outside the diff: the sdist when there is one,
// else the first wheel by name. A release whose other files are attested but
// this one is not reads as absent, which only ever keeps a drop at low.
function representativeFilenames(metadata: PyPiProjectMetadata, version: string): string[] {
  const files = releaseFiles(metadata, version).filter(
    (file) => typeof file.filename === "string" && file.yanked !== true,
  );
  const sdist = files.find((file) => file.packagetype === "sdist");
  const wheel = files
    .filter((file) => file.packagetype === "bdist_wheel")
    .map((file) => file.filename as string)
    .sort()[0];
  const pick = sdist?.filename ?? wheel;
  return pick ? [pick] : [];
}

/**
 * Provenance for a release, from the files this review selected. A release is
 * absent only when every checked file is affirmatively absent; any file with
 * provenance makes it present; anything else is unknown.
 */
export async function readPyPiRegistryProvenance(
  projectName: string,
  version: string,
  filenames: string[],
): Promise<RegistryProvenance> {
  if (!filenames.length) return PROVENANCE_UNKNOWN;
  const files = await mapWithConcurrency(filenames, FETCH_CONCURRENCY, (filename) =>
    readFileProvenance(projectName, version, filename),
  );
  return combinePyPiFileProvenance(files);
}

export function combinePyPiFileProvenance(files: FileProvenance[]): RegistryProvenance {
  const present = files.filter((file) => file.status === "present");
  if (present.length) {
    const publishers: AttestedPublisher[] = [];
    for (const file of present) {
      for (const publisher of file.publishers) {
        if (!publishers.some((p) => sameAttestedPublisher(p, publisher)))
          publishers.push(publisher);
      }
    }
    return { status: "present", publishers };
  }
  if (files.length && files.every((file) => file.status === "absent")) return { status: "absent" };
  return PROVENANCE_UNKNOWN;
}

async function readFileProvenance(
  projectName: string,
  version: string,
  filename: string,
): Promise<FileProvenance> {
  try {
    // Inside the try: the name and filenames come from registry metadata, and
    // a malformed one (lone surrogate, non-string) must not fail the diff.
    const url = `${PYPI_INTEGRITY_ORIGIN}/${encodeURIComponent(normalizePyPiProjectName(projectName))}/${encodeURIComponent(version)}/${encodeURIComponent(filename)}/provenance`;
    const response = await reliableFetch(url, {
      headers: { accept: INTEGRITY_ACCEPT },
      redirect: "manual",
      attempts: 1,
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    const body = await readBoundedJson(response, {
      maxBytes: MAX_PROVENANCE_BYTES,
      deadlineMs: Date.now() + FETCH_TIMEOUT_MS,
    });
    return classifyPyPiProvenanceResponse(response.status, body, filename);
  } catch {
    emitOperationalEvent("warn", "public_diff.pypi_provenance.unavailable", {
      status: "fetch_failed",
    });
    return { status: "unknown" };
  }
}

/**
 * 404 means both "no provenance for this file" and "no such file". Only the
 * JSON body PyPI serves for the former counts as absent; the HTML not-found
 * page, a 403 (integrity API administratively disabled), or any other shape is
 * unknown, so an outage can never read as a dropped attestation.
 */
export function classifyPyPiProvenanceResponse(
  status: number,
  body: unknown,
  filename: string,
): FileProvenance {
  if (status === 404) {
    if (isRecord(body) && body.message === `No provenance available for ${filename}`) {
      return { status: "absent" };
    }
    // Visible because every such pair is cached briefly: a changed message
    // would quietly shorten every PyPI diff's cache lifetime.
    emitOperationalEvent("warn", "public_diff.pypi_provenance.unavailable", {
      status: "not_found_unrecognized",
    });
    return { status: "unknown" };
  }
  if (status !== 200) {
    emitOperationalEvent("warn", "public_diff.pypi_provenance.unavailable", { status });
    return { status: "unknown" };
  }
  if (!isRecord(body) || body.version !== 1 || !Array.isArray(body.attestation_bundles)) {
    return { status: "present", publishers: [] };
  }
  const publishers: AttestedPublisher[] = [];
  for (const bundle of body.attestation_bundles.slice(0, MAX_BUNDLES)) {
    if (!isRecord(bundle)) continue;
    const publisher = publisherFromPyPi(bundle.publisher);
    if (publisher && !publishers.some((p) => sameAttestedPublisher(p, publisher))) {
      publishers.push(publisher);
    }
  }
  return { status: "present", publishers };
}

function publisherFromPyPi(value: unknown): AttestedPublisher | null {
  if (!isRecord(value)) return null;
  const repository = attestedField(value.repository);
  // A slug: owner/repo on GitHub, group/subgroup/project on GitLab.
  const segments = repository?.split("/") ?? [];
  if (
    segments.length < 2 ||
    segments.some((segment) => !/^[A-Za-z0-9._-]+$/.test(segment) || /^\.+$/.test(segment))
  ) {
    return null;
  }
  if (value.kind === "GitHub") {
    return {
      provider: "github",
      repository: `github.com/${repository}`,
      repositoryId: null,
      workflow: attestedField(value.workflow),
    };
  }
  if (value.kind === "GitLab") {
    return {
      provider: "gitlab",
      repository: `gitlab.com/${repository}`,
      repositoryId: null,
      workflow: attestedField(value.workflow_filepath),
    };
  }
  // Google and other publishers name a service identity, not a repository.
  return null;
}
