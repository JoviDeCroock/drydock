import { PublicDiffError } from "./public-diff-error";
import { parseSandboxErrorDetail } from "./sandbox";

// Single mapping from sandbox download failures to public-diff API errors so
// the npm and PyPI loaders return identical statuses and wording. Lives apart
// from public-diff-error.ts so that module stays free of the sandbox's
// `cloudflare:workers` import.
export function publicDiffDownloadError(err: unknown): PublicDiffError {
  const detail = parseSandboxErrorDetail(err);
  if (detail?.status === 413) {
    return new PublicDiffError("package is too large to diff", 413);
  }
  return new PublicDiffError("package download failed", 502);
}
