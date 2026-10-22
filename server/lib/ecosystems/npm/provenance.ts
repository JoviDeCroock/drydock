import { readBoundedJson } from "../../platform/bounded-body";
import { isRecord } from "../../platform/guards";
import { emitOperationalEvent } from "../../platform/observability";
import { reliableFetch } from "../../platform/reliable-fetch";
import { decodeBase64 } from "../../platform/x509";
import {
  attestedField,
  attestedNumericId,
  attestedRepositoryFromUrl,
  PROVENANCE_UNKNOWN,
  sameAttestedPublisher,
  type AttestedPublisher,
  type RegistryProvenance,
} from "../../provenance-continuity";
import type { RegistryMetadata } from "./registry";

/**
 * npm's served provenance for one published version, reduced for
 * `provenanceContinuityFindings`.
 *
 * Presence comes from the packument (`dist.attestations.provenance`), which the
 * registry writes and a publisher cannot. Identity comes from the SLSA
 * statement at `/-/npm/v1/attestations/<name>@<version>`. The Sigstore bundle
 * is not re-verified: npm validates provenance against the publishing OIDC
 * identity before accepting it, and this trusts npm's served record over TLS.
 * The statement is still attacker-influenced (whoever ran the attested build
 * chose the workflow file), so it is bounded and every unreadable shape
 * collapses into "present, identity unknown" rather than an error.
 */

const NPM_PUBLIC_REGISTRY_ORIGIN = "https://registry.npmjs.org";

// A real response is ~14 KB (one SLSA and one publish attestation, each with a
// certificate and transparency-log entry).
const MAX_ATTESTATIONS_BYTES = 256 * 1024;
const MAX_PAYLOAD_BASE64_LENGTH = 128 * 1024;
const MAX_ATTESTATIONS = 8;
const FETCH_TIMEOUT_MS = 5_000;

const IN_TOTO_PAYLOAD_TYPE = "application/vnd.in-toto+json";
const SLSA_PREDICATE_PREFIX = "https://slsa.dev/provenance/";
const SLSA_V1_GITHUB_BUILD_TYPE =
  "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1";
const NPM_GHA_V02_BUILD_TYPE_PREFIX = "https://github.com/npm/cli/gha/";
const NPM_GITLAB_V02_BUILD_TYPE_PREFIX = "https://github.com/npm/cli/gitlab/";

/**
 * Read provenance for one side of a published pair. Only the public npm
 * registry is consulted: a custom registry's attestation endpoint (if it has
 * one) carries no npm-validated meaning, so it reads as unknown.
 */
export async function readNpmRegistryProvenance(
  metadata: RegistryMetadata,
  packageName: string,
  version: string,
  registryUrl: string,
): Promise<RegistryProvenance> {
  if (registryUrl.replace(/\/+$/, "") !== NPM_PUBLIC_REGISTRY_ORIGIN) return PROVENANCE_UNKNOWN;
  const hasProvenance = metadata.versions?.[version]?.hasProvenance;
  if (hasProvenance !== true) {
    return npmRegistryProvenance({ hasProvenance, attestations: null, packageName, version });
  }

  const url = `${NPM_PUBLIC_REGISTRY_ORIGIN}/-/npm/v1/attestations/${encodeURIComponent(packageName).replace(/^%40/, "@")}@${encodeURIComponent(version)}`;
  let document: unknown = null;
  try {
    const response = await reliableFetch(url, {
      headers: { accept: "application/json" },
      // npm serves this endpoint directly; a redirect is not part of the
      // contract and is not followed to another host.
      redirect: "manual",
      attempts: 1,
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      emitOperationalEvent("warn", "public_diff.npm_provenance.unavailable", {
        status: response.status,
      });
      return npmRegistryProvenance({ hasProvenance, attestations: null, packageName, version });
    }
    document = await readBoundedJson(response, {
      maxBytes: MAX_ATTESTATIONS_BYTES,
      deadlineMs: Date.now() + FETCH_TIMEOUT_MS,
    });
  } catch {
    emitOperationalEvent("warn", "public_diff.npm_provenance.unavailable", {
      status: "fetch_failed",
    });
    return npmRegistryProvenance({ hasProvenance, attestations: null, packageName, version });
  }
  return npmRegistryProvenance({ hasProvenance, attestations: document, packageName, version });
}

/**
 * Combine the packument's provenance marker with the attestations document
 * (null when it could not be read). Presence is the packument's call; the
 * document only supplies identity.
 */
export function npmRegistryProvenance(args: {
  hasProvenance: boolean | undefined;
  attestations: unknown;
  packageName: string;
  version: string;
}): RegistryProvenance {
  if (args.hasProvenance === false) return { status: "absent" };
  if (args.hasProvenance !== true) return PROVENANCE_UNKNOWN;
  return {
    status: "present",
    publishers: npmAttestedPublishers(args.attestations, args.packageName, args.version),
  };
}

/** Publishers named by the SLSA statements in an attestations response. Never throws. */
export function npmAttestedPublishers(
  document: unknown,
  packageName: string,
  version: string,
): AttestedPublisher[] {
  if (!isRecord(document) || !Array.isArray(document.attestations)) return [];
  const purl = `pkg:npm/${packageName.replace(/^@/, "%40")}@${version}`;
  const publishers: AttestedPublisher[] = [];
  for (const entry of document.attestations.slice(0, MAX_ATTESTATIONS)) {
    if (!isRecord(entry)) continue;
    const predicateType = attestedField(entry.predicateType);
    if (!predicateType?.startsWith(SLSA_PREDICATE_PREFIX)) continue;
    const statement = readStatement(entry.bundle);
    if (!statement || statement.predicateType !== predicateType) continue;
    // The record is served for this version; a statement about another
    // artifact is not evidence about this one.
    if (!statementNamesSubject(statement.subject, purl)) continue;
    const publisher = publisherFromPredicate(statement.predicate);
    if (publisher && !publishers.some((p) => sameAttestedPublisher(p, publisher))) {
      publishers.push(publisher);
    }
  }
  return publishers;
}

function readStatement(bundle: unknown): Record<string, unknown> | null {
  if (!isRecord(bundle) || !isRecord(bundle.dsseEnvelope)) return null;
  const envelope = bundle.dsseEnvelope;
  if (envelope.payloadType !== IN_TOTO_PAYLOAD_TYPE) return null;
  const payload = envelope.payload;
  if (typeof payload !== "string" || payload.length > MAX_PAYLOAD_BASE64_LENGTH) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(decodeBase64(payload)));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function statementNamesSubject(subject: unknown, purl: string): boolean {
  if (!Array.isArray(subject)) return false;
  return subject.slice(0, MAX_ATTESTATIONS).some((s) => isRecord(s) && s.name === purl);
}

function publisherFromPredicate(predicate: unknown): AttestedPublisher | null {
  if (!isRecord(predicate)) return null;

  // SLSA v1, written by the npm CLI for GitHub Actions since npm 9.6.
  const definition = predicate.buildDefinition;
  if (isRecord(definition)) {
    if (definition.buildType !== SLSA_V1_GITHUB_BUILD_TYPE) return null;
    const workflow = isRecord(definition.externalParameters)
      ? definition.externalParameters.workflow
      : null;
    if (!isRecord(workflow)) return null;
    const repository = attestedRepositoryFromUrl(workflow.repository);
    if (!repository) return null;
    const github =
      isRecord(definition.internalParameters) && isRecord(definition.internalParameters.github)
        ? definition.internalParameters.github
        : null;
    return {
      provider: "github",
      repository,
      repositoryId: attestedNumericId(github?.repository_id),
      workflow: attestedField(workflow.path),
    };
  }

  // SLSA v0.2: npm's early GitHub statements and its GitLab statements.
  const buildType = attestedField(predicate.buildType);
  const invocation = isRecord(predicate.invocation) ? predicate.invocation : null;
  const configSource =
    invocation && isRecord(invocation.configSource) ? invocation.configSource : null;
  if (!buildType || !configSource) return null;
  const repository = attestedRepositoryFromUrl(configSource.uri);
  if (!repository) return null;
  if (buildType.startsWith(NPM_GHA_V02_BUILD_TYPE_PREFIX)) {
    const environment = isRecord(invocation?.environment) ? invocation.environment : null;
    return {
      provider: "github",
      repository,
      repositoryId: attestedNumericId(environment?.GITHUB_REPOSITORY_ID),
      workflow: attestedField(configSource.entryPoint),
    };
  }
  if (buildType.startsWith(NPM_GITLAB_V02_BUILD_TYPE_PREFIX)) {
    const parameters = isRecord(invocation?.parameters) ? invocation.parameters : null;
    return {
      provider: "gitlab",
      repository,
      repositoryId: attestedNumericId(parameters?.CI_PROJECT_ID),
      // entryPoint is the GitLab job name; the pipeline config file is the
      // closer analogue of a GitHub workflow file.
      workflow: attestedField(parameters?.CI_CONFIG_PATH),
    };
  }
  return null;
}
