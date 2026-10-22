import { readBoundedJson } from "../../platform/bounded-body";
import { mapWithConcurrency } from "../../platform/concurrency";
import { isRecord } from "../../platform/guards";
import { emitOperationalEvent } from "../../platform/observability";
import { reliableFetch } from "../../platform/reliable-fetch";
import {
  attestedField,
  PROVENANCE_UNKNOWN,
  sameAttestedPublisher,
  type AttestedPublisher,
  type RegistryProvenance,
} from "../../provenance-continuity";
import { normalizePyPiProjectName } from "./manifest";

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
    return isRecord(body) && body.message === `No provenance available for ${filename}`
      ? { status: "absent" }
      : { status: "unknown" };
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
