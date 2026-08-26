import {
  assertPublicHttpsUrl,
  readBoundedJson,
  reliablePublicHttpsFetch,
  type AtpmRepoIdentity,
} from "./identity";
import type { AtpmProvenance } from "./provenance";
import { PublicDiffError } from "../../public-diff/error";

const ATPM_TRUST_PUBLISHER_COLLECTION = "dev.atpm.alpha.trustPublisher";

// Bump when retained fields or validation semantics change.
export const ATPM_TRUST_PUBLISHER_RULES_VERSION = "1";

const TRUST_PUBLISHER_TIMEOUT_MS = 8_000;

const MAX_TRUST_PUBLISHER_BYTES = 64 * 1024;

const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_REPOSITORY_RE = /^[A-Za-z0-9._-]{1,100}$/;
const GITHUB_WORKFLOW_RE = /^[A-Za-z0-9._-]{1,100}$/;

export interface AtpmTrustedGithubPublisher {
  username: string;
  repository: string;
  workflow: string;
}

export interface AtpmTrustPublisher {
  createdAt: string;
  allowStage: boolean;
  allowPublish: boolean;
  github: AtpmTrustedGithubPublisher | null;
}

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
  if (body?.error === "RecordNotFound" || response.status === 404) return null;
  if (!response.ok || !body) {
    throw new PublicDiffError("trusted publisher record fetch failed", 502);
  }
  return parseAtpmTrustPublisherRecord(body.value);
}

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

export function trustedPublisherRepositoryUri(github: AtpmTrustedGithubPublisher): string {
  return `https://github.com/${github.username}/${github.repository}`;
}

export type TrustedPublisherMatch =
  | { status: "match" }
  | { status: "unknown-provider" }
  | { status: "repository-mismatch"; expected: string; actual: string }
  | { status: "workflow-unverified"; expected: string }
  | { status: "workflow-mismatch"; expected: string; actual: string };

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
