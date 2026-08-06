/**
 * Projection of an in-toto statement into the normalized `BuildClaim` the
 * verdict compares against Drydock's own bindings.
 *
 * Three predicate shapes are in circulation and all three reach Drydock:
 *
 *  - SLSA provenance v1 (`buildDefinition` / `runDetails`) — what
 *    `actions/attest-build-provenance` and current npm provenance emit;
 *  - SLSA provenance v0.2 (`invocation.configSource` / `metadata`) — what npm
 *    provenance emitted before the v1 migration, still attached to published
 *    versions from that era;
 *  - the npm publish attestation, which attests the publish event rather than a
 *    build and therefore carries no source binding at all.
 *
 * Projecting them into one shape keeps the verdict free of predicate-version
 * branching, and keeps "this predicate names no repository" a normal, quiet
 * outcome instead of a parse failure.
 */

import { normalizeRepositoryUrl } from "../intent-envelope";
import type { BuildClaim } from "./types";

// The statement is a small JSON document naming a handful of digests. Anything
// larger is padding, and decoding it before the size check would be the work
// the cap exists to prevent.
const MAX_STATEMENT_BYTES = 256 * 1024;
const MAX_SUBJECTS = 256;
const MAX_RESOLVED_DEPENDENCIES = 64;
const MAX_FIELD_LENGTH = 1024;

const IN_TOTO_STATEMENT_TYPES: ReadonlySet<string> = new Set([
  "https://in-toto.io/Statement/v1",
  "https://in-toto.io/Statement/v0.1",
]);

const SHA256_HEX = /^[0-9a-f]{64}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
// `https://github.com/owner/repo/actions/runs/<run>/attempts/<attempt>`
const INVOCATION_ID = /\/actions\/runs\/(\d{1,20})(?:\/attempts\/(\d{1,10}))?/;
// `git+https://github.com/owner/repo@refs/heads/main` and the commit-pinned form.
const GIT_URI_REF = /^(.*?)@(refs\/[^\s@]{1,512}|[0-9a-f]{40})$/;

/**
 * Decode and project a DSSE payload into a `BuildClaim`.
 *
 * Returns null when the payload is not a readable in-toto statement. A
 * statement that parses but names nothing useful still returns a claim — an
 * attestation that covers the right bytes while claiming no repository is a
 * real and reportable state, distinct from an unreadable one.
 */
export function parseInTotoStatement(payload: Uint8Array): BuildClaim | null {
  if (payload.length > MAX_STATEMENT_BYTES) return null;
  let statement: unknown;
  try {
    statement = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  } catch {
    return null;
  }
  if (!isRecord(statement)) return null;

  const type = statement._type;
  if (typeof type !== "string" || !IN_TOTO_STATEMENT_TYPES.has(type)) return null;

  const predicateType = str(statement.predicateType);
  if (!predicateType) return null;

  const predicate = isRecord(statement.predicate) ? statement.predicate : {};
  const source = projectSource(predicate);

  return {
    predicateType,
    repository: source.repository,
    workflowPath: source.workflowPath,
    ref: source.ref,
    commit: source.commit,
    runId: source.runId,
    runAttempt: source.runAttempt,
    builderId: source.builderId,
    subjectDigests: collectSubjectDigests(statement.subject),
  };
}

/**
 * Collect the lowercase-hex SHA-256 digests a statement's subjects cover.
 *
 * Only SHA-256 is collected: it is the algorithm Drydock recomputes from the
 * reviewed bytes, so it is the only one a cross-check can compare against.
 * Subjects carrying only other algorithms contribute nothing rather than a
 * digest the verdict would have to trust without being able to check it.
 */
function collectSubjectDigests(subjects: unknown): string[] {
  if (!Array.isArray(subjects)) return [];
  const digests = new Set<string>();
  for (const subject of subjects.slice(0, MAX_SUBJECTS)) {
    if (!isRecord(subject) || !isRecord(subject.digest)) continue;
    const sha256 = subject.digest.sha256;
    if (typeof sha256 !== "string") continue;
    const normalized = sha256.trim().toLowerCase();
    if (SHA256_HEX.test(normalized)) digests.add(normalized);
  }
  return [...digests].sort();
}

interface ProjectedSource {
  repository: string | null;
  workflowPath: string | null;
  ref: string | null;
  commit: string | null;
  runId: string | null;
  runAttempt: string | null;
  builderId: string | null;
}

const EMPTY_SOURCE: ProjectedSource = {
  repository: null,
  workflowPath: null,
  ref: null,
  commit: null,
  runId: null,
  runAttempt: null,
  builderId: null,
};

function projectSource(predicate: Record<string, unknown>): ProjectedSource {
  // v1 and v0.2 are distinguished by structure rather than by the statement's
  // declared predicate type, because the type string has carried several
  // spellings over its life while the shapes have not.
  if (isRecord(predicate.buildDefinition) || isRecord(predicate.runDetails)) {
    return projectSlsaV1(predicate);
  }
  if (isRecord(predicate.invocation) || isRecord(predicate.builder)) {
    return projectSlsaV02(predicate);
  }
  return EMPTY_SOURCE;
}

function projectSlsaV1(predicate: Record<string, unknown>): ProjectedSource {
  const buildDefinition = isRecord(predicate.buildDefinition) ? predicate.buildDefinition : {};
  const runDetails = isRecord(predicate.runDetails) ? predicate.runDetails : {};
  const external = isRecord(buildDefinition.externalParameters)
    ? buildDefinition.externalParameters
    : {};
  const workflow = isRecord(external.workflow) ? external.workflow : {};

  const invocation = parseInvocationId(
    isRecord(runDetails.metadata) ? str(runDetails.metadata.invocationId) : null,
  );

  return {
    repository: normalizeRepositoryUrl(str(workflow.repository)),
    workflowPath: str(workflow.path),
    ref: str(workflow.ref),
    // The source commit lives in the resolved dependency describing the repo
    // itself, not in externalParameters — a build can resolve a mutable branch
    // ref to a commit, and that resolution is the interesting fact.
    commit: resolvedSourceCommit(buildDefinition.resolvedDependencies),
    runId: invocation.runId,
    runAttempt: invocation.runAttempt,
    builderId: isRecord(runDetails.builder) ? str(runDetails.builder.id) : null,
  };
}

function projectSlsaV02(predicate: Record<string, unknown>): ProjectedSource {
  const invocation = isRecord(predicate.invocation) ? predicate.invocation : {};
  const configSource = isRecord(invocation.configSource) ? invocation.configSource : {};
  const metadata = isRecord(predicate.metadata) ? predicate.metadata : {};
  const parsedInvocation = parseInvocationId(str(metadata.buildInvocationId));

  const { uri, ref } = splitGitUri(str(configSource.uri));
  const digest = isRecord(configSource.digest) ? configSource.digest : {};
  // v0.2 labels the commit `sha1`; it is a git object id, not a content hash.
  const commit = normalizeCommit(str(digest.sha1) ?? str(digest.gitCommit));

  return {
    repository: normalizeRepositoryUrl(uri),
    workflowPath: str(configSource.entryPoint),
    ref,
    commit,
    runId: parsedInvocation.runId,
    runAttempt: parsedInvocation.runAttempt,
    builderId: isRecord(predicate.builder) ? str(predicate.builder.id) : null,
  };
}

/**
 * Find the source commit among a build's resolved dependencies: the entry whose
 * URI is the repository itself. Falls back to the first entry carrying a git
 * commit digest, which is the shape single-source builds emit.
 */
function resolvedSourceCommit(dependencies: unknown): string | null {
  if (!Array.isArray(dependencies)) return null;
  for (const dependency of dependencies.slice(0, MAX_RESOLVED_DEPENDENCIES)) {
    if (!isRecord(dependency) || !isRecord(dependency.digest)) continue;
    const commit = normalizeCommit(str(dependency.digest.gitCommit) ?? str(dependency.digest.sha1));
    if (commit) return commit;
  }
  return null;
}

/**
 * Split `git+https://host/owner/repo@refs/heads/main` into its repository URI
 * and ref. The `git+` scheme prefix is left in place — `normalizeRepositoryUrl`
 * already understands it.
 */
function splitGitUri(value: string | null): { uri: string | null; ref: string | null } {
  if (!value) return { uri: null, ref: null };
  const match = GIT_URI_REF.exec(value);
  if (!match) return { uri: value, ref: null };
  return { uri: match[1] || null, ref: match[2] || null };
}

function parseInvocationId(value: string | null): {
  runId: string | null;
  runAttempt: string | null;
} {
  if (!value) return { runId: null, runAttempt: null };
  const match = INVOCATION_ID.exec(value);
  if (!match) return { runId: null, runAttempt: null };
  return { runId: match[1], runAttempt: match[2] ?? null };
}

function normalizeCommit(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return COMMIT_SHA.test(normalized) ? normalized : null;
}

function str(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_FIELD_LENGTH) return null;
  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
