/**
 * Every code a failed scan can be filed under. The union is the contract
 * between the job classifier, the adapter hooks that refine a failure, and the
 * persisted `error_json` the dashboard reads back.
 */
export type ScanErrorCode =
  | ScanPreconditionCode
  | "staged_release_published"
  | "staged_release_deleted"
  | "staged_release_blocked"
  | "sandbox_download_transient"
  | "sandbox_download_failed"
  | "archive_too_large"
  | "archive_too_many_files"
  | "archive_invalid"
  | "published_registry_unavailable"
  | "published_release_unreadable"
  | "scan_failed";

/** A classified scan failure with a message safe to persist and show. */
export interface SafeScanError {
  code: ScanErrorCode;
  message: string;
  retryable: boolean;
}

/**
 * Checks that fail before any release bytes are read: the organization's
 * credential or the queued scan's captured identity no longer supports the
 * review. None is retryable; the operator has to change something first.
 */
export type ScanPreconditionCode =
  | "npm_connection_missing"
  | "npm_connection_unvalidated"
  | "npm_connection_changed"
  | "npm_registry_identity_missing"
  | "staged_release_identity_changed"
  // Both reach the job as plain errors flattened across the Workers RPC
  // boundary. Neither is retryable: a candidate that disappeared or changed
  // will not come back by trying again, and classifying them as generic
  // failures retried each one three times behind an unhelpful message.
  | "staged_tarball_unavailable"
  | "staged_candidate_changed";

interface ScanPreconditionCopy {
  /** The thrown message; terse because it is also what the job log records. */
  thrown: string;
  /** The persisted message, which tells the reader what to do next. */
  safe: string;
}

const SCAN_PRECONDITIONS: Record<ScanPreconditionCode, ScanPreconditionCopy> = {
  npm_connection_missing: {
    thrown: "Connect an organization npm token before scanning staged publishes.",
    safe: "Connect an organization npm token before scanning staged publishes.",
  },
  npm_connection_unvalidated: {
    thrown: "Validate the organization npm token before scanning staged publishes.",
    safe: "Validate the organization npm token before scanning staged publishes.",
  },
  npm_connection_changed: {
    thrown: "The organization npm registry changed after this scan was queued.",
    safe: "The organization npm registry changed after this scan was queued. Run a new scan against the current connection.",
  },
  npm_registry_identity_missing: {
    thrown: "The queued scan is missing its captured npm registry.",
    safe: "This queued scan has no captured npm registry. Run a new scan against the current connection.",
  },
  staged_release_identity_changed: {
    thrown: "The staged release identity changed after this scan was queued.",
    safe: "The staged release identity changed after this scan was queued. Run a new scan from the current staged release.",
  },
  staged_tarball_unavailable: {
    thrown: "staged release not found",
    safe: "The staged candidate is no longer available for review.",
  },
  staged_candidate_changed: {
    thrown: "staged candidate changed after scan selection",
    safe: "The staged candidate changed before its review started.",
  },
};

export class ScanPreconditionError extends Error {
  readonly code: ScanPreconditionCode;
  readonly retryable = false;

  constructor(code: ScanPreconditionCode) {
    super(SCAN_PRECONDITIONS[code].thrown);
    this.name = "ScanPreconditionError";
    this.code = code;
  }

  toSafeScanError(): SafeScanError {
    return { code: this.code, message: SCAN_PRECONDITIONS[this.code].safe, retryable: false };
  }
}

/**
 * Recover a precondition failure from whatever reached the job.
 *
 * The npm broker runs as a `WorkerEntrypoint`, and Workers RPC flattens a
 * thrown error to its name and message on the way back, so `instanceof` only
 * holds for errors thrown on the orchestrator side. The flattened form is
 * matched on the exact thrown message, which this module owns.
 */
export function asScanPreconditionError(err: unknown): ScanPreconditionError | null {
  if (err instanceof ScanPreconditionError) return err;
  if (!err || typeof err !== "object") return null;
  const message = (err as { message?: unknown }).message;
  if (typeof message !== "string") return null;
  for (const code of Object.keys(SCAN_PRECONDITIONS) as ScanPreconditionCode[]) {
    if (SCAN_PRECONDITIONS[code].thrown === message) return new ScanPreconditionError(code);
  }
  return null;
}
