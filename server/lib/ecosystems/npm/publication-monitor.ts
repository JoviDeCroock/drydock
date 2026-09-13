import { createHash } from "node:crypto";
import { and, asc, eq, isNull, lt, or } from "drizzle-orm";
import type { AppDb } from "../../../db/client";
import {
  getPublicationWatch,
  type PublicationObservation,
  type PublicationWatch,
} from "../../../db/publication-watches";
import { publicationObservations, publicationWatches, scans } from "../../../db/schema";
import { isRecord } from "../../platform/guards";
import { parseStagedArtifactIntegrity } from "../artifact-integrity";
import { parseNpmReleaseManifest } from "./manifest";
import { isPublishedTarballUrlAllowed } from "./published-tarball";
import {
  allowInsecureLocalRegistry,
  isLoopbackHostname,
  registryProtocolAllowed,
} from "./connection";
import { emitOperationalEvent } from "../../platform/observability";

const REGISTRY = "https://registry.npmjs.org";
const RELEASES_PER_CHECK = 3;
const METADATA_LIMIT = 4 * 1024 * 1024;
const TARBALL_LIMIT = 16 * 1024 * 1024;

type ReviewEvidence = Pick<
  typeof scans.$inferSelect,
  | "id"
  | "source"
  | "registryUrl"
  | "registryPackageName"
  | "registryVersion"
  | "packageName"
  | "stagedVersion"
  | "decision"
  | "decidedAt"
  | "summaryJson"
  | "status"
>;
type Verdict = Pick<PublicationObservation, "status" | "reason" | "scanId">;

function reviewDigest(
  scan: ReviewEvidence,
  name: string,
  version: string,
  registry: string,
): { algorithm: "sha1" | "sha256"; digest: string } | null {
  if (!isRecord(scan.summaryJson) || !isRecord(scan.summaryJson.stagedPublish)) return null;
  const details = scan.summaryJson.stagedPublish;
  if (scan.source === "workflow_gate") {
    try {
      const manifest = parseNpmReleaseManifest(details.manifest);
      if (
        details.mode !== "workflow_gate" ||
        manifest.package !== name ||
        manifest.version !== version ||
        manifest.artifacts.length !== 1
      )
        return null;
      const artifact = manifest.artifacts[0]!;
      if (typeof details.digest !== "string" || details.digest.toLowerCase() !== artifact.sha256)
        return null;
      return { algorithm: "sha256", digest: artifact.sha256 };
    } catch {
      return null;
    }
  }
  if (
    scan.registryUrl?.replace(/\/$/, "") !== registry ||
    scan.registryPackageName !== name ||
    scan.registryVersion !== version
  )
    return null;
  const integrity = parseStagedArtifactIntegrity(details.artifactIntegrity);
  return integrity?.status === "verified" && integrity.computed
    ? { algorithm: "sha1", digest: integrity.computed }
    : null;
}

export function classifyPublication(
  name: string,
  version: string,
  publishedAt: Date | null,
  digests: { sha1: string; sha256: string } | null,
  reviews: readonly ReviewEvidence[],
  registry = REGISTRY,
): Verdict {
  if (!publishedAt)
    return { status: "unknown", reason: "publication_time_unavailable", scanId: null };
  if (!digests) return { status: "unknown", reason: "artifact_unavailable", scanId: null };
  const prior = reviews
    .filter(
      (scan) =>
        scan.packageName === name &&
        scan.stagedVersion === version &&
        scan.decidedAt &&
        scan.decidedAt < publishedAt &&
        (scan.source === "workflow_gate" ||
          (scan.registryUrl?.replace(/\/$/, "") === registry &&
            scan.registryPackageName === name &&
            scan.registryVersion === version)),
    )
    .sort((a, b) => b.decidedAt!.getTime() - a.decidedAt!.getTime());
  let missingEvidence = false;
  let mismatched: string | null = null;
  for (const scan of prior) {
    if (scan.decision !== "publish" && scan.decision !== "no_publish") continue;
    const evidence = reviewDigest(scan, name, version, registry);
    if (!evidence || scan.status !== "complete") {
      missingEvidence = true;
      continue;
    }
    if (digests[evidence.algorithm] === evidence.digest)
      return {
        status: scan.decision === "publish" ? "approved_match" : "published_despite_rejection",
        reason: null,
        scanId: scan.id,
      };
    if (scan.decision === "publish") mismatched ??= scan.id;
  }
  if (
    reviews.some(
      (scan) =>
        scan.packageName === name &&
        scan.stagedVersion === version &&
        scan.decidedAt &&
        scan.decidedAt >= publishedAt &&
        (scan.source === "workflow_gate" ||
          (scan.registryUrl?.replace(/\/$/, "") === registry &&
            scan.registryPackageName === name &&
            scan.registryVersion === version)),
    )
  ) {
    return { status: "unknown", reason: "decision_history_unavailable", scanId: null };
  }
  if (missingEvidence)
    return { status: "unknown", reason: "review_digest_unavailable", scanId: null };
  if (mismatched) return { status: "artifact_mismatch", reason: null, scanId: mismatched };
  return { status: "published_without_approval", reason: null, scanId: null };
}

async function consumePublicResponse(
  url: string,
  maxBytes: number,
  consume: (chunk: Uint8Array) => void,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(url, {
      redirect: "manual",
      signal: controller.signal,
      headers: { Accept: "application/json, application/octet-stream" },
    });
    if (!response.ok || !response.body || Number(response.headers.get("content-length")) > maxBytes)
      throw new Error("public_evidence_unavailable");
    reader = response.body.getReader();
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new Error("public_evidence_too_large");
      consume(chunk.value);
    }
  } finally {
    clearTimeout(timeout);
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
    controller.abort();
  }
}

async function fetchMetadata(name: string, registry: string): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  await consumePublicResponse(
    `${registry}/${encodeURIComponent(name).replace(/^%40/, "@")}`,
    METADATA_LIMIT,
    (chunk) => {
      chunks.push(chunk);
      size += chunk.byteLength;
    },
  );
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const data: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!isRecord(data) || data.name !== name || !isRecord(data.versions))
    throw new Error("invalid_package_metadata");
  return data;
}

async function hashPublishedArtifact(
  value: unknown,
  name: string,
  version: string,
  registry: string,
) {
  if (
    !isRecord(value) ||
    value.name !== name ||
    value.version !== version ||
    !isRecord(value.dist) ||
    typeof value.dist.tarball !== "string"
  )
    return null;
  const url = new URL(value.dist.tarball);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !isPublishedTarballUrlAllowed(url.href, registry, registry !== REGISTRY)
  )
    return null;
  const sha1 = createHash("sha1");
  const sha256 = createHash("sha256");
  await consumePublicResponse(url.href, TARBALL_LIMIT, (chunk) => {
    sha1.update(chunk);
    sha256.update(chunk);
  });
  return { sha1: sha1.digest("hex"), sha256: sha256.digest("hex") };
}

export async function checkNpmPublicationWatch(
  db: AppDb,
  env: Cloudflare.Env,
  watch: PublicationWatch,
) {
  let registry = REGISTRY;
  if (allowInsecureLocalRegistry(env)) {
    try {
      const local = new URL(env.NPM_REGISTRY);
      if (
        isLoopbackHostname(local.hostname) &&
        registryProtocolAllowed(local, { allowInsecureLocalhost: true }) &&
        !local.username &&
        !local.password &&
        !local.search &&
        !local.hash &&
        local.pathname === "/"
      )
        registry = local.origin;
    } catch {}
  }
  const now = new Date();
  // A lease also makes manual checks and overlapping cron invocations share the bound.
  const claimed = await db
    .update(publicationWatches)
    .set({ lastCheckedAt: now })
    .where(
      and(
        eq(publicationWatches.id, watch.id),
        eq(publicationWatches.organizationId, watch.organizationId),
        or(
          isNull(publicationWatches.lastCheckedAt),
          lt(publicationWatches.lastCheckedAt, new Date(now.getTime() - 60_000)),
        ),
      ),
    )
    .returning({ id: publicationWatches.id });
  if (!claimed.length) return getPublicationWatch(db, watch.organizationId, watch.id);
  let lastError: string | null = null;
  let historyLimit = false;
  try {
    const metadata = await fetchMetadata(watch.packageName, registry);
    const versions = isRecord(metadata.versions) ? metadata.versions : {};
    const times = isRecord(metadata.time) ? metadata.time : {};
    const observed = await db
      .select({
        id: publicationObservations.id,
        version: publicationObservations.version,
        status: publicationObservations.status,
        firstSeenAt: publicationObservations.firstSeenAt,
        checkedAt: publicationObservations.checkedAt,
      })
      .from(publicationObservations)
      .where(
        and(
          eq(publicationObservations.watchId, watch.id),
          eq(publicationObservations.organizationId, watch.organizationId),
        ),
      )
      .limit(10_001);
    if (observed.length > 10_000 || Object.keys(versions).length > 10_000) {
      historyLimit = true;
      throw new Error("publication_history_limit");
    }
    const existing = new Map(observed.map((item) => [item.version, item]));
    const pending: {
      version: string;
      publishedAt: Date | null;
      previous?: Pick<
        PublicationObservation,
        "id" | "version" | "status" | "firstSeenAt" | "checkedAt"
      >;
    }[] = [];
    for (const version of Object.keys(versions)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(version)) {
        lastError = "invalid_version_metadata";
        continue;
      }
      const rawTime = times[version];
      const millis = typeof rawTime === "string" ? Date.parse(rawTime) : NaN;
      const publishedAt = Number.isFinite(millis) && millis <= Date.now() ? new Date(millis) : null;
      if (publishedAt && publishedAt < watch.createdAt) continue;
      const previous = existing.get(version);
      if (previous && previous.status !== "unknown") continue;
      pending.push({ version, publishedAt, previous });
    }
    pending.sort(
      (a, b) =>
        (a.previous?.checkedAt.getTime() ?? 0) - (b.previous?.checkedAt.getTime() ?? 0) ||
        (a.publishedAt?.getTime() ?? 0) - (b.publishedAt?.getTime() ?? 0) ||
        a.version.localeCompare(b.version),
    );
    if (pending.length > RELEASES_PER_CHECK) lastError = "pending_release_backlog";
    for (const item of pending.slice(0, RELEASES_PER_CHECK)) {
      let digests: { sha1: string; sha256: string } | null = null;
      if (item.publishedAt) {
        try {
          digests = await hashPublishedArtifact(
            versions[item.version],
            watch.packageName,
            item.version,
            registry,
          );
        } catch {}
      }
      const reviews = await db
        .select()
        .from(scans)
        .where(
          and(
            eq(scans.organizationId, watch.organizationId),
            eq(scans.packageName, watch.packageName),
            eq(scans.stagedVersion, item.version),
          ),
        )
        .limit(101);
      const verdict: Verdict =
        reviews.length > 100
          ? { status: "unknown", reason: "review_history_limit", scanId: null }
          : classifyPublication(
              watch.packageName,
              item.version,
              item.publishedAt,
              digests,
              reviews,
              registry,
            );
      const values = {
        id: item.previous?.id ?? crypto.randomUUID(),
        watchId: watch.id,
        organizationId: watch.organizationId,
        version: item.version,
        publishedAt: item.publishedAt,
        firstSeenAt: item.previous?.firstSeenAt ?? now,
        checkedAt: now,
        ...verdict,
        sha1: digests?.sha1 ?? null,
        sha256: digests?.sha256 ?? null,
      };
      await db
        .insert(publicationObservations)
        .values(values)
        .onConflictDoUpdate({
          target: [publicationObservations.watchId, publicationObservations.version],
          set: {
            publishedAt: values.publishedAt,
            checkedAt: now,
            ...verdict,
            sha1: values.sha1,
            sha256: values.sha256,
          },
          setWhere: eq(publicationObservations.status, "unknown"),
        });
    }
  } catch {
    lastError = historyLimit ? "publication_history_limit" : "registry_evidence_unavailable";
    emitOperationalEvent("warn", "npm.publication_monitor.check_failed", {
      organizationId: watch.organizationId,
      watchId: watch.id,
    });
  }
  await db
    .update(publicationWatches)
    .set({ lastError })
    .where(
      and(
        eq(publicationWatches.id, watch.id),
        eq(publicationWatches.organizationId, watch.organizationId),
      ),
    );
  return getPublicationWatch(db, watch.organizationId, watch.id);
}

export async function sweepNpmPublicationWatches(db: AppDb, env: Cloudflare.Env) {
  const watches = await db
    .select()
    .from(publicationWatches)
    .where(
      or(
        isNull(publicationWatches.lastCheckedAt),
        lt(publicationWatches.lastCheckedAt, new Date(Date.now() - 5 * 60_000)),
      ),
    )
    .orderBy(asc(publicationWatches.lastCheckedAt), asc(publicationWatches.id))
    .limit(8);
  for (const watch of watches) await checkNpmPublicationWatch(db, env, watch);
}
