import { PublicDiffError } from "./public-diff-error";
import { parseSandboxErrorDetail } from "./sandbox";

// Single mapping from sandbox download failures to public-diff API errors so
// the npm and PyPI loaders return identical statuses and wording. Lives apart
// from public-diff-error.ts so that module stays free of the sandbox's
// `cloudflare:workers` import.
export function publicDiffDownloadError(err: unknown): PublicDiffError {
  const detail = parseSandboxErrorDetail(err);
  if (detail?.status === 413) {
    // "Too large" and "too many files" fail different limits and need
    // different remediation; folding them into one message sent numpy
    // troubleshooting down the wrong path (its sdist tripped the file-count
    // cap while every byte limit had headroom).
    if (detail.error === "archive contains too many files") {
      return new PublicDiffError("package has too many files to diff", 413);
    }
    return new PublicDiffError("package is too large to diff", 413);
  }
  return new PublicDiffError("package download failed", 502);
}
