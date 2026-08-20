import {
  ATPM_NO_BASELINE_VERSION,
  isAtpmStagedVersion,
} from "../../server/lib/ecosystems/atpm/stage-ref";
// pkg.pr.new (StackBlitz continuous releases) publishes npm-compatible preview
// tarballs for a commit or pull request. The public diff surface accepts these
// URLs as a version side so a preview build can be reviewed against a
// published release before it ships. Parsing is shared between the Worker
// (validation, egress allowlist) and the UI (input detection, labels), so this
// module must stay dependency-free and pure.

const PKG_PR_NEW_HOST = "pkg.pr.new";
const PKG_PR_NEW_ORIGIN = `https://${PKG_PR_NEW_HOST}`;

export interface PkgPrNewSpec {
  /** Normalized canonical URL (https, no query/hash/credentials). */
  url: string;
  /** npm package name embedded in the URL. */
  packageName: string;
  /** Commit sha or pull-request number after the trailing `@`. */
  ref: string;
  /** GitHub owner/repo, present only in the long URL form. */
  owner?: string;
  repo?: string;
}

// Accepted URL shapes (the last segment always carries `@ref`):
//   pkg.pr.new/<name>@<ref>                     (compact)
//   pkg.pr.new/@<scope>/<name>@<ref>            (compact, scoped)
//   pkg.pr.new/<owner>/<repo>/<name>@<ref>
//   pkg.pr.new/<owner>/<repo>/@<scope>/<name>@<ref>
const MAX_INPUT_LENGTH = 512;
// Mirrors NPM_PACKAGE_NAME_RE in server/lib/ecosystems/npm/registry.ts; kept local so the
// client bundle does not pull in registry fetch code.
const NAME_RE = /^[a-z0-9][a-z0-9._~-]*$/;
const SCOPE_RE = /^@[a-z0-9][a-z0-9._~-]*$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REPO_SEGMENT_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function parsePkgPrNewUrl(input: string): PkgPrNewSpec | null {
  const value = input.trim();
  if (!value || value.length > MAX_INPUT_LENGTH) return null;

  let url: URL;
  try {
    url = new URL(
      value.startsWith(`${PKG_PR_NEW_HOST}/`)
        ? `${PKG_PR_NEW_ORIGIN}${value.slice(PKG_PR_NEW_HOST.length)}`
        : value,
    );
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.hostname !== PKG_PR_NEW_HOST || url.port !== "") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.search !== "" || url.hash !== "") return null;

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 1 || segments.length > 4) return null;

  let owner: string | undefined;
  let repo: string | undefined;
  let nameSegments: string[];
  if (segments.length >= 3) {
    [owner, repo] = segments;
    if (!REPO_SEGMENT_RE.test(owner) || !REPO_SEGMENT_RE.test(repo)) return null;
    if (owner.startsWith("@") || owner === "." || owner === ".." || repo === "." || repo === "..")
      return null;
    nameSegments = segments.slice(2);
  } else {
    nameSegments = segments;
  }

  let scope: string | null = null;
  let last: string;
  if (nameSegments.length === 2) {
    [scope, last] = nameSegments;
    if (!SCOPE_RE.test(scope)) return null;
  } else if (nameSegments.length === 1) {
    last = nameSegments[0];
  } else {
    return null;
  }

  const at = last.lastIndexOf("@");
  if (at <= 0) return null;
  const baseName = last.slice(0, at);
  const ref = last.slice(at + 1);
  if (!NAME_RE.test(baseName) || !REF_RE.test(ref)) return null;

  const packageName = scope ? `${scope}/${baseName}` : baseName;
  if (packageName.length > 214) return null;

  return {
    url: `${PKG_PR_NEW_ORIGIN}/${segments.join("/")}`,
    packageName,
    ref,
    ...(owner && repo ? { owner, repo } : {}),
  };
}

export function isPkgPrNewUrl(input: string): boolean {
  return parsePkgPrNewUrl(input) !== null;
}

/**
 * Short human-readable label for a diff side: preview URLs render as
 * `pkg.pr.new@<ref>`, anything else (a registry version) is returned as-is.
 */
/**
 * How a version slot reads when it does not hold a version.
 *
 * Three things can sit there: a published version (shown as itself), a
 * pkg.pr.new preview URL, and — on atpm — a staged candidate or the sentinel a
 * first release uses on the left. The picker already synthesizes an option for
 * anything whose label differs from its raw value, so labelling these here is
 * all it takes for them to appear in it.
 */
export function diffRefLabel(value: string): string {
  const spec = parsePkgPrNewUrl(value);
  if (spec) return `${PKG_PR_NEW_HOST}@${spec.ref}`;
  if (value === ATPM_NO_BASELINE_VERSION) return "no published release";
  if (isAtpmStagedVersion(value)) return "staged candidate";
  return value;
}
