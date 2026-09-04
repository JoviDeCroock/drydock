import { isRecord } from "../../platform/guards";

/**
 * Who produced a staged npm release, assembled from three registry sources:
 * the stage record's actor, the package's trusted-publisher (OIDC) configs,
 * and the SLSA provenance npm attached to the previous published version.
 *
 * Every value here is parsed from registry JSON that a compromised account or
 * a hostile registry controls, so this module is pure parsing with hard
 * bounds: any field that does not fit collapses to `null`, never to a
 * finding. Kept free of fetch code so the UI and the report export can share
 * the persisted-shape parser.
 */

export type NpmTrustConfigsState = "checked" | "unavailable" | "unsupported";

/**
 * Synthetic `file` label for publisher findings. It never matches an artifact
 * path, so the diff annotator classifies these as package context rather than
 * release delta: they describe the publishing path, not the bytes, and must
 * not move release risk or a gate recommendation.
 */
export const PUBLISHER_FINDING_FILE = "<publisher>";

export interface NpmTrustConfig {
  id: string | null;
  /** npm's `type`: `github`, `gitlab`, `circleci`, or a provider we do not model. */
  provider: string | null;
  repository: string | null;
  workflowFile: string | null;
  environment: string | null;
  /** `createPackage`: the config may run `npm publish` directly. */
  directPublish: boolean;
  /** `createStagedPackage`: the config may run `npm stage publish`. */
  stagePublish: boolean;
}

export interface NpmBuildIdentity {
  repository: string | null;
  workflowPath: string | null;
  ref: string | null;
  builderId: string | null;
}

export interface NpmStagePublisher {
  actor: string | null;
  actorType: string | null;
  trustConfigs: NpmTrustConfig[] | null;
  trustConfigsState: NpmTrustConfigsState;
  previousBuild: NpmBuildIdentity | null;
  stagedBuild: NpmBuildIdentity | null;
}

// npm allows ten configs per package; the margin absorbs a registry that
// grows the cap without letting a hostile body allocate unboundedly.
const MAX_TRUST_CONFIGS = 32;
const MAX_FIELD_LENGTH = 512;
const MAX_ATTESTATIONS = 16;

const SLSA_PREDICATE_TYPES = new Set([
  "https://slsa.dev/provenance/v1",
  "https://slsa.dev/provenance/v0.2",
]);
const IN_TOTO_STATEMENT_TYPES = new Set([
  "https://in-toto.io/Statement/v1",
  "https://in-toto.io/Statement/v0.1",
]);

/**
 * npm's stage record calls an OIDC-produced stage "trusted automation"; a
 * token-produced one is "automation" and an interactive publish is "user".
 * Case and separator are relaxed because the value is display text, not an
 * enum npm documents; anything else — including an unknown value — is not
 * trusted automation and, when the actor type is absent, raises nothing.
 */
export function isTrustedAutomationActor(actorType: string | null | undefined): boolean {
  return typeof actorType === "string" && /^trusted[ _-]?automation$/i.test(actorType.trim());
}

/**
 * `GET /-/package/{name}/trust` body → bounded config list, or null when the
 * body carries no list. The npm CLI tolerates a single config object as well
 * as an array (`Array.isArray(body) ? body : [body]`), so both are read; any
 * other shape is unknown rather than "no configs".
 */
export function parseNpmTrustConfigs(data: unknown): NpmTrustConfig[] | null {
  const list = Array.isArray(data)
    ? data
    : isRecord(data) && (isRecord(data.claims) || typeof data.type === "string")
      ? [data]
      : null;
  if (!list) return null;
  const configs: NpmTrustConfig[] = [];
  for (const entry of list.slice(0, MAX_TRUST_CONFIGS)) {
    const config = parseTrustConfig(entry);
    if (config) configs.push(config);
  }
  return configs;
}

function parseTrustConfig(value: unknown): NpmTrustConfig | null {
  if (!isRecord(value)) return null;
  const claims = isRecord(value.claims) ? value.claims : {};
  const provider = readText(value.type)?.toLowerCase() ?? null;
  const permissions = Array.isArray(value.permissions) ? value.permissions : [];
  const workflowRef = isRecord(claims.workflow_ref) ? claims.workflow_ref : null;
  const ciConfigRef = isRecord(claims.ci_config_ref_uri) ? claims.ci_config_ref_uri : null;
  return {
    id: readText(value.id),
    provider,
    repository:
      readText(claims.repository) ??
      readText(claims.project_path) ??
      readText(claims["oidc.circleci.com/vcs-origin"]),
    workflowFile: readText(workflowRef?.file) ?? readText(ciConfigRef?.file),
    environment: readText(claims.environment),
    directPublish: permissions.includes("createPackage"),
    stagePublish: permissions.includes("createStagedPackage"),
  };
}

/**
 * `GET /-/npm/v1/attestations/{name}@{version}` body → the build identity of
 * the first SLSA provenance attestation, read from the unverified DSSE
 * payload. This is deliberately not signature verification: the identity is
 * displayed and compared, never trusted as proof, and the reader says so.
 */
export function parseNpmBuildIdentity(data: unknown): NpmBuildIdentity | null {
  if (!isRecord(data) || !Array.isArray(data.attestations)) return null;
  for (const attestation of data.attestations.slice(0, MAX_ATTESTATIONS)) {
    if (!isRecord(attestation)) continue;
    if (
      typeof attestation.predicateType !== "string" ||
      !SLSA_PREDICATE_TYPES.has(attestation.predicateType)
    ) {
      continue;
    }
    const bundle = isRecord(attestation.bundle) ? attestation.bundle : null;
    const envelope = bundle && isRecord(bundle.dsseEnvelope) ? bundle.dsseEnvelope : null;
    const statement = decodeStatement(envelope?.payload);
    if (!statement) continue;
    const identity = buildIdentityFromPredicate(statement.predicate);
    if (identity) return identity;
  }
  return null;
}

// DSSE payloads are a few kilobytes of JSON; anything past this is not a
// provenance statement npm produced.
const MAX_PAYLOAD_BASE64_LENGTH = 64 * 1024;

function decodeStatement(payload: unknown): Record<string, unknown> | null {
  if (typeof payload !== "string" || !payload || payload.length > MAX_PAYLOAD_BASE64_LENGTH) {
    return null;
  }
  let text: string;
  try {
    const bytes = Uint8Array.from(atob(payload), (char) => char.charCodeAt(0));
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (typeof value._type !== "string" || !IN_TOTO_STATEMENT_TYPES.has(value._type)) return null;
  return value;
}

function buildIdentityFromPredicate(predicate: unknown): NpmBuildIdentity | null {
  if (!isRecord(predicate)) return null;
  // SLSA v1: buildDefinition.externalParameters.workflow + runDetails.builder.
  const buildDefinition = isRecord(predicate.buildDefinition) ? predicate.buildDefinition : null;
  const external =
    buildDefinition && isRecord(buildDefinition.externalParameters)
      ? buildDefinition.externalParameters
      : null;
  const workflow = external && isRecord(external.workflow) ? external.workflow : null;
  if (workflow) {
    const runDetails = isRecord(predicate.runDetails) ? predicate.runDetails : null;
    const builder = runDetails && isRecord(runDetails.builder) ? runDetails.builder : null;
    return finishIdentity({
      repository: normalizeRepository(readText(workflow.repository)),
      workflowPath: readText(workflow.path),
      ref: readText(workflow.ref),
      builderId: readText(builder?.id),
    });
  }
  // SLSA v0.2: invocation.configSource.entryPoint is
  // `owner/repo/.github/workflows/file.yml@ref` and uri is `git+https://...@ref`.
  const invocation = isRecord(predicate.invocation) ? predicate.invocation : null;
  const configSource =
    invocation && isRecord(invocation.configSource) ? invocation.configSource : null;
  if (configSource) {
    const builder = isRecord(predicate.builder) ? predicate.builder : null;
    const uri = readText(configSource.uri);
    const [uriRepository, uriRef] = splitAtRef(uri ? uri.replace(/^git\+/, "") : null);
    const entryPoint = readText(configSource.entryPoint);
    const [entryPath] = splitAtRef(entryPoint);
    const repository = normalizeRepository(uriRepository);
    const workflowPath =
      entryPath && repository && entryPath.toLowerCase().startsWith(`${repository}/`)
        ? entryPath.slice(repository.length + 1)
        : entryPath;
    return finishIdentity({
      repository,
      workflowPath,
      ref: uriRef,
      builderId: readText(builder?.id),
    });
  }
  return null;
}

function finishIdentity(identity: NpmBuildIdentity): NpmBuildIdentity | null {
  return identity.repository || identity.workflowPath || identity.builderId ? identity : null;
}

function splitAtRef(value: string | null): [string | null, string | null] {
  if (!value) return [null, null];
  const at = value.indexOf("@");
  if (at === -1) return [value, null];
  return [value.slice(0, at) || null, value.slice(at + 1) || null];
}

/**
 * Canonical `owner/repo`-style slug for comparing a trust config's repository
 * claim with a provenance repository. GitHub is the only host whose slug
 * npm's trust claim omits, so it is the only host prefix stripped; every
 * other host stays in the slug so `gitlab.com/a/b` never equals `a/b`.
 */
export function normalizeRepository(value: string | null): string | null {
  if (!value) return null;
  let slug = value
    .trim()
    .replace(/^git\+/, "")
    .replace(/^https?:\/\//i, "");
  slug = slug.replace(/^github\.com\//i, "");
  slug = slug.replace(/\.git$/i, "").replace(/\/+$/, "");
  return slug ? slug.toLowerCase() : null;
}

/**
 * Re-validate a persisted `publisher` block. Reports carry adapter-shaped
 * JSON written by older or newer code, so readers narrow it here instead of
 * trusting the stored shape.
 */
export function parseNpmStagePublisher(value: unknown): NpmStagePublisher | null {
  if (!isRecord(value)) return null;
  const state = value.trustConfigsState;
  if (state !== "checked" && state !== "unavailable" && state !== "unsupported") return null;
  const trustConfigs = state === "checked" ? parseNpmTrustConfigs(value.trustConfigs) : null;
  return {
    actor: readText(value.actor),
    actorType: readText(value.actorType),
    trustConfigs,
    trustConfigsState: state,
    previousBuild: parsePersistedBuild(value.previousBuild),
    stagedBuild: parsePersistedBuild(value.stagedBuild),
  };
}

function parsePersistedBuild(value: unknown): NpmBuildIdentity | null {
  if (!isRecord(value)) return null;
  return finishIdentity({
    repository: readText(value.repository),
    workflowPath: readText(value.workflowPath),
    ref: readText(value.ref),
    builderId: readText(value.builderId),
  });
}

// Bounded, single-line display text. Control characters would let a registry
// inject line breaks into finding evidence and the report; an over-long value
// is not a repository, file, or environment name.
function readText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_FIELD_LENGTH) return null;
  for (const char of trimmed) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return null;
  }
  return trimmed;
}
