// Intent envelope: a deterministic classification of how strongly a reviewed
// artifact is bound to a source repository / release intent. Groundwork for a
// future "Release Contract" feature.
//
// The envelope is advisory metadata only. It must never change risk levels or
// findings — it describes what a claim about the artifact's origin could later
// be verified against (the "claim ceiling"):
//
//  - `attested` — the binding is machine-verified. The scan came through a
//    GitHub workflow gate: the signed `deployment_protection_rule` webhook
//    binds repository + workflow run + environment, and the reviewed artifact
//    bytes were downloaded from that run.
//  - `declared` — the staged manifest (package.json / PyPI metadata / VSIX
//    manifest) declares a parseable repository URL. The binding is claimed by
//    the package, not verified.
//  - `absent` — no repository binding at all.
//
// v1 constraint: a staged npm publish cannot reach `attested`. The staged
// registry metadata Drydock receives (`StagedPublishDetails`, populated from
// the staged publishes endpoints) exposes package identity, actor, and shasum —
// but no provenance attestation. If npm later surfaces provenance for staged
// versions, that signal can promote staged scans here without touching tiers.

import type { FileRecord } from "./review";
import { safeJson } from "./review/rules/helpers";

export type IntentEnvelopeTier = "attested" | "declared" | "absent";

export interface IntentEnvelopeSignal {
  kind: string;
  detail: string;
}

export interface IntentEnvelope {
  tier: IntentEnvelopeTier;
  /** Normalized https://github.com/owner/repo (or gitlab/…) when known. */
  repository: string | null;
  /** Human-readable evidence for the tier, in stable order. */
  signals: IntentEnvelopeSignal[];
}

/** Gate-bound release context, threaded from the workflow-gate job. */
export interface WorkflowGateIntent {
  repositoryFullName: string;
  runId: number | string;
  environment: string;
}

export interface IntentEnvelopeInput {
  /** Present only for scans reviewed through a GitHub workflow gate. */
  workflowGate?: WorkflowGateIntent | null;
  /** Raw manifest `repository` value (string, `{url}` object, shorthand, …). */
  declaredRepository?: unknown;
}

const INTENT_ENVELOPE_TIERS: ReadonlySet<string> = new Set(["attested", "declared", "absent"]);

// Hosts whose canonical repository identity is exactly `owner/repo`; extra
// path segments (tree/…, monorepo directories) are trimmed to that identity.
// GitLab is handled separately because nested groups are part of a project's
// canonical identity (`group/subgroup/project`).
const OWNER_REPO_HOSTS: ReadonlySet<string> = new Set(["github.com", "bitbucket.org"]);

const SHORTHAND_HOSTS: Record<string, string> = {
  github: "github.com",
  gitlab: "gitlab.com",
  bitbucket: "bitbucket.org",
};

const MAX_REPOSITORY_INPUT_LENGTH = 512;
// PyPI core-metadata header lines are short by construction (a label plus a
// URL); a multi-kilobyte "line" is only ever hostile padding. Bounding line
// length before any per-line regex runs keeps this parser linear even though
// `textSample` is the whole decoded metadata file, not a fixed-size head.
const MAX_METADATA_LINE_LENGTH = 2048;
const REPO_SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const BARE_OWNER_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_SIGNALS = 20;
const MAX_SIGNAL_TEXT_LENGTH = 512;

/**
 * Normalize a manifest `repository` declaration to a canonical https URL.
 * Handles the shapes npm/PyPI manifests carry in the wild: a plain string, a
 * `{ url }` object, `git+https://`/`git://`/`ssh://` schemes, scp-like
 * `git@host:owner/repo.git`, and `github:owner/repo` (plus bare `owner/repo`)
 * shorthands. Returns null for anything that does not parse.
 */
export function normalizeRepositoryUrl(raw: unknown): string | null {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    return normalizeRepositoryUrl((raw as { url?: unknown }).url);
  }
  if (typeof raw !== "string") return null;
  let value = raw.trim();
  if (!value || value.length > MAX_REPOSITORY_INPUT_LENGTH) return null;

  const shorthand = /^(github|gitlab|bitbucket):(.+)$/i.exec(value);
  if (shorthand) {
    return hostPathToUrl(SHORTHAND_HOSTS[shorthand[1].toLowerCase()], shorthand[2]);
  }
  // npm treats a bare `owner/repo` string as a GitHub shorthand.
  if (BARE_OWNER_REPO_RE.test(value)) return hostPathToUrl("github.com", value);

  if (value.startsWith("git+")) value = value.slice("git+".length);

  const scpLike = /^git@([A-Za-z0-9.-]+):(.+)$/.exec(value);
  if (scpLike) return hostPathToUrl(scpLike[1], scpLike[2]);

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (!["https:", "http:", "git:", "ssh:"].includes(parsed.protocol)) return null;
  return hostPathToUrl(parsed.hostname, parsed.pathname);
}

function hostPathToUrl(host: string, path: string): string | null {
  const normalizedHost = host.trim().toLowerCase();
  if (!normalizedHost || !normalizedHost.includes(".")) return null;
  let segments = path.replace(/^\/+/, "").replace(/\/+$/, "").split("/").filter(Boolean);
  if (OWNER_REPO_HOSTS.has(normalizedHost)) {
    segments = segments.slice(0, 2);
  } else if (normalizedHost === "gitlab.com") {
    // GitLab browser URLs put revision/file paths after `/-/`; everything
    // before that marker is the namespace + project identity.
    const browserSuffix = segments.indexOf("-");
    if (browserSuffix !== -1) segments = segments.slice(0, browserSuffix);
  }

  if (segments.length < 2) return null;
  segments[segments.length - 1] = segments.at(-1)!.replace(/\.git$/i, "");
  // GitLab and unknown hosts keep their full (sanitized) namespace path so
  // subgroup projects are not collapsed to the wrong repository.
  if (!segments.every((segment) => REPO_SEGMENT_RE.test(segment))) return null;
  return `https://${normalizedHost}/${segments.join("/")}`;
}

/**
 * Pull the raw repository declaration out of staged artifact evidence:
 * `repository` from the staged package.json text (npm, VSIX after payload
 * normalization), or Project-URL/Home-page headers from PyPI core metadata
 * (`PKG-INFO` / `*.dist-info/METADATA`) when no package.json is present.
 * Returns the raw declared value; callers normalize via
 * `normalizeRepositoryUrl`.
 */
export function extractDeclaredRepository(input: {
  manifestText: string | null;
  files: ReadonlyArray<Pick<FileRecord, "path" | "textSample">>;
}): unknown {
  const manifest = input.manifestText ? safeJson(input.manifestText) : null;
  if (manifest !== null && typeof manifest === "object" && !Array.isArray(manifest)) {
    const repository = (manifest as { repository?: unknown }).repository;
    if (repository !== undefined && repository !== null) return repository;
  }

  const metadataFile = input.files.find(
    (file) =>
      (file.path === "PKG-INFO" ||
        file.path.endsWith("/PKG-INFO") ||
        (file.path.endsWith("/METADATA") && file.path.includes(".dist-info"))) &&
      typeof file.textSample === "string",
  );
  if (metadataFile?.textSample) {
    return repositoryFromPyPiMetadata(metadataFile.textSample);
  }
  return null;
}

// Project-URL labels that conventionally point at the source repository, in
// preference order. Comparison is case-insensitive on the trimmed label.
const PYPI_REPOSITORY_LABELS = ["repository", "source", "source code", "code", "github"];

// Case-insensitive header-prefix match without regex backtracking. Returns the
// text after the header name (e.g. everything past `Project-URL:`), or null
// when the line is not that header. Callers trim the remainder themselves.
function matchHeader(line: string, header: string): string | null {
  if (line.length < header.length) return null;
  if (line.slice(0, header.length).toLowerCase() !== header.toLowerCase()) return null;
  return line.slice(header.length);
}

function repositoryFromPyPiMetadata(text: string): string | null {
  const projectUrls = new Map<string, string>();
  let homePage: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    // Core-metadata headers end at the first blank line; the description body
    // that follows is package-controlled prose and must not be scanned.
    if (line.trim() === "") break;
    // Hostile padding guard: a header line this long is never legitimate, and
    // skipping it keeps the parser bounded on adversarial metadata.
    if (line.length > MAX_METADATA_LINE_LENGTH) continue;
    const projectUrl = matchHeader(line, "Project-URL:");
    if (projectUrl !== null) {
      // Split on the first comma with `indexOf` rather than a regex: a pattern
      // that lets `\s*` and the label class both match spaces backtracks
      // quadratically on a comma-less padded line (ReDoS). `indexOf` is linear.
      const comma = projectUrl.indexOf(",");
      if (comma !== -1) {
        const label = projectUrl.slice(0, comma).trim().toLowerCase();
        const url = projectUrl.slice(comma + 1).trim();
        if (label && url) projectUrls.set(label, url);
      }
      continue;
    }
    const home = matchHeader(line, "Home-page:");
    if (home !== null && home.trim()) homePage = home.trim();
  }
  for (const label of PYPI_REPOSITORY_LABELS) {
    const url = projectUrls.get(label);
    if (url) return url;
  }
  return homePage;
}

/**
 * Pure tier computation. Advisory only: the result is persisted alongside the
 * scan and rendered in the report, and never feeds risk or findings.
 */
export function computeIntentEnvelope(input: IntentEnvelopeInput): IntentEnvelope {
  const declared = normalizeRepositoryUrl(input.declaredRepository);
  const gate = validWorkflowGateIntent(input.workflowGate);

  if (gate) {
    const gateRepository = normalizeRepositoryUrl(`https://github.com/${gate.repositoryFullName}`);
    const signals: IntentEnvelopeSignal[] = [
      {
        kind: "workflow-gate",
        detail: `repo ${gate.repositoryFullName}, run ${gate.runId}, environment ${gate.environment}`,
      },
    ];
    if (declared) {
      signals.push({ kind: "manifest-repository", detail: `manifest declares ${declared}` });
    }
    return { tier: "attested", repository: gateRepository ?? declared, signals };
  }

  // Staged publishes: no attestation signal exists in staged registry metadata
  // today (see the module comment), so the manifest declaration is the
  // strongest available binding.
  if (declared) {
    return {
      tier: "declared",
      repository: declared,
      signals: [
        {
          kind: "manifest-repository",
          detail: `manifest declares ${declared} — claimed by the package, not verified`,
        },
      ],
    };
  }

  return { tier: "absent", repository: null, signals: [] };
}

function validWorkflowGateIntent(value: WorkflowGateIntent | null | undefined) {
  if (!value) return null;
  const { repositoryFullName, runId, environment } = value;
  if (typeof repositoryFullName !== "string" || !repositoryFullName.trim()) return null;
  if (typeof environment !== "string" || !environment.trim()) return null;
  if (typeof runId !== "number" && typeof runId !== "string") return null;
  return { repositoryFullName: repositoryFullName.trim(), runId, environment: environment.trim() };
}

/**
 * Re-validate a persisted envelope from an untyped summary blob. Scans created
 * before this feature have no envelope; malformed data reads as null rather
 * than a partial envelope. Follows the `normalizeScanRiskBreakdown` pattern.
 */
export function normalizeIntentEnvelope(value: unknown): IntentEnvelope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Partial<Record<keyof IntentEnvelope, unknown>>;
  if (typeof item.tier !== "string" || !INTENT_ENVELOPE_TIERS.has(item.tier)) return null;
  const repository = normalizeRepositoryUrl(item.repository);
  const signals: IntentEnvelopeSignal[] = [];
  if (Array.isArray(item.signals)) {
    for (const signal of item.signals.slice(0, MAX_SIGNALS)) {
      if (!signal || typeof signal !== "object" || Array.isArray(signal)) continue;
      const { kind, detail } = signal as { kind?: unknown; detail?: unknown };
      if (typeof kind !== "string" || typeof detail !== "string") continue;
      signals.push({
        kind: kind.slice(0, MAX_SIGNAL_TEXT_LENGTH),
        detail: detail.slice(0, MAX_SIGNAL_TEXT_LENGTH),
      });
    }
  }

  // Do not let a persisted tier outlive the evidence that justified it. In
  // particular, an object containing only `{ tier: "attested" }` must not be
  // rendered or exported as a machine-verified source binding.
  if (item.tier === "attested") {
    if (
      !repository?.startsWith("https://github.com/") ||
      !signals.some((signal) => signal.kind === "workflow-gate" && signal.detail.trim())
    ) {
      return null;
    }
  } else if (item.tier === "declared") {
    if (
      !repository ||
      !signals.some((signal) => signal.kind === "manifest-repository" && signal.detail.trim())
    ) {
      return null;
    }
  } else if (repository || signals.length) {
    return null;
  }

  return { tier: item.tier as IntentEnvelopeTier, repository, signals };
}
