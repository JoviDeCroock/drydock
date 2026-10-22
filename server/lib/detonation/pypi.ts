import { isRecord } from "../platform/guards";
import type { PyPiDetonationFile } from "./types";

/**
 * PyPI side of the detonation sandbox: which reviewed distributions a run
 * executes, and how they travel to the harness.
 *
 * The container is Debian bookworm on linux/x86_64 (Cloudflare Containers),
 * whose `python3` is CPython 3.11. A wheel for any other interpreter or
 * platform would fail to install there, so selection happens here, before
 * any bytes are fetched, and a release with nothing that can run is skipped
 * rather than reported clean. `test/detonation-pypi.test.ts` pins this to the
 * image's base.
 */
export const DETONATION_PYTHON = { major: 3, minor: 11 } as const;

/** One reviewed distribution as the scan's provenance block records it. */
export interface PyPiProvenanceArtifact {
  path: string;
  kind: "wheel" | "sdist";
  sha256: string;
}

export interface PyPiDetonationSelection {
  /** The wheel pip would pick on the sandbox interpreter, or null when none fits. */
  wheel: PyPiProvenanceArtifact | null;
  /** The release's sdist, built with its own backend as a separate step. */
  sdist: PyPiProvenanceArtifact | null;
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_PROVENANCE_ARTIFACTS = 512;

/**
 * The reviewed wheel/sdist digests a completed PyPI gate scan persisted in
 * `summary.stagedPublish.provenance`. Written by trusted pipeline code, but
 * still narrowed field by field: a scan predating the block, or a malformed
 * one, has nothing to bind a run to.
 */
export function readPyPiProvenance(summaryJson: unknown): PyPiProvenanceArtifact[] | null {
  if (!isRecord(summaryJson) || !isRecord(summaryJson.stagedPublish)) return null;
  const provenance = summaryJson.stagedPublish.provenance;
  if (!isRecord(provenance) || provenance.ecosystem !== "pypi") return null;
  if (provenance.mode !== "workflow_gate" || !Array.isArray(provenance.artifacts)) return null;
  const artifacts: PyPiProvenanceArtifact[] = [];
  for (const entry of provenance.artifacts.slice(0, MAX_PROVENANCE_ARTIFACTS)) {
    if (!isRecord(entry)) return null;
    const { path, kind, sha256 } = entry;
    if (typeof path !== "string" || path.length === 0 || path.length > 512) return null;
    if (kind !== "wheel" && kind !== "sdist") return null;
    if (typeof sha256 !== "string" || !SHA256_RE.test(sha256)) return null;
    artifacts.push({ path, kind, sha256 });
  }
  return artifacts.length > 0 ? artifacts : null;
}

/** The bare filename of a bundle entry path, which is how the harness names it. */
export function distributionFilename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

interface WheelTags {
  python: string[];
  abi: string[];
  platform: string[];
}

// `{name}-{version}(-{build})?-{python}-{abi}-{platform}.whl` (PEP 427); the
// name and version are escaped so they never contain `-`.
const WHEEL_FILENAME_RE =
  /^[A-Za-z0-9_.]+-[A-Za-z0-9_.!+]+(?:-[0-9][A-Za-z0-9_.]*)?-([A-Za-z0-9_.]+)-([A-Za-z0-9_.]+)-([A-Za-z0-9_.]+)\.whl$/;

function parseWheelTags(filename: string): WheelTags | null {
  const match = WHEEL_FILENAME_RE.exec(filename);
  if (!match) return null;
  return {
    python: match[1].split("."),
    abi: match[2].split("."),
    platform: match[3].split("."),
  };
}

// Bookworm ships glibc 2.36, so any manylinux tag up to 2.36 installs.
const MANYLINUX_LEGACY = new Set([
  "manylinux1_x86_64",
  "manylinux2010_x86_64",
  "manylinux2014_x86_64",
]);
const MANYLINUX_RE = /^manylinux_2_(\d+)_x86_64$/;
const MAX_GLIBC_MINOR = 36;

function platformScore(tag: string): number {
  if (tag === "any") return 1;
  if (MANYLINUX_LEGACY.has(tag) || tag === "linux_x86_64") return 2;
  const glibc = MANYLINUX_RE.exec(tag);
  return glibc && Number(glibc[1]) <= MAX_GLIBC_MINOR ? 2 : 0;
}

/**
 * How specific a python/abi pair is for the sandbox interpreter, or 0 when it
 * cannot load there. Mirrors pip's preference: an exact CPython ABI over the
 * stable ABI over pure Python.
 */
function interpreterScore(python: string, abi: string): number {
  const { major, minor } = DETONATION_PYTHON;
  const exact = `cp${major}${minor}`;
  if (abi === exact) return python === exact ? 3 : 0;
  if (abi === "abi3") {
    const cpython = /^cp3(\d+)$/.exec(python);
    return cpython && Number(cpython[1]) <= minor ? 2 : 0;
  }
  if (abi !== "none") return 0;
  if (python === `py${major}` || python === exact) return 1;
  const pure = /^py3(\d+)$/.exec(python);
  return pure && Number(pure[1]) <= minor ? 1 : 0;
}

/** Best compatibility score of a wheel on the sandbox, 0 when it cannot install. */
export function wheelScore(filename: string): number {
  const tags = parseWheelTags(filename);
  if (!tags) return 0;
  let best = 0;
  for (const python of tags.python) {
    for (const abi of tags.abi) {
      const interpreter = interpreterScore(python, abi);
      if (interpreter === 0) continue;
      for (const platform of tags.platform) {
        const score = platformScore(platform);
        if (score > 0) best = Math.max(best, interpreter * 10 + score);
      }
    }
  }
  return best;
}

/**
 * The wheel pip would install on the sandbox, plus the sdist. A release can
 * ship dozens of platform wheels; only one of them can run in the container,
 * and a payload hidden in a wheel for another platform is not exercised (the
 * static review still reads every one).
 */
export function selectPyPiDetonationArtifacts(
  artifacts: readonly PyPiProvenanceArtifact[],
): PyPiDetonationSelection {
  let wheel: PyPiProvenanceArtifact | null = null;
  let wheelBest = 0;
  let sdist: PyPiProvenanceArtifact | null = null;
  const sorted = [...artifacts].sort((a, b) => a.path.localeCompare(b.path));
  for (const artifact of sorted) {
    if (artifact.kind === "sdist") {
      sdist ??= artifact;
      continue;
    }
    const score = wheelScore(distributionFilename(artifact.path));
    if (score > wheelBest) {
      wheel = artifact;
      wheelBest = score;
    }
  }
  return { wheel, sdist };
}

/**
 * Frames the distributions for POST /prepare-pypi: a 4-byte big-endian header
 * length, a JSON header naming each file, then the files' bytes in order.
 * `containers/detonation/pypi.mjs` decodes it and refuses anything that does
 * not add up exactly.
 */
export function encodePyPiPrepareBundle(
  files: readonly PyPiDetonationFile[],
): Uint8Array<ArrayBuffer> {
  const header = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      files: files.map((file) => ({
        name: file.name,
        kind: file.kind,
        size: file.bytes.byteLength,
      })),
    }),
  );
  const total = 4 + header.byteLength + files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  const out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, header.byteLength);
  out.set(header, 4);
  let offset = 4 + header.byteLength;
  for (const file of files) {
    out.set(file.bytes, offset);
    offset += file.bytes.byteLength;
  }
  return out;
}
