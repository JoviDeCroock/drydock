import {
  assertPublicHttpsUrl,
  readBoundedJson,
  reliablePublicHttpsFetch,
  type AtpmRepoIdentity,
} from "./identity";
import type { AtpmProvenance } from "./provenance";
import { PublicDiffError } from "../../public-diff/error";

/**
 * The `dev.atpm.alpha.trustPublisher` record: a publisher's declaration that a
 * particular GitHub Actions workflow may act for one of their packages.
 *
 * atpm's trusted publishing works the way npm's and PyPI's do. The workflow
 * presents a GitHub OIDC token, atpm checks it against this record, and mints a
 * short-lived credential scoped to that one package — so a release needs no
 * long-lived token in CI at all. `allowStage` and `allowPublish` split that
 * permission in two: a workflow can be allowed to stage a candidate without
 * being allowed to publish it, which leaves a human in the loop by design.
 *
 * The record lives in the publisher's own repository, keyed by the same record
 * key as the package, so Drydock reads it through the identity it already
 * verified — no credentials, no atpm.dev. Being publisher-written, it is a
 * *declaration*, not evidence: what makes it load-bearing is that a Sigstore
 * bundle independently proves which repository actually built a release
 * (`./provenance.ts`), and this record says which repository was supposed to.
 * The finding is in the disagreement.
 */
export const ATPM_TRUST_PUBLISHER_COLLECTION = "dev.atpm.alpha.trustPublisher";

/**
 * Cache-identity segment for reading and validating a trusted-publisher record.
 * Bump when the retained shape or its validation changes.
 */
export const ATPM_TRUST_PUBLISHER_RULES_VERSION = "1";

const TRUST_PUBLISHER_TIMEOUT_MS = 8_000;

// A trusted-publisher record is a handful of short strings.
const MAX_TRUST_PUBLISHER_BYTES = 64 * 1024;

// GitHub's own limits: an owner is at most 39 characters of alphanumerics and
// single hyphens, a repository at most 100 of a slightly wider set.
const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_REPOSITORY_RE = /^[A-Za-z0-9._-]{1,100}$/;
// atpm interpolates this straight into `.github/workflows/<workflow>@`, so a
// separator or traversal segment here would widen the ref prefix it matches.
const GITHUB_WORKFLOW_RE = /^[A-Za-z0-9._-]{1,100}$/;

export interface AtpmTrustedGithubPublisher {
  username: string;
  repository: string;
  /** Workflow file name, relative to `.github/workflows/`. */
  workflow: string;
}

export interface AtpmTrustPublisher {
  createdAt: string;
  /** CI may create a staged candidate for this package. */
  allowStage: boolean;
  /** CI may publish without a human approving the staged candidate. */
  allowPublish: boolean;
  /**
   * The GitHub Actions identity that may act for this package. Null when the
   * record declares a provider this deployment does not know how to check —
   * the lexicon reserves room for others — which is not the same as "no
   * trusted publisher", and callers must not read it as an absent declaration.
   */
  github: AtpmTrustedGithubPublisher | null;
}

/**
 * Read a package's trusted-publisher record, or null when it has none.
 *
 * Absence is the common case and is not an error: most packages are published
 * from a laptop. It is reported as null so the caller can distinguish "no
 * declaration to compare provenance against" from "the declaration disagrees".
 */
export async function fetchAtpmTrustPublisher(
  identity: AtpmRepoIdentity,
  name: string,
): Promise<AtpmTrustPublisher | null> {
  const url = new URL("/xrpc/com.atproto.repo.getRecord", identity.pds);
  url.searchParams.set("repo", identity.did);
  url.searchParams.set("collection", ATPM_TRUST_PUBLISHER_COLLECTION);
  url.searchParams.set("rkey", name);
  assertPublicHttpsUrl(url.toString(), "PDS endpoint");

  let response: Response;
  try {
    response = await reliablePublicHttpsFetch(url.toString(), "PDS endpoint", {
      headers: new Headers({ accept: "application/json" }),
      timeoutMs: TRUST_PUBLISHER_TIMEOUT_MS,
    });
  } catch {
    throw new PublicDiffError("trusted publisher record fetch failed", 502);
  }

  const body = await readBoundedJson<{ value?: unknown; error?: unknown }>(
    response,
    MAX_TRUST_PUBLISHER_BYTES,
  );
  // A PDS answers "no such record" with 400 RecordNotFound rather than 404.
  if (body?.error === "RecordNotFound" || response.status === 404) return null;
  if (!response.ok || !body) {
    throw new PublicDiffError("trusted publisher record fetch failed", 502);
  }
  // A record that exists but does not parse is reported as absent rather than
  // failing the page: a publisher's malformed declaration must not make their
  // package undiffable, and "no declaration to compare against" is the honest
  // reading of a value nothing can be concluded from.
  return parseAtpmTrustPublisherRecord(body.value);
}

/** Reduce a raw record value to the fields that are read, or null. */
export function parseAtpmTrustPublisherRecord(value: unknown): AtpmTrustPublisher | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.$type !== ATPM_TRUST_PUBLISHER_COLLECTION) return null;
  if (typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))) {
    return null;
  }
  if (typeof record.allowStage !== "boolean" || typeof record.allowPublish !== "boolean") {
    return null;
  }
  return {
    createdAt: record.createdAt,
    allowStage: record.allowStage,
    allowPublish: record.allowPublish,
    github: parseGithubPublisher(record.github),
  };
}

function parseGithubPublisher(value: unknown): AtpmTrustedGithubPublisher | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const github = value as Record<string, unknown>;
  const username = typeof github.username === "string" ? github.username.trim() : "";
  const repository = typeof github.repository === "string" ? github.repository.trim() : "";
  const workflow = typeof github.workflow === "string" ? github.workflow.trim() : "";
  if (!GITHUB_OWNER_RE.test(username)) return null;
  if (!GITHUB_REPOSITORY_RE.test(repository)) return null;
  if (!GITHUB_WORKFLOW_RE.test(workflow)) return null;
  return { username, repository, workflow };
}

/** The repository URI a Fulcio certificate would carry for this publisher. */
export function trustedPublisherRepositoryUri(github: AtpmTrustedGithubPublisher): string {
  return `https://github.com/${github.username}/${github.repository}`;
}

export type TrustedPublisherMatch =
  | { status: "match" }
  /** The declaration names a provider this deployment cannot check. */
  | { status: "unknown-provider" }
  | { status: "repository-mismatch"; expected: string; actual: string }
  | { status: "workflow-unverified"; expected: string }
  | { status: "workflow-mismatch"; expected: string; actual: string };

/**
 * Compare verified build provenance against what the publisher declared.
 *
 * The repository comparison is exact and case-insensitive, matching how GitHub
 * treats owner and repository names. A trusted-publisher match requires the
 * certificate-authenticated workflow identity too; a missing build-config
 * extension is reported separately from an observed mismatch.
 */
export function matchTrustedPublisher(
  provenance: AtpmProvenance,
  publisher: AtpmTrustPublisher,
): TrustedPublisherMatch {
  if (!publisher.github) return { status: "unknown-provider" };
  const expectedRepository = trustedPublisherRepositoryUri(publisher.github);
  const actualRepository = provenance.sourceRepository.replace(/\.git$/, "").replace(/\/+$/, "");
  if (actualRepository.toLowerCase() !== expectedRepository.toLowerCase()) {
    return {
      status: "repository-mismatch",
      expected: expectedRepository,
      actual: provenance.sourceRepository,
    };
  }
  const expectedWorkflow = `.github/workflows/${publisher.github.workflow}`;
  if (!provenance.workflowPath) {
    return { status: "workflow-unverified", expected: expectedWorkflow };
  }
  if (provenance.workflowPath !== expectedWorkflow) {
    return {
      status: "workflow-mismatch",
      expected: expectedWorkflow,
      actual: provenance.workflowPath,
    };
  }
  return { status: "match" };
}
