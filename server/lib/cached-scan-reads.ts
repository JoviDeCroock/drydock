import { WorkerEntrypoint } from "cloudflare:workers";
import { createDb } from "../db/client";
import { getScan, getScanFile, getScanStatus } from "../db/scans";
import { reportExportFilename, serializeReportExport } from "./report-export";
import { scanArtifactReadBucket } from "./scan-artifacts";

const DETAIL_CACHE_MAX_AGE_SECONDS = 60;
const DETAIL_STALE_WHILE_REVALIDATE_SECONDS = 60 * 60;
const FILE_CACHE_MAX_AGE_SECONDS = 60 * 60 * 24;
const FILE_STALE_WHILE_REVALIDATE_SECONDS = 60 * 60 * 24 * 30;
const REPORT_CACHE_MAX_AGE_SECONDS = 60 * 5;
const REPORT_STALE_WHILE_REVALIDATE_SECONDS = 60 * 60;

interface CachedScanReadsProps {
  organizationId: string;
}

interface CachePurgeContext {
  purge?(options: {
    tags?: string[];
    pathPrefixes?: string[];
    purgeEverything?: boolean;
  }): Promise<unknown> | unknown;
}

type ScanDetail = Awaited<ReturnType<typeof getScan>>;

function cacheHeaders(scanId: string, maxAgeSeconds: number, staleWhileRevalidateSeconds: number) {
  return {
    "cache-control": `public, max-age=${maxAgeSeconds}, stale-while-revalidate=${staleWhileRevalidateSeconds}`,
    "cache-tag": `scan:${scanId}`,
  };
}

function noStoreHeaders() {
  return { "cache-control": "private, no-store" };
}

function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function notFoundResponse(message: string) {
  return jsonResponse({ error: message }, 404, noStoreHeaders());
}

function parseScanId(pathname: string) {
  const match = /^\/api\/v1\/scans\/([^/]+)(?:\/(file|report\.json))?$/.exec(pathname);
  return match ? { scanId: match[1], suffix: match[2] ?? null } : null;
}

function isCompletedScan(detail: ScanDetail) {
  return detail?.scan.status === "complete";
}

export class CachedScanReads extends WorkerEntrypoint<Cloudflare.Env, CachedScanReadsProps> {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET") {
      return jsonResponse({ error: "method not allowed" }, 405, noStoreHeaders());
    }

    const parsed = parseScanId(new URL(request.url).pathname);
    if (!parsed) return notFoundResponse("not found");

    const db = createDb(this.env.DB);
    const organizationId = this.ctx.props.organizationId;
    const bucket = scanArtifactReadBucket(this.env);

    switch (parsed.suffix) {
      case null: {
        const detail = await getScan(db, parsed.scanId, organizationId, bucket, {
          includeFileSamples: false,
        });
        if (!detail) return notFoundResponse("not found");
        if (!isCompletedScan(detail)) {
          return jsonResponse(detail, 200, noStoreHeaders());
        }
        return jsonResponse(
          detail,
          200,
          cacheHeaders(
            parsed.scanId,
            DETAIL_CACHE_MAX_AGE_SECONDS,
            DETAIL_STALE_WHILE_REVALIDATE_SECONDS,
          ),
        );
      }
      case "file": {
        const scan = await getScanStatus(db, parsed.scanId, organizationId);
        if (!scan) return notFoundResponse("file not found in scan");
        const path = new URL(request.url).searchParams.get("path") || "";
        if (!path) return jsonResponse({ error: "path is required" }, 400, noStoreHeaders());
        const file = await getScanFile(db, parsed.scanId, organizationId, path, bucket);
        if (!file) return jsonResponse({ error: "file not found in scan" }, 404, noStoreHeaders());
        if (scan.status !== "complete") return jsonResponse({ file }, 200, noStoreHeaders());
        return jsonResponse(
          { file },
          200,
          cacheHeaders(
            parsed.scanId,
            FILE_CACHE_MAX_AGE_SECONDS,
            FILE_STALE_WHILE_REVALIDATE_SECONDS,
          ),
        );
      }
      case "report.json": {
        const detail = await getScan(db, parsed.scanId, organizationId, bucket);
        if (!detail) return notFoundResponse("not found");
        if (!isCompletedScan(detail)) {
          return jsonResponse(
            { error: "report export is only available for completed scans" },
            409,
            noStoreHeaders(),
          );
        }
        return new Response(serializeReportExport(detail), {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "content-disposition": `attachment; filename="${reportExportFilename(detail.scan)}"`,
            ...cacheHeaders(
              parsed.scanId,
              REPORT_CACHE_MAX_AGE_SECONDS,
              REPORT_STALE_WHILE_REVALIDATE_SECONDS,
            ),
          },
        });
      }
      default:
        return notFoundResponse("not found");
    }
  }

  async invalidate(scanId: string) {
    const cache = (this.ctx as { cache?: CachePurgeContext }).cache;
    if (!cache?.purge) return;
    await cache.purge({ tags: [`scan:${scanId}`] });
  }
}
