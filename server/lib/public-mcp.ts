import { createMcpHandler, McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { packageDiffPath, type DiffEcosystem } from "../../src/lib/package-diff-path";
import {
  publicReviewErrorResult as errorResult,
  publicReviewFileInput as fileInput,
  publicReviewInstructions,
  publicReviewPairInput as pairInput,
  publicReviewSuccessResult as successResult,
  publicReviewTools,
} from "../../src/lib/public-review-tools";
import { getPublicDiffAdapter } from "./ecosystems";
import { PublicPackageDiff, PublicPackageFile } from "./openapi/schemas";
import { isRecord } from "./platform/guards";
import { emitOperationalEvent } from "./platform/observability";

const pairOutput = PublicPackageDiff.extend({ reviewUrl: z.url() });

/** The callback dispatches only to the existing anonymous public-diff router. */
export function createPublicMcpHandler(
  invokePublicDiff: (path: string) => Promise<Response>,
  canonicalOrigin: string,
) {
  async function invoke(
    path: "/" | "/file",
    input: z.infer<typeof fileInput> | z.infer<typeof pairInput>,
  ): Promise<CallToolResult> {
    function unexpectedResult(
      status: number,
      reason: "backend-status" | "invalid-response" | "request-failed",
      retryAfterSeconds?: number,
    ): CallToolResult {
      emitOperationalEvent("error", "public_mcp.backend_failed", {
        operation: path === "/" ? publicReviewTools.compare.name : publicReviewTools.file.name,
        status,
        reason,
      });
      return errorResult(status, retryAfterSeconds);
    }
    const query = new URLSearchParams(input);
    try {
      const response = await invokePublicDiff(`${path}?${query}`);
      if (!response.ok) {
        const retryHeader = response.headers.get("retry-after");
        const retry =
          retryHeader !== null && /^\d+$/.test(retryHeader) ? Number(retryHeader) : undefined;
        const retryAfterSeconds = Number.isSafeInteger(retry) ? retry : undefined;
        if (response.status >= 500) {
          return unexpectedResult(response.status, "backend-status", retryAfterSeconds);
        }
        const payload: unknown = await response.json().catch(() => null);
        const message =
          isRecord(payload) && typeof payload.error === "string"
            ? payload.error.slice(0, 500)
            : "The public package review request could not be completed.";
        return errorResult(response.status, retryAfterSeconds, message);
      }
      const payload: unknown = await response.json().catch(() => null);
      if (!isRecord(payload)) return unexpectedResult(502, "invalid-response");
      if (path === "/file") {
        const parsed = PublicPackageFile.safeParse(payload);
        return parsed.success
          ? successResult({ ...payload, ...parsed.data })
          : unexpectedResult(502, "invalid-response");
      }
      const parsed = PublicPackageDiff.safeParse(payload);
      if (!parsed.success || !getPublicDiffAdapter(parsed.data.ecosystem)) {
        return unexpectedResult(502, "invalid-response");
      }
      const { ecosystem, packageName, fromVersion, toVersion } = parsed.data;
      return successResult({
        ...parsed.data,
        reviewUrl: new URL(
          packageDiffPath(ecosystem as DiffEcosystem, packageName, fromVersion, toVersion),
          canonicalOrigin,
        ).href,
      });
    } catch {
      return unexpectedResult(502, "request-failed");
    }
  }

  return createMcpHandler(
    () => {
      const server = new McpServer(
        { name: "drydock-public", version: "1.0.0" },
        {
          capabilities: { tools: { listChanged: false } },
          instructions: publicReviewInstructions,
        },
      );
      const { name: pairName, ...pairTool } = publicReviewTools.compare;
      server.registerTool(pairName, { ...pairTool, outputSchema: pairOutput }, (input) =>
        invoke("/", input),
      );
      const { name: fileName, ...fileTool } = publicReviewTools.file;
      server.registerTool(fileName, { ...fileTool, outputSchema: PublicPackageFile }, (input) =>
        invoke("/file", input),
      );
      return server;
    },
    { maxRequestBodySize: 16 * 1024, keepAliveMs: 0 },
  );
}
