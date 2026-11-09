// Differential harness: the entry set Drydock reviews vs. the entry set each
// real consumer installs from the same archive bytes.
//
// Every consumer here only *lists* what it would install. node-tar runs as a
// Parser with an in-memory model of the Unpack steps pacote uses, yauzl runs
// over a buffer with VS Code's extract rules, and CPython runs
// cpython-archive-consumer.py, which hashes member bytes without extracting.
// Nothing is written to disk except the archive files handed to Python, and
// nothing in an archive is executed.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Parser } from "tar";
import yauzl from "yauzl";
import { preparePyPiArtifact } from "../../server/lib/ecosystems/pypi/acquire";
import { normalizeVsixFiles } from "../../server/lib/ecosystems/vscode/manifest";
import {
  boundedByteStream,
  readTarStream,
  readZipArchiveBuffered,
  readZipStream,
} from "../../server/lib/tar-parser.js";

// The sandbox's production caps (server/lib/sandbox.ts SANDBOX_*), restated
// because sandbox.ts imports `cloudflare:workers`.
const MAX_FILES = 2_500;
const MAX_TAR_BYTES = 25 * 1024 * 1024;
const MAX_STREAM_BYTES = 10 * MAX_TAR_BYTES;
const MAX_ENTRIES = 20_000;

// --- Drydock ---------------------------------------------------------------

function failClosed(error) {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

// The sandbox's tgz path: wire cap, gzip DecompressionStream, readTarStream.
// Node's DecompressionStream stands in for workerd's here.
async function drydockTar(gzBytes, rootStrip) {
  try {
    const body = boundedByteStream(new Response(gzBytes).body, MAX_STREAM_BYTES).pipeThrough(
      new DecompressionStream("gzip"),
    );
    const parsed = await readTarStream(
      body,
      MAX_FILES,
      MAX_TAR_BYTES,
      MAX_STREAM_BYTES,
      MAX_ENTRIES,
      0,
      rootStrip,
    );
    return { ok: true, files: parsed.files, suspicious: parsed.suspicious };
  } catch (error) {
    return failClosed(error);
  }
}

// pacote renames `.gitignore` to `.npmignore` unless one was already seen. It
// moves no executable bytes, so Drydock's paths get the same rename before
// comparison instead of every fixture carrying the difference.
function pacoteIgnoreRename(files) {
  const seen = new Set();
  const out = [];
  for (const file of files) {
    const base = path.posix.basename(file.path);
    if (base === ".npmignore") seen.add(file.path);
    if (base === ".gitignore") {
      const renamed = file.path.replace(/\.gitignore$/, ".npmignore");
      if (seen.has(renamed)) continue;
      out.push({ ...file, path: renamed });
      continue;
    }
    out.push(file);
  }
  return out;
}

export async function drydockNpm(gzBytes) {
  const result = await drydockTar(gzBytes, "strip1");
  return result.ok ? { ...result, files: pacoteIgnoreRename(result.files) } : result;
}

// The sdist parse keeps the archive root; the PyPI adapter strips the common
// root afterwards, so the reviewed view is preparePyPiArtifact's.
export async function drydockSdist(gzBytes) {
  const result = await drydockTar(gzBytes, "keep");
  if (!result.ok) return result;
  const prepared = preparePyPiArtifact({
    path: "dist/demo_package-1.0.0.tar.gz",
    files: result.files,
    suspiciousEntries: result.suspicious,
  });
  return { ok: true, files: prepared.files, suspicious: prepared.suspiciousEntries ?? [] };
}

export async function drydockWheel(zipBytes) {
  try {
    const parsed = await readZipStream(
      new Response(zipBytes).body,
      MAX_FILES,
      MAX_TAR_BYTES,
      MAX_STREAM_BYTES,
      MAX_ENTRIES,
      0,
    );
    return { ok: true, files: parsed.files, suspicious: parsed.suspicious };
  } catch (error) {
    return failClosed(error);
  }
}

// The reviewed view is the VS Code adapter's: normalizeVsixFiles maps paths
// the way VS Code's extractor does, and parseVscodeExtensionManifest refuses a
// mapped path two entries share. VS Code also writes the root
// `extension.vsixmanifest` as `.vsixmanifest`, which the adapter keeps out of
// the payload, so it is aliased here rather than reported each time.
export async function drydockVsix(zipBytes) {
  try {
    const parsed = await readZipArchiveBuffered(zipBytes, MAX_FILES, MAX_TAR_BYTES, MAX_ENTRIES, 0);
    const files = normalizeVsixFiles(parsed.files);
    const seen = new Set();
    for (const file of files) {
      if (seen.has(file.path))
        throw new Error(`VSIX artifact contains duplicate path ${file.path}`);
      seen.add(file.path);
    }
    const manifest = parsed.files.findLast((file) => file.path === "extension.vsixmanifest");
    if (manifest) files.push({ ...manifest, path: ".vsixmanifest" });
    return { ok: true, files, suspicious: parsed.suspicious };
  } catch (error) {
    return failClosed(error);
  }
}

// --- npm: node-tar as pacote drives it --------------------------------------

const NPM_CWD = "/npm-install-root";

// node-tar's strip-absolute-path.js (win32 parse on every platform, so a
// leading `C:` is a root too).
function stripAbsolutePath(input) {
  let value = input;
  let root = "";
  let parsed = path.win32.parse(value);
  while (path.win32.isAbsolute(value) || parsed.root) {
    const next = value.charAt(0) === "/" && value.slice(0, 4) !== "//?/" ? "/" : parsed.root;
    value = value.slice(next.length);
    root += next;
    parsed = path.win32.parse(value);
  }
  return [root, value];
}

// Unpack's [CHECKPATH] with pacote's options (strip 1, preservePaths off):
// returns the absolute target, or null when node-tar skips the entry.
function npmTargetPath(entry) {
  const parts = entry.path.split("/");
  parts.splice(0, 1);
  if (parts.length > 1024) return null;
  let entryPath = parts.join("/");
  if (entryPath) {
    const [root, stripped] = stripAbsolutePath(entryPath);
    if (stripped.replaceAll("\\", "/").split("/").includes("..")) return null;
    if (root) entryPath = stripped;
  }
  const absolute = path.posix.resolve(NPM_CWD, entryPath);
  if (absolute !== NPM_CWD && !absolute.startsWith(NPM_CWD + "/")) return null;
  if (absolute === NPM_CWD) return null;
  return absolute;
}

// In-memory extraction tree: absolute path -> { type: "dir" } | { type: "file", sha256 }.
function writeTreeFile(tree, root, absolute, digest) {
  const relativeParts = absolute.slice(root.length + 1).split("/");
  let current = root;
  for (const part of relativeParts.slice(0, -1)) {
    current = `${current}/${part}`;
    const node = tree.get(current);
    if (!node) tree.set(current, { type: "dir" });
    else if (node.type !== "dir") return false; // mkdir over a file: entry error
  }
  const existing = tree.get(absolute);
  // A directory node here always has children (dirs only exist as parents), so
  // the rmdir node-tar attempts fails and the entry is skipped.
  if (existing?.type === "dir") return false;
  tree.set(absolute, { type: "file", sha256: digest });
  return true;
}

function treeEntries(tree, root) {
  const entries = new Map();
  for (const [absolute, node] of tree) {
    if (node.type === "dir") continue;
    entries.set(absolute.slice(root.length + 1), node);
  }
  return entries;
}

export function npmInstall(gzBytes) {
  return new Promise((resolve) => {
    const tree = new Map();
    const sawIgnores = new Set();
    let fatal = null;
    const parser = new Parser({
      // pacote's #tarxOptions filter: links are dropped, directories are
      // implied by their files, `.gitignore` becomes `.npmignore`.
      filter: (_name, entry) => {
        if (entry.type.endsWith("Link")) return false;
        if (entry.type.endsWith("File")) {
          const base = path.posix.basename(entry.path);
          if (base === ".npmignore") {
            sawIgnores.add(entry.path);
          } else if (base === ".gitignore") {
            const renamed = entry.path.replace(/\.gitignore$/, ".npmignore");
            if (sawIgnores.has(renamed)) return false;
            entry.path = renamed;
          }
          return true;
        }
        return false;
      },
      // Unpack turns these two into errors; npm then fails the install.
      onwarn: (code, message) => {
        if (code === "TAR_BAD_ARCHIVE" || code === "TAR_ABORT") fatal ??= `${code}: ${message}`;
      },
    });
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve(
        fatal ? { ok: false, error: fatal } : { ok: true, entries: treeEntries(tree, NPM_CWD) },
      );
    };
    // A zlib failure (bytes after the gzip stream, a corrupt member) aborts
    // the Parser without a `close`; pacote rejects on that `error`.
    parser.on("error", (error) => {
      fatal ??= error.message;
      settle();
    });
    parser.on("abort", (error) => {
      fatal ??= `TAR_ABORT: ${error?.message ?? "aborted"}`;
      settle();
    });
    parser.on("entry", (entry) => {
      const absolute = npmTargetPath(entry);
      const supported =
        entry.type === "File" || entry.type === "OldFile" || entry.type === "ContiguousFile";
      if (!absolute || !supported) {
        entry.resume();
        return;
      }
      const hash = createHash("sha256");
      entry.on("data", (chunk) => hash.update(chunk));
      entry.on("end", () => writeTreeFile(tree, NPM_CWD, absolute, hash.digest("hex")));
    });
    parser.on("close", settle);
    parser.end(Buffer.from(gzBytes));
  });
}

// --- VS Code: yauzl as VS Code's vs/base/node/zip extractor drives it ---------------------

const VSCODE_TARGET = "/vscode-extension-root";
// `extract(zip, dir, { sourcePath: 'extension' })` builds `^extension` with no
// trailing slash, and strips it with String#replace.
const VSCODE_SOURCE = /^extension/;

export function vscodeInstall(zipBytes) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    yauzl.fromBuffer(Buffer.from(zipBytes), { lazyEntries: true }, (openError, zipfile) => {
      if (openError) return finish({ ok: false, error: openError.message });
      const tree = new Map();
      zipfile.on("error", (error) => finish({ ok: false, error: error.message }));
      zipfile.on("end", () => finish({ ok: true, entries: treeEntries(tree, VSCODE_TARGET) }));
      zipfile.on("entry", (entry) => {
        if (!VSCODE_SOURCE.test(entry.fileName)) return zipfile.readEntry();
        const fileName = entry.fileName.replace(VSCODE_SOURCE, "");
        if (fileName.endsWith("/")) {
          const dir = path.posix.join(VSCODE_TARGET, fileName).replace(/\/$/, "");
          let current = VSCODE_TARGET;
          for (const part of dir
            .slice(VSCODE_TARGET.length + 1)
            .split("/")
            .filter(Boolean)) {
            current = `${current}/${part}`;
            const node = tree.get(current);
            if (node && node.type !== "dir")
              return finish({ ok: false, error: "mkdir over a file" });
            tree.set(current, { type: "dir" });
          }
          return zipfile.readEntry();
        }
        const targetDir = path.posix.join(VSCODE_TARGET, path.posix.dirname(fileName));
        if (!targetDir.startsWith(VSCODE_TARGET)) {
          return finish({ ok: false, error: "invalid file" });
        }
        const target = path.posix.join(VSCODE_TARGET, fileName);
        zipfile.openReadStream(entry, (streamError, stream) => {
          if (streamError) return finish({ ok: false, error: streamError.message });
          const hash = createHash("sha256");
          stream.on("data", (chunk) => hash.update(chunk));
          stream.on("error", (error) => finish({ ok: false, error: error.message }));
          stream.on("end", () => {
            // createWriteStream on the extension root or a directory fails the
            // install, as does a parent that is a file.
            if (
              target === VSCODE_TARGET ||
              !writeTreeFile(tree, VSCODE_TARGET, target, hash.digest("hex"))
            ) {
              return finish({ ok: false, error: "cannot write entry" });
            }
            zipfile.readEntry();
          });
        });
      });
      zipfile.readEntry();
    });
  });
}

// --- CPython: pip's tarfile/zipfile reads ------------------------------------

const PYTHON_SCRIPT = fileURLToPath(new URL("./cpython-archive-consumer.py", import.meta.url));

function probePython(command) {
  const probe = spawnSync(
    command,
    ["-I", "-c", "import sys; print('%d.%d.%d' % sys.version_info[:3])"],
    {
      encoding: "utf8",
    },
  );
  if (probe.status !== 0) return null;
  const version = probe.stdout.trim();
  const [major, minor] = version.split(".").map(Number);
  return major === 3 ? { command, version, major, minor, supported: minor >= 12 } : null;
}

let pythonCache;
// The first interpreter found, overridable with DRYDOCK_DIFFERENTIAL_PYTHON.
// Only 3.12+ is `supported`: older ones lack `tarfile.data_filter` (pip's
// sdist path) and the zip Unicode Path field, so they would model another pip.
export function findPython() {
  if (pythonCache !== undefined) return pythonCache;
  const candidates = [
    process.env.DRYDOCK_DIFFERENTIAL_PYTHON,
    "/opt/homebrew/bin/python3.13",
    "python3.13",
    "python3",
  ].filter(Boolean);
  pythonCache = null;
  for (const candidate of candidates) {
    const found = probePython(candidate);
    if (found) {
      pythonCache = found;
      break;
    }
  }
  return pythonCache;
}

// One interpreter for a whole batch: `jobs` is `[{ kind: "sdist"|"wheel", bytes }]`.
export function pipInstallBatch(jobs) {
  const python = findPython();
  if (!python?.supported) throw new Error("no Python 3.12+ interpreter found");
  const dir = mkdtempSync(path.join(tmpdir(), "drydock-differential-"));
  try {
    const listed = jobs.map((job, index) => {
      const file = path.join(dir, `${index}.${job.kind === "sdist" ? "tar.gz" : "whl"}`);
      writeFileSync(file, job.bytes);
      return { kind: job.kind, path: file };
    });
    const run = spawnSync(python.command, ["-I", PYTHON_SCRIPT], {
      cwd: dir,
      input: JSON.stringify(listed),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (run.status !== 0) throw new Error(`cpython consumer failed: ${run.stderr.slice(0, 2000)}`);
    const { results } = JSON.parse(run.stdout);
    return results.map((result) =>
      result.ok
        ? { ok: true, entries: new Map(result.entries.map((entry) => [entry.path, entry])) }
        : result,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- agreement ---------------------------------------------------------------

// Disclosures that tell the reviewer the installed set depends on the reader.
// A directory record (`typeflag 5`) is info-level evidence and does not count.
function isDisclosure(entry) {
  if (entry.kind === "parser-differential" || entry.kind === "duplicate") return true;
  if (entry.kind === "unicode-confusable") return true;
  return entry.kind === "non-regular" && !entry.detail.startsWith("typeflag 5 ");
}

// Disclosures carry the raw archive name (`package/C:x`, `a\\b`, `x/../y`), so
// both sides are reduced to bare segments before a segment-suffix match.
function pathSegments(value) {
  return value
    .replaceAll("\\", "/")
    .split("/")
    .map((segment) => segment.replace(/^[A-Za-z]:/, ""))
    .filter((segment) => segment && segment !== "." && segment !== "..");
}

function samePath(disclosed, installed) {
  const a = pathSegments(disclosed);
  const b = pathSegments(installed);
  if (!a.length || !b.length) return false;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.every(
    (segment, index) => segment === longer[longer.length - shorter.length + index],
  );
}

/**
 * Compare Drydock's reviewed view with one consumer's installed set.
 * Passing outcomes: `agree`, `consumer-refused` (the install fails),
 * `drydock-failed-closed` (the parse throws), `disclosed` (every disagreement
 * is covered by an archive-level `parser-differential` or a per-path
 * disclosure). Otherwise `differential`, with each disagreement's kind.
 */
export function compareInstalled(drydock, consumer) {
  if (!consumer.ok)
    return { outcome: "consumer-refused", detail: consumer.error, disagreements: [] };
  if (!drydock.ok)
    return { outcome: "drydock-failed-closed", detail: drydock.error, disagreements: [] };
  // Drydock's last record for a path is the body it treats as installed.
  const reviewed = new Map();
  for (const file of drydock.files) reviewed.set(file.path, file);
  const disagreements = [];
  for (const [installedPath, entry] of consumer.entries) {
    const file = reviewed.get(installedPath);
    if (!file) {
      disagreements.push({
        kind: entry.type === "file" ? "missing" : `missing-${entry.type}`,
        path: installedPath,
        sha256: entry.sha256,
      });
    } else if (entry.type !== "file") {
      disagreements.push({ kind: "type", path: installedPath });
    } else if (entry.sha256 !== file.sha256) {
      disagreements.push({ kind: "body", path: installedPath, sha256: entry.sha256 });
    }
  }
  for (const [reviewedPath, file] of reviewed) {
    if (!consumer.entries.has(reviewedPath))
      disagreements.push({ kind: "extra", path: reviewedPath, sha256: file.sha256 });
  }
  if (!disagreements.length) return { outcome: "agree", disagreements };
  const disclosures = drydock.suspicious.filter(isDisclosure);
  const archiveWide = disclosures.some(
    (entry) => entry.kind === "parser-differential" && entry.path === "<archive>",
  );
  // A disagreement is covered when a disclosure names its path, or when the
  // consumer installs bytes Drydock reviewed under a disclosed path (a rename
  // the disclosure says depends on the reader).
  const covered = (disagreement) =>
    disclosures.some(
      (entry) =>
        samePath(entry.path, disagreement.path) ||
        (disagreement.sha256 &&
          drydock.files.some(
            (file) => file.sha256 === disagreement.sha256 && samePath(entry.path, file.path),
          )),
    );
  // A disclosed member can also stop the PyPI adapter stripping the sdist root
  // (its node-tar path sits outside it), which shifts every other body by one
  // leading segment. With a member-level differential disclosed, a missing and
  // an extra entry carrying the same bytes one segment apart are that shift.
  const memberDisclosed = disclosures.some((entry) => entry.kind === "parser-differential");
  const rootShifted = (disagreement) =>
    memberDisclosed &&
    disagreements.some(
      (other) =>
        other !== disagreement &&
        other.sha256 === disagreement.sha256 &&
        (other.kind === "extra") !== (disagreement.kind === "extra") &&
        (other.path.endsWith(`/${disagreement.path}`) ||
          disagreement.path.endsWith(`/${other.path}`)) &&
        Math.abs(other.path.split("/").length - disagreement.path.split("/").length) === 1,
    );
  const undisclosed = archiveWide
    ? []
    : disagreements.filter((disagreement) => !covered(disagreement) && !rootShifted(disagreement));
  return undisclosed.length
    ? { outcome: "differential", disagreements: undisclosed }
    : { outcome: "disclosed", disagreements };
}

export function describeDifferential(label, comparison) {
  return `${label}: ${comparison.outcome} — ${comparison.disagreements
    .map((disagreement) => `${disagreement.kind} ${JSON.stringify(disagreement.path)}`)
    .join(", ")}`;
}
