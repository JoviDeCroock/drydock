import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { generateKeyPairSync } from "node:crypto";
import { vi } from "vitest";
import { createDb } from "../../../server/db/client";
import { saveDependencyReviewSettings } from "../../../server/db/dependency-reviews";
import {
  executeDependencyReviewJob,
  type DependencyReviewJobInput,
} from "../../../server/lib/dependency-review/job";
import {
  DEFAULT_DEPENDENCY_REVIEW_POLICY,
  type DependencyReviewPolicy,
} from "../../../server/lib/dependency-review/types";
import type { GithubAppEnv } from "../../../server/lib/github-app/config";
import { upsertInstallation } from "../../../server/lib/github-app/persistence";
import { githubWebhookRoutes } from "../../../server/routes/github-webhooks";
import type { QueueMessage } from "../../../server/lib/scan/job";
import type { Bindings } from "../../../server/types";
import { buildTestApp } from "./app";
import {
  computePublicDiffCacheKey,
  writePublicDiffCache,
  type PublicPackageDiff,
} from "../../../server/lib/public-diff";
import {
  summarizePackageJsonDiff,
  type PackageJsonSummary,
} from "../../../server/lib/review/serialize";
import type { GithubAppInstallationStatus } from "../../../server/db/enums";
import { seedUser } from "./seed";

const GITHUB_APP_ID = "12345";
const WEBHOOK_SECRET = "webhook-secret-value-1234567890";
const INSTALLATION_TOKEN = "ghs_dependency_review_install_token";
const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org";

let privateKeyPem: string | null = null;

// A real key: the job signs an App JWT before it exchanges it for the
// installation token, and a placeholder PEM fails at import.
function githubAppBindings(): GithubAppEnv {
  privateKeyPem ??= generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs1", format: "pem" })
    .toString();
  return {
    GITHUB_APP_ID,
    GITHUB_APP_SLUG: "drydock-test",
    GITHUB_APP_CLIENT_ID: "client-id",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_PRIVATE_KEY: privateKeyPem,
    GITHUB_APP_WEBHOOK_SECRET: WEBHOOK_SECRET,
    GITHUB_APP_STATE_SECRET: "0123456789abcdef0123456789abcdef",
    BETTER_AUTH_SECRET: "fallback-secret-with-enough-entropy-aaaaaaaa",
  };
}

export function sha(seed: string): string {
  return seed.repeat(40).slice(0, 40);
}

let installationCounter = 0;

// Installation ids are unique per call: the native rate limiter is an
// in-memory counter shared by every file on a pool worker.
export function uniqueInstallationId(): string {
  installationCounter += 1;
  return String(700_000 + Math.floor(Math.random() * 100_000) * 100 + installationCounter);
}

export interface SeedDependencyReviewOrgOptions {
  installationExternalId?: string;
  installationStatus?: GithubAppInstallationStatus;
  // `null` leaves the organization without a settings row (the off default).
  enabled?: boolean | null;
  policy?: Partial<DependencyReviewPolicy>;
  extraBotLogins?: string[];
}

export async function seedDependencyReviewOrg(options: SeedDependencyReviewOrgOptions = {}) {
  const owner = await seedUser();
  const db = createDb(env.DB);
  const installationExternalId = options.installationExternalId ?? uniqueInstallationId();
  const installation = await upsertInstallation(db, {
    organizationId: owner.organizationId,
    installationId: installationExternalId,
    accountLogin: "octo",
    accountType: "Organization",
    targetType: "Organization",
    status: options.installationStatus ?? "active",
    createdByUserId: null,
  });
  if (options.enabled !== null) {
    await saveDependencyReviewSettings(
      db,
      owner.organizationId,
      {
        enabled: options.enabled ?? true,
        policy: { ...DEFAULT_DEPENDENCY_REVIEW_POLICY, ...options.policy },
        extraBotLogins: options.extraBotLogins ?? [],
      },
      owner.userId,
    );
  }
  return { ...owner, db, installation, installationExternalId };
}

// ── Lockfile and diff fixtures ───────────────────────────────────────────────

// package-lock.json v3 whose root declares every entry, so each is direct.
export function npmLockfile(packages: Record<string, string>): string {
  const lock: Record<string, unknown> = {
    "": {
      name: "app",
      version: "1.0.0",
      dependencies: Object.fromEntries(Object.keys(packages).map((name) => [name, "*"])),
    },
  };
  for (const [name, version] of Object.entries(packages)) {
    lock[`node_modules/${name}`] = { version };
  }
  return JSON.stringify({ name: "app", lockfileVersion: 3, requires: true, packages: lock });
}

export interface NpmDiffFixture {
  name: string;
  from: string;
  to: string;
  fromPackageJson?: PackageJsonSummary;
  toPackageJson?: PackageJsonSummary;
  diff?: PublicPackageDiff["diff"];
  releaseRisk?: PublicPackageDiff["risk"]["releaseRisk"];
}

function npmDiffPayload(fixture: NpmDiffFixture): PublicPackageDiff {
  const fromPackageJson = fixture.fromPackageJson ?? { name: fixture.name, version: fixture.from };
  const toPackageJson = fixture.toPackageJson ?? { name: fixture.name, version: fixture.to };
  const releaseRisk = fixture.releaseRisk ?? "low";
  return {
    ecosystem: "npm",
    packageName: fixture.name,
    fromVersion: fixture.from,
    toVersion: fixture.to,
    fromPackageJson,
    toPackageJson,
    fromFiles: [],
    toFiles: [],
    diff: fixture.diff ?? [{ path: "index.js", status: "modified", flags: [] }],
    packageJsonDiff: summarizePackageJsonDiff(fromPackageJson, toPackageJson),
    findings: [],
    risk: {
      artifactRisk: releaseRisk,
      releaseRisk,
      contextRisk: "low",
      releaseFindingCount: 0,
      contextFindingCount: 0,
      unknownFindingCount: 0,
      priorApprovedContextFindingCount: 0,
    },
    cachedAt: new Date().toISOString(),
  };
}

// Pre-warms the public-diff cache so the job reads this evidence instead of
// downloading tarballs. Names must be unique per test: the colo cache outlives
// the per-file D1 reset.
export async function seedNpmDiff(fixture: NpmDiffFixture): Promise<void> {
  const key = await computePublicDiffCacheKey({
    ecosystem: "npm",
    registryUrl: PUBLIC_NPM_REGISTRY,
    packageName: fixture.name,
    fromVersion: fixture.from,
    toVersion: fixture.to,
  });
  await writePublicDiffCache(env, key, npmDiffPayload(fixture));
}

export function uniquePackageName(label: string): string {
  return `dr-${label}-${crypto.randomUUID().slice(0, 8)}`;
}

// ── GitHub REST double ───────────────────────────────────────────────────────

export interface FakePullRequest {
  owner: string;
  repo: string;
  number: number;
  state: string;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string;
  files: Array<{ filename: string; status: string; previous_filename?: string }>;
  // `${ref}:${path}` → raw file text; anything absent is a 404.
  contents: Map<string, string>;
  // login → GitHub permission; absent is a 404 (not a collaborator).
  permissions: Map<string, string>;
  // Status the files listing answers with instead of the listing.
  filesStatus?: number;
  // The PR's `changed_files`; defaults to the listing's length.
  changedFiles?: number;
  // The PR lookup answers 301 to this URL, as for a renamed repository.
  redirectTo?: string;
  // Commits that are the tip of a branch in the repository.
  branchHeads?: string[];
  // Called when a check run is created, before the response, to stage races.
  onCheckRunCreate?: (body: Record<string, unknown>) => Promise<void>;
}

interface RecordedRequest {
  method: string;
  url: string;
  host: string;
  authorization: string | null;
  redirect: RequestRedirect;
  body: unknown;
}

interface CheckRunWrite {
  id: number;
  body: Record<string, unknown>;
}

let checkRunCounter = 90_000;

export function fakePullRequest(overrides: Partial<FakePullRequest> = {}): FakePullRequest {
  return {
    owner: "octo",
    repo: "example",
    number: 42,
    state: "open",
    headSha: sha("b"),
    baseSha: sha("a"),
    mergeBaseSha: sha("c"),
    files: [{ filename: "package-lock.json", status: "modified" }],
    contents: new Map(),
    permissions: new Map(),
    ...overrides,
  };
}

/**
 * Replaces global fetch with a GitHub API double for one pull request. Public
 * registries answer 404 (an uncached diff reads as "not found"); every other
 * host is recorded in `unexpected` instead of throwing, because a thrown fetch
 * would surface only as a swallowed "diff failed".
 */
export function stubGithubApi(pr: FakePullRequest) {
  const requests: RecordedRequest[] = [];
  const unexpected: string[] = [];
  const checkRunCreates: CheckRunWrite[] = [];
  const checkRunUpdates: CheckRunWrite[] = [];
  const repoPrefix = `/repos/${pr.owner}/${pr.repo}`;

  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const text = request.method === "GET" ? "" : await request.text();
    const body = text ? (JSON.parse(text) as unknown) : null;
    requests.push({
      method: request.method,
      url: request.url,
      host: url.host,
      authorization: request.headers.get("authorization"),
      redirect: request.redirect,
      body,
    });

    if (url.host === "registry.npmjs.org" || url.host === "pypi.org") {
      return new Response("not found", { status: 404 });
    }
    if (url.host !== "api.github.com") {
      unexpected.push(request.url);
      return new Response("unexpected host", { status: 418 });
    }
    const path = url.pathname;
    if (/^\/app\/installations\/\d+\/access_tokens$/.test(path) && request.method === "POST") {
      return Response.json({ token: INSTALLATION_TOKEN, expires_at: "2099-01-01T00:00:00Z" });
    }
    if (path === `${repoPrefix}/pulls/${pr.number}`) {
      if (pr.redirectTo) {
        return new Response(null, { status: 301, headers: { Location: pr.redirectTo } });
      }
      return Response.json({
        number: pr.number,
        state: pr.state,
        user: { login: "dependabot[bot]", type: "Bot" },
        head: { sha: pr.headSha, repo: { id: 1 } },
        base: { sha: pr.baseSha },
        changed_files: pr.changedFiles ?? pr.files.length,
      });
    }
    if (path === `${repoPrefix}/pulls/${pr.number}/files`) {
      if (pr.filesStatus) return new Response("{}", { status: pr.filesStatus });
      return Response.json(pr.files);
    }
    if (path.startsWith(`${repoPrefix}/compare/`)) {
      return Response.json({ merge_base_commit: { sha: pr.mergeBaseSha } });
    }
    if (path.startsWith(`${repoPrefix}/contents/`)) {
      const filePath = path
        .slice(`${repoPrefix}/contents/`.length)
        .split("/")
        .map(decodeURIComponent)
        .join("/");
      const content = pr.contents.get(`${url.searchParams.get("ref")}:${filePath}`);
      return content === undefined
        ? new Response("not found", { status: 404 })
        : new Response(content, { status: 200 });
    }
    if (path === `${repoPrefix}/check-runs` && request.method === "POST") {
      checkRunCounter += 1;
      const id = checkRunCounter;
      checkRunCreates.push({ id, body: body as Record<string, unknown> });
      await pr.onCheckRunCreate?.(body as Record<string, unknown>);
      return Response.json({ id }, { status: 201 });
    }
    const headsMatch = path.match(
      new RegExp(`^${repoPrefix}/commits/([0-9a-f]{40})/branches-where-head$`),
    );
    if (headsMatch) {
      return Response.json(
        (pr.branchHeads ?? []).includes(headsMatch[1]) ? [{ name: "renovate/foo" }] : [],
      );
    }
    const listMatch = path.match(new RegExp(`^${repoPrefix}/commits/([0-9a-f]{40})/check-runs$`));
    if (listMatch && request.method === "GET") {
      // The newest run of the name on the commit, as `filter=latest` answers.
      const runs = checkRunCreates.filter(
        (run) =>
          run.body.head_sha === listMatch[1] &&
          run.body.name === url.searchParams.get("check_name"),
      );
      const newest = runs.at(-1);
      return Response.json({
        total_count: newest ? 1 : 0,
        check_runs: newest ? [{ id: newest.id, external_id: newest.body.external_id }] : [],
      });
    }
    const checkRunMatch = path.match(new RegExp(`^${repoPrefix}/check-runs/(\\d+)$`));
    if (checkRunMatch && request.method === "PATCH") {
      checkRunUpdates.push({
        id: Number(checkRunMatch[1]),
        body: body as Record<string, unknown>,
      });
      return Response.json({ id: Number(checkRunMatch[1]) });
    }
    const permissionMatch = path.match(
      new RegExp(`^${repoPrefix}/collaborators/([^/]+)/permission$`),
    );
    if (permissionMatch) {
      const permission = pr.permissions.get(decodeURIComponent(permissionMatch[1]));
      return permission
        ? Response.json({ permission })
        : new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    }
    unexpected.push(`${request.method} ${request.url}`);
    return new Response("unexpected path", { status: 418 });
  };

  vi.stubGlobal("fetch", vi.fn(handler));
  return {
    requests,
    unexpected,
    checkRunCreates,
    checkRunUpdates,
    // Every request that carries the installation token stays on the GitHub API host.
    tokenHosts: () =>
      [
        ...new Set(
          requests
            .filter((request) => request.authorization?.includes(INSTALLATION_TOKEN))
            .map((request) => request.host),
        ),
      ].sort(),
    lastCheckRunState: () => checkRunUpdates.at(-1)?.body ?? null,
  };
}

export type GithubApiDouble = ReturnType<typeof stubGithubApi>;

export function dependencyReviewJobEnv(overrides: Partial<Cloudflare.Env> = {}): Cloudflare.Env {
  return {
    ...env,
    ...githubAppBindings(),
    BETTER_AUTH_URL: "https://drydock.test",
    ...overrides,
  } as Cloudflare.Env;
}

export async function runDependencyReviewJob(
  input: DependencyReviewJobInput,
  overrides: Partial<Cloudflare.Env> = {},
): Promise<void> {
  const ctx = createExecutionContext();
  await executeDependencyReviewJob(dependencyReviewJobEnv(overrides), ctx, input, {
    finalAttempt: true,
  });
  await waitOnExecutionContext(ctx);
}

// ── Signed webhook deliveries ────────────────────────────────────────────────

async function signBody(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `sha256=${[...sig].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export interface WebhookDelivery {
  eventName: string;
  body: unknown;
  deliveryId?: string;
}

/**
 * Posts signed deliveries to the webhook route with a capturing SCAN_QUEUE,
 * so a suite can assert what each delivery enqueued.
 */
export function webhookHarness(envOverrides: Partial<Cloudflare.Env> = {}) {
  const sent: QueueMessage[] = [];
  const queue = {
    send: async (message: QueueMessage) => {
      sent.push(message);
    },
  };
  const app = buildTestApp((root) => root.route("/webhooks", githubWebhookRoutes), null);
  async function deliver(delivery: WebhookDelivery) {
    const rawBody =
      typeof delivery.body === "string" ? delivery.body : JSON.stringify(delivery.body);
    const ctx = createExecutionContext();
    const routeEnv = {
      ...env,
      ...githubAppBindings(),
      SCAN_QUEUE: queue,
      ...envOverrides,
    } as unknown as Bindings;
    const res = await app.fetch(
      new Request("http://test.local/webhooks/github", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": delivery.eventName,
          "x-github-delivery": delivery.deliveryId ?? crypto.randomUUID(),
          "x-hub-signature-256": await signBody(rawBody),
        },
        body: rawBody,
      }),
      routeEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return { res, json: (await res.json()) as Record<string, unknown> };
  }
  return { sent, deliver };
}

export interface PullRequestPayloadOptions {
  installationId: string;
  action?: string;
  repositoryId?: number;
  headRepositoryId?: number | null;
  pullNumber?: number;
  headSha?: string;
  authorLogin?: string;
  authorType?: string;
  senderLogin?: string;
}

export function pullRequestPayload(options: PullRequestPayloadOptions) {
  const repositoryId = options.repositoryId ?? 5151;
  const headRepositoryId =
    options.headRepositoryId === undefined ? repositoryId : options.headRepositoryId;
  return {
    action: options.action ?? "opened",
    number: options.pullNumber ?? 42,
    installation: { id: Number(options.installationId) },
    repository: { id: repositoryId, full_name: "octo/example" },
    pull_request: {
      number: options.pullNumber ?? 42,
      user: { login: options.authorLogin ?? "dependabot[bot]", type: options.authorType ?? "Bot" },
      head: {
        sha: options.headSha ?? sha("b"),
        repo: headRepositoryId === null ? null : { id: headRepositoryId },
      },
      base: { sha: sha("a") },
    },
    sender: { login: options.senderLogin ?? options.authorLogin ?? "dependabot[bot]" },
  };
}

export interface CheckRunPayloadOptions {
  installationId: string;
  checkRunId: number;
  action?: "requested_action" | "rerequested";
  appId?: number;
  repositoryId?: number;
  headSha?: string;
  identifier?: string;
  externalId?: string;
  sender?: { login: string; id: number };
}

export function checkRunPayload(options: CheckRunPayloadOptions) {
  const action = options.action ?? "requested_action";
  return {
    action,
    installation: { id: Number(options.installationId) },
    repository: { id: options.repositoryId ?? 5151, full_name: "octo/example" },
    check_run: {
      id: options.checkRunId,
      head_sha: options.headSha ?? sha("b"),
      app: { id: options.appId ?? Number(GITHUB_APP_ID) },
      ...(options.externalId ? { external_id: options.externalId } : {}),
    },
    ...(action === "requested_action"
      ? { requested_action: { identifier: options.identifier ?? "approve-holds" } }
      : {}),
    sender: options.sender ?? { login: "maintainer", id: 3141 },
  };
}
