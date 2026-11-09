// @ts-nocheck
// Differential tests for the archive readers: the same bytes go through
// Drydock's parser and through the reader each ecosystem actually installs
// with (node-tar as pacote drives it, CPython's tarfile/zipfile as pip drives
// them, yauzl as VS Code drives it). Drydock passes an archive when it reviews
// the installed entry set, fails closed, or discloses the disagreement. See
// docs/sandbox-parser.md#differential-harness and test/helpers/archive-consumers.mjs.

import { randomInt } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import fc from "fast-check";
import { beforeAll, describe, expect, test } from "vitest";
import {
  compareInstalled,
  describeDifferential,
  drydockNpm,
  drydockSdist,
  drydockVsix,
  drydockWheel,
  findPython,
  NPM_TAR_READERS,
  npmInstall,
  pipInstallBatch,
  vscodeInstall,
} from "./helpers/archive-consumers.mjs";
import {
  TAR_BLOCK,
  buildTar,
  buildTarHeaderOnly,
  buildZip,
  concatBytes,
  encoder,
  paxBody,
  sealTarHeader,
  tarEntriesOnly,
  unicodePathExtra,
} from "./helpers/archive-fixtures";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
// CI checks fixed seeds so every failure reproduces. DIFFERENTIAL_SEED pins one
// seed; DIFFERENTIAL_RANDOM_SEEDS=<n> draws n fresh ones for a long local run
// (with DIFFERENTIAL_RUNS raised). Seeds appear in test names, and a failure
// names its seed, run, and generated shape.
const FIXED_SEEDS = [0x0d1ff, 0x5eed01, 0x5eed02, 0x5eed03, 0x5eed04, 0x5eed05];
const SEEDS = process.env.DIFFERENTIAL_SEED
  ? [Number(process.env.DIFFERENTIAL_SEED)]
  : Number(process.env.DIFFERENTIAL_RANDOM_SEEDS) > 0
    ? Array.from({ length: Number(process.env.DIFFERENTIAL_RANDOM_SEEDS) }, () =>
        randomInt(2 ** 31),
      )
    : FIXED_SEEDS;
const RUNS = Number(process.env.DIFFERENTIAL_RUNS) || 250;

// fast-check samples rather than `fc.assert`: the PyPI consumer runs out of
// process, so every ecosystem draws its archives up front the same way.
function seededSamples(arbitrary, seed) {
  return fc
    .sample(arbitrary, { seed, numRuns: RUNS })
    .map((archive, run) => ({ seed, run, archive }));
}

function sampleLabel(kind, sample) {
  return `${kind} seed ${sample.seed} run ${sample.run}: ${JSON.stringify(sample.archive)}`;
}

const PASSING = new Set([
  "agree",
  "consumer-refused",
  "drydock-failed-closed",
  "disclosed",
  "reviewed-unwritable-child",
]);

function expectAgreement(label, comparison) {
  expect(PASSING.has(comparison.outcome), describeDifferential(label, comparison)).toBe(true);
}

async function expectNpmAgreement(label, bytes) {
  const drydock = await drydockNpm(bytes);
  for (const reader of NPM_TAR_READERS) {
    expectAgreement(
      `${label} [${reader.label}]`,
      compareInstalled(drydock, await npmInstall(bytes, reader.Parser)),
    );
  }
}

const gz = (tar) => new Uint8Array(gzipSync(tar));

// --- repository fixtures -------------------------------------------------------

function walkFiles(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkFiles(full, base));
    else
      out.push({
        path: path.relative(base, full).split(path.sep).join("/"),
        body: readFileSync(full),
      });
  }
  return out;
}

// Every package directory the e2e registry packs, packed the way `npm pack`
// lays it out (a `package/` root, no directory records).
function e2ePackages() {
  const root = path.join(TEST_DIR, "e2e-fixtures");
  const packages = [];
  const scenariosRoot = path.join(root, "scenarios");
  for (const scenario of readdirSync(scenariosRoot).sort()) {
    const meta = JSON.parse(
      readFileSync(path.join(scenariosRoot, scenario, "scenario.json"), "utf8"),
    );
    for (const side of ["staged", "previous"]) {
      const dir = meta[side]?.directory;
      if (!dir) continue;
      const files = walkFiles(path.join(scenariosRoot, scenario, dir));
      const packageJsonText = meta[side].packageJsonText;
      packages.push({
        name: `e2e ${scenario}/${side}`,
        files:
          typeof packageJsonText === "string"
            ? files.map((file) =>
                file.path === "package.json" ? { ...file, body: packageJsonText } : file,
              )
            : files,
      });
    }
  }
  for (const dir of [
    "post-release-review/1.0.0",
    "post-release-review/1.1.0",
    "publication-monitor",
  ]) {
    packages.push({ name: `e2e ${dir}`, files: walkFiles(path.join(root, dir)) });
  }
  return packages;
}

// Security-corpus cases are FileRecord lists rather than archives; their path
// layouts are packed into the archive kind the ecosystem ships, with each
// record's text sample as its body.
function corpusArchives() {
  const corpus = path.join(TEST_DIR, "fixtures/security-corpus");
  const out = { npm: [], sdist: [], wheel: [], vsix: [] };
  const records = (files) =>
    (files ?? []).map((file) => ({ path: file.path, body: file.textSample ?? "" }));
  for (const dir of ["cases", "cases-benign", "cases-frontier", "cases-pypi", "cases-vscode"]) {
    for (const name of readdirSync(path.join(corpus, dir)).sort()) {
      if (!name.endsWith(".json")) continue;
      const fixture = JSON.parse(readFileSync(path.join(corpus, dir, name), "utf8"));
      const label = `${dir}/${name}`;
      for (const artifact of [...(fixture.artifacts ?? []), ...(fixture.previousArtifacts ?? [])]) {
        const kind = artifact.path.endsWith(".whl") ? "wheel" : "sdist";
        out[kind].push({ name: `${label} ${artifact.path}`, files: records(artifact.files) });
      }
      for (const side of ["stagedFiles", "previousFiles"]) {
        if (!fixture[side]?.length) continue;
        const kind = dir === "cases-vscode" || fixture.ecosystem === "vscode" ? "vsix" : "npm";
        out[kind].push({ name: `${label} ${side}`, files: records(fixture[side]) });
      }
    }
  }
  return out;
}

const npmTarball = (files) =>
  gz(buildTar(files.map((file) => ({ name: `package/${file.path}`, body: file.body }))));
// pip only builds a tree with `pyproject.toml` or `setup.py` at its top, so
// sdists get one unless they carry their own.
const PYPROJECT = { name: "demo-1.0/pyproject.toml", body: "[project]\nname = 'demo'\n" };
function withBuildFile(files) {
  const root = files[0]?.path.split("/")[0] || "demo-1.0";
  const hasOne = files.some(
    (file) => file.path === `${root}/pyproject.toml` || file.path === `${root}/setup.py`,
  );
  return hasOne ? files : [{ path: `${root}/pyproject.toml`, body: PYPROJECT.body }, ...files];
}
const sdistTarball = (files) =>
  gz(buildTar(withBuildFile(files).map((file) => ({ name: file.path, body: file.body }))));
const zipOf = (files) =>
  buildZip(files.map((file) => ({ path: file.path, body: file.body, deflate: true })));

// --- crafted shapes ------------------------------------------------------------

function rawHeader({ name, type = "0", size = 0, prefix = "", linkname = "", ustar = true }) {
  return buildTarHeaderOnly({ name, type, size, prefix, linkname, ustar });
}

function block(body) {
  const bytes = typeof body === "string" ? encoder.encode(body) : body;
  const out = new Uint8Array(Math.ceil(bytes.length / TAR_BLOCK) * TAR_BLOCK);
  out.set(bytes);
  return out;
}

const endOfArchive = () => new Uint8Array(TAR_BLOCK * 2);

// Each case names the consumer it targets.
const NPM_CASES = [
  {
    name: "plain package",
    bytes: () =>
      gz(
        buildTar([
          { name: "package/package.json", body: "{}" },
          { name: "package/index.js", body: "1" },
        ]),
      ),
  },
  {
    name: "entries after a lone null block",
    bytes: () =>
      gz(
        concatBytes([
          tarEntriesOnly(buildTar([{ name: "package/package.json", body: "{}" }])),
          new Uint8Array(TAR_BLOCK),
          buildTar([{ name: "package/index.js", body: "after" }]),
        ]),
      ),
  },
  {
    name: "duplicate entries, last wins",
    bytes: () =>
      gz(
        buildTar([
          { name: "package/index.js", body: "first" },
          { name: "package/index.js", body: "second" },
        ]),
      ),
  },
  {
    name: "header with a bad checksum hides its body",
    bytes: () => {
      const bad = rawHeader({ name: "package/hidden.js", size: TAR_BLOCK });
      bad[148] = 0x31;
      return gz(
        concatBytes([
          bad,
          tarEntriesOnly(buildTar([{ name: "package/inner.js", body: "inner" }])),
          endOfArchive(),
        ]),
      );
    },
  },
  {
    name: "pax path and GNU long name",
    bytes: () =>
      gz(
        buildTar([
          { name: "PaxHeader/x", type: "x", body: paxBody([["path", "package/from-pax.js"]]) },
          { name: "package/x.js", body: "pax" },
          { name: "././@LongLink", type: "L", body: `package/${"d".repeat(120)}.js\0` },
          { name: "package/short.js", body: "gnu" },
        ]),
      ),
  },
  {
    // node-tar 7.5.15 (npm 11) sizes the long-name header's body with the
    // pending pax `size`; 7.5.22 (npm 12) applies it only to the member.
    name: "pending pax size before a GNU long name",
    bytes: () =>
      gz(
        concatBytes([
          tarEntriesOnly(
            buildTar([{ name: "PaxHeader/x", type: "x", body: paxBody([["size", "1024"]]) }]),
          ),
          rawHeader({ name: "././@LongLink", type: "L", size: 20 }),
          block("package/a.js"),
          rawHeader({ name: "package/b.js", size: 1024 }),
          rawHeader({ name: "package/a.js", size: 1024 }),
          block("x".repeat(512)),
          rawHeader({ name: "package/c.js", size: 512 }),
          block("y".repeat(512)),
          endOfArchive(),
        ]),
      ),
  },
  {
    name: "ustar prefix field",
    bytes: () => gz(buildTar([{ name: "index.js", prefix: "package/lib", body: "prefixed" }])),
  },
  {
    name: "top-level entry, traversal, drive letter, backslash",
    bytes: () =>
      gz(
        buildTar([
          { name: "index.js", body: "no root" },
          { name: "package/../escape.js", body: "escape" },
          { name: "package/C:drive.js", body: "drive" },
          { name: "package/a\\b.js", body: "backslash" },
          { name: "package/ok.js", body: "ok" },
        ]),
      ),
  },
  {
    name: "links, devices, and directories are not installed",
    bytes: () =>
      gz(
        buildTar([
          { name: "package/", type: "5" },
          { name: "package/link", type: "2", linkname: "index.js" },
          { name: "package/hard", type: "1", linkname: "package/index.js" },
          { name: "package/fifo", type: "6" },
          { name: "package/index.js", body: "1" },
          { name: "package/contiguous.js", type: "7", body: "7" },
        ]),
      ),
  },
  {
    name: "file then a child under the same name",
    bytes: () =>
      gz(
        buildTar([
          { name: "package/lib", body: "file" },
          { name: "package/lib/index.js", body: "child" },
        ]),
      ),
  },
];

const PYPI_CASES = [
  {
    name: "plain sdist",
    kind: "sdist",
    bytes: () => sdistTarball([{ path: "demo-1.0/setup.py", body: "x" }]),
  },
  {
    name: "sdist ustar prefix without the magic",
    kind: "sdist",
    bytes: () =>
      gz(
        buildTar([
          PYPROJECT,
          { name: "setup.py", prefix: "demo-1.0/hidden", ustar: false, body: "prefixed" },
        ]),
      ),
  },
  {
    name: "sdist member named by two GNU long names",
    kind: "sdist",
    bytes: () =>
      gz(
        buildTar([
          PYPROJECT,
          { name: "././@LongLink", type: "L", body: "demo-1.0/setup.py\0" },
          { name: "././@LongLink", type: "L", body: "demo-1.0/docs/notes.txt\0" },
          { name: "demo-1.0/x", body: "payload" },
        ]),
      ),
  },
  {
    name: "sdist entries after a bad-checksum header",
    kind: "sdist",
    bytes: () => {
      const bad = rawHeader({ name: "demo-1.0/hidden.py" });
      bad[148] = 0x31;
      return gz(
        concatBytes([
          tarEntriesOnly(buildTar([PYPROJECT])),
          bad,
          buildTar([{ name: "demo-1.0/setup.py", body: "after" }]),
        ]),
      );
    },
  },
  {
    name: "sdist symlink and hardlink",
    kind: "sdist",
    bytes: () =>
      gz(
        buildTar([
          { name: "demo-1.0/setup.py", body: "x" },
          { name: "demo-1.0/link.py", type: "2", linkname: "setup.py" },
          { name: "demo-1.0/hard.py", type: "1", linkname: "demo-1.0/setup.py" },
        ]),
      ),
  },
  {
    name: "sdist regular-file typeflag on a name ending in a slash",
    kind: "sdist",
    bytes: () => {
      const hidden = tarEntriesOnly(buildTar([{ name: "demo-1.0/setup.py", body: "decoy" }]));
      return gz(
        concatBytes([
          tarEntriesOnly(buildTar([PYPROJECT])),
          rawHeader({ name: "demo-1.0/setup.py/", type: "0", size: hidden.length }),
          hidden,
          endOfArchive(),
        ]),
      );
    },
  },
  {
    name: "sdist regular-file typeflag on a slash name without a body",
    kind: "sdist",
    bytes: () =>
      gz(
        concatBytes([
          tarEntriesOnly(buildTar([PYPROJECT])),
          rawHeader({ name: "demo-1.0/data/", type: "0" }),
          endOfArchive(),
        ]),
      ),
  },
  {
    name: "sdist link record that declares a body",
    kind: "sdist",
    bytes: () =>
      gz(
        concatBytes([
          tarEntriesOnly(buildTar([PYPROJECT])),
          rawHeader({ name: "demo-1.0/link.py", type: "2", linkname: "setup.py", size: 5 }),
          block("body\n"),
          tarEntriesOnly(buildTar([{ name: "demo-1.0/setup.py", body: "x" }])),
          endOfArchive(),
        ]),
      ),
  },
  {
    name: "plain wheel",
    kind: "wheel",
    bytes: () =>
      zipOf([
        { path: "demo-1.0.dist-info/METADATA", body: "Name: demo\n" },
        { path: "demo/__init__.py", body: "x" },
      ]),
  },
  {
    name: "wheel duplicate names",
    kind: "wheel",
    bytes: () =>
      buildZip([
        { path: "demo/__init__.py", body: "first" },
        { path: "demo/__init__.py", body: "second" },
      ]),
  },
  {
    name: "wheel traversal and dot segments",
    kind: "wheel",
    bytes: () =>
      buildZip([
        { path: "demo/../evil.pth", body: "x" },
        { path: "./demo/x.py", body: "y" },
      ]),
  },
  {
    name: "wheel name without the UTF-8 flag",
    kind: "wheel",
    bytes: () =>
      buildZip([
        {
          path: "demo/a",
          nameBytes: Uint8Array.from([
            ...encoder.encode("demo/hook"),
            0x80,
            ...encoder.encode(".pth"),
          ]),
          utf8: false,
          body: "x",
        },
      ]),
  },
  {
    name: "wheel Info-ZIP Unicode Path field",
    kind: "wheel",
    bytes: () =>
      buildZip([
        {
          path: "demo/notes.txt",
          body: "x",
          extra: unicodePathExtra("demo/notes.txt", "evil.pth"),
        },
      ]),
  },
  {
    name: "wheel end record inside the archive comment",
    kind: "wheel",
    bytes: () =>
      zipWithSecondEndRecord([
        { path: "demo-1.0.dist-info/METADATA", body: "Name: demo\n" },
        { path: "demo/__init__.py", body: "x" },
      ]),
  },
];

// A zip whose end-of-central-directory comment holds a second, empty end
// record. A reader that takes the last end record in the file reads that empty
// directory; one that takes the first reads the real entries.
function zipWithSecondEndRecord(entries) {
  const commentStart = buildZip(entries).length;
  const emptyEnd = new Uint8Array(22);
  const view = new DataView(emptyEnd.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint32(16, commentStart, true);
  return buildZip(entries, { comment: emptyEnd });
}

const VSIX_CASES = [
  {
    name: "end record inside the archive comment",
    bytes: () =>
      zipWithSecondEndRecord([
        { path: "extension/package.json", body: "{}" },
        { path: "extension/out/extension.js", body: "1" },
      ]),
  },
  {
    name: "plain extension",
    bytes: () =>
      buildZip([
        { path: "extension.vsixmanifest", body: "<x/>" },
        { path: "extension/package.json", body: "{}" },
        { path: "extension/out/extension.js", body: "1", deflate: true, dataDescriptor: true },
      ]),
  },
  {
    name: "duplicate names",
    bytes: () =>
      buildZip([
        { path: "extension/out/extension.js", body: "first" },
        { path: "extension/out/extension.js", body: "second" },
      ]),
  },
  {
    name: "backslash and traversal names",
    bytes: () =>
      buildZip([
        { path: "extension\\out\\a.js", body: "a" },
        { path: "extension/../b.js", body: "b" },
      ]),
  },
  {
    name: "name without the UTF-8 flag",
    bytes: () =>
      buildZip([
        {
          path: "x",
          nameBytes: Uint8Array.from([
            ...encoder.encode("extension/a"),
            0x80,
            ...encoder.encode(".js"),
          ]),
          utf8: false,
          body: "x",
        },
      ]),
  },
  {
    name: "Info-ZIP Unicode Path field",
    bytes: () =>
      buildZip([
        {
          path: "extension/notes.txt",
          body: "x",
          extra: unicodePathExtra("extension/notes.txt", "extension/out/evil.js"),
        },
      ]),
  },
  {
    name: "entry under `extension` without a slash",
    bytes: () =>
      buildZip([
        { path: "extension/package.json", body: '{"main":"./out/a.js"}' },
        { path: "extensionpackage.json", body: '{"main":"./out/b.js"}' },
      ]),
  },
];

// --- property generators --------------------------------------------------------

const BODIES = fc.constantFrom("", "alpha\n", "beta\n", "x".repeat(700));

function tarArchiveArbitrary(names) {
  const member = fc.record({
    name: fc.constantFrom(...names),
    type: fc.constantFrom("0", "0", "0", "\0", "7", "5", "1", "2", "6", "S", "Z"),
    body: BODIES,
    naming: fc.constantFrom("header", "header", "pax", "gnu", "prefix"),
    magic: fc.constantFrom("posix", "posix", "gnu", "none"),
    checksum: fc.constantFrom("valid", "valid", "valid", "valid", "invalid", "signed"),
    size: fc.constantFrom("octal", "octal", "octal", "space", "base256"),
  });
  const record = fc.oneof(
    { weight: 10, arbitrary: member },
    { weight: 1, arbitrary: fc.constant({ nullBlock: true }) },
  );
  return fc.record({
    records: fc.array(record, { minLength: 1, maxLength: 6 }),
    trailer: fc.constantFrom("eof", "eof", "eof", "none", "garbage"),
    gzip: fc.constantFrom("single", "single", "single", "two-members", "trailing-garbage"),
  });
}

function encodeMember(member) {
  const { type, naming } = member;
  const body = encoder.encode(member.body);
  const parts = [];
  let headerName = member.name;
  let prefix = "";
  if (naming === "pax") {
    parts.push(rawPaxHeader(member.name));
    headerName = "placeholder";
  } else if (naming === "gnu") {
    const longName = encoder.encode(`${member.name}\0`);
    parts.push(
      rawHeader({ name: "././@LongLink", type: "L", size: longName.length }),
      block(longName),
    );
    headerName = member.name.slice(0, 100);
  } else if (naming === "prefix" && member.name.includes("/")) {
    const cut = member.name.lastIndexOf("/");
    prefix = member.name.slice(0, cut);
    headerName = member.name.slice(cut + 1) || "x";
  }
  const linkname = type === "1" || type === "2" ? "index.js" : "";
  const header = rawHeader({
    name: headerName.slice(0, 100),
    type,
    size: body.length,
    prefix: prefix.slice(0, 155),
    linkname,
    ustar: member.magic !== "none",
  });
  if (member.magic === "gnu") header.set(encoder.encode("ustar  \0"), 257);
  if (member.size === "space") {
    header.set(encoder.encode(body.length.toString(8).padStart(11, "0") + " "), 124);
  } else if (member.size === "base256") {
    header.fill(0, 124, 136);
    header[124] = 0x80;
    new DataView(header.buffer, header.byteOffset).setUint32(132, body.length, false);
  }
  sealTarHeader(header, 0);
  if (member.checksum === "invalid") header[150] = header[150] === 0x37 ? 0x36 : 0x37;
  if (member.checksum === "signed") {
    let sum = 8 * 0x20;
    for (let i = 0; i < TAR_BLOCK; i++) {
      if (i >= 148 && i < 156) continue;
      sum += header[i] > 127 ? header[i] - 256 : header[i];
    }
    header.set(encoder.encode(((sum >>> 0) & 0o777777).toString(8).padStart(6, "0") + "\0 "), 148);
  }
  parts.push(header, block(body));
  return concatBytes(parts);
}

function rawPaxHeader(pathValue) {
  const body = encoder.encode(paxBody([["path", pathValue]]));
  return concatBytes([
    rawHeader({ name: "PaxHeader/x", type: "x", size: body.length }),
    block(body),
  ]);
}

function encodeTarArchive(archive, { lead = [] } = {}) {
  const parts = [
    ...lead,
    ...archive.records.map((record) =>
      record.nullBlock ? new Uint8Array(TAR_BLOCK) : encodeMember(record),
    ),
  ];
  if (archive.trailer === "eof") parts.push(endOfArchive());
  if (archive.trailer === "garbage") parts.push(endOfArchive(), encoder.encode("trailing"));
  const tar = concatBytes(parts);
  if (archive.gzip === "two-members") {
    const cut = Math.floor(tar.length / TAR_BLOCK / 2) * TAR_BLOCK;
    return concatBytes([gz(tar.subarray(0, cut)), gz(tar.subarray(cut))]);
  }
  if (archive.gzip === "trailing-garbage") return concatBytes([gz(tar), encoder.encode("garbage")]);
  return gz(tar);
}

function zipArchiveArbitrary(names, { dataDescriptors }) {
  const entry = fc.record({
    name: fc.constantFrom(...names),
    body: BODIES,
    deflate: fc.boolean(),
    utf8: fc.constantFrom(true, true, true, false),
    unicodePath: fc.constantFrom(null, null, null, null, "match", "stale"),
    centralName: fc.constantFrom(null, null, null, null, null, "differs"),
    crc: fc.constantFrom("valid", "valid", "valid", "valid", "valid", "wrong"),
    dataDescriptor: dataDescriptors ? fc.boolean() : fc.constant(false),
  });
  return fc.record({
    entries: fc.array(entry, { minLength: 1, maxLength: 5 }),
    tail: fc.constantFrom("none", "none", "none", "comment", "garbage"),
  });
}

function encodeZipArchive(archive, names) {
  const entries = archive.entries.map((entry, index) => {
    const nameBytes = encoder.encode(entry.name);
    const out = {
      path: entry.name,
      body: entry.body,
      deflate: entry.deflate,
      utf8: entry.utf8,
      dataDescriptor: entry.dataDescriptor,
    };
    if (entry.unicodePath) {
      const renamed = names[(index + 1) % names.length];
      out.extra = unicodePathExtra(entry.unicodePath === "match" ? nameBytes : "stale", renamed);
    }
    if (entry.centralName === "differs")
      out.centralNameBytes = encoder.encode(names[(index + 2) % names.length]);
    if (entry.crc === "wrong") out.crc = 0x1234;
    return out;
  });
  const comment = archive.tail === "comment" ? encoder.encode("comment") : undefined;
  const zip = buildZip(entries, comment ? { comment } : {});
  return archive.tail === "garbage" ? concatBytes([zip, encoder.encode("garbage")]) : zip;
}

const NPM_NAMES = [
  "package/package.json",
  "package/index.js",
  "package/index.js",
  "package/lib/a.js",
  "package/lib/",
  "package/./index.js",
  "package//index.js",
  "index.js",
  "package/../evil.js",
  "/package/index.js",
  "./package/index.js",
  "other/index.js",
  `package/${"d".repeat(110)}.js`,
  "package/lib",
];
const SDIST_NAMES = NPM_NAMES.map((name) => name.replaceAll("package", "demo-1.0"));
const WHEEL_NAMES = [
  "demo/__init__.py",
  "demo/__init__.py",
  "demo-1.0.dist-info/METADATA",
  "demo/",
  "./demo/x.py",
  "demo/../evil.pth",
  "/abs.py",
  "demo//y.py",
  "evil.pth",
  "demo/café.py",
];
const VSIX_NAMES = [
  "extension/package.json",
  "extension/out/a.js",
  "extension/out/a.js",
  "extension/out/",
  "extension.vsixmanifest",
  "[Content_Types].xml",
  "extension/./b.js",
  "extension/../d.js",
  "extension//e.js",
  "extension/café.js",
  "extensionpackage.json",
  "extensionout/a.js",
];

// --- npm -----------------------------------------------------------------------

describe("archive differential: npm (node-tar as pacote extracts)", () => {
  test.each(e2ePackages())("$name", async ({ name, files }) => {
    await expectNpmAgreement(name, npmTarball(files));
  });

  test("security-corpus npm layouts", async () => {
    for (const { name, files } of corpusArchives().npm) {
      await expectNpmAgreement(name, npmTarball(files));
    }
  });

  for (const entry of NPM_CASES) {
    test(entry.name, async () => {
      await expectNpmAgreement(entry.name, entry.bytes());
    });
  }

  test.each(SEEDS)(`structural tar mutations (seed %i, ${RUNS} runs)`, async (seed) => {
    for (const sample of seededSamples(tarArchiveArbitrary(NPM_NAMES), seed)) {
      await expectNpmAgreement(sampleLabel("npm", sample), encodeTarArchive(sample.archive));
    }
  });
});

// --- VS Code -------------------------------------------------------------------

describe("archive differential: VS Code (yauzl as VS Code extracts)", () => {
  test("security-corpus extension layouts", async () => {
    for (const { name, files } of corpusArchives().vsix) {
      const bytes = zipOf(files);
      expectAgreement(name, compareInstalled(await drydockVsix(bytes), await vscodeInstall(bytes)));
    }
  });

  for (const entry of VSIX_CASES) {
    test(entry.name, async () => {
      const bytes = entry.bytes();
      expectAgreement(
        entry.name,
        compareInstalled(await drydockVsix(bytes), await vscodeInstall(bytes)),
      );
    });
  }

  test.each(SEEDS)(`structural zip mutations (seed %i, ${RUNS} runs)`, async (seed) => {
    const arbitrary = zipArchiveArbitrary(VSIX_NAMES, { dataDescriptors: true });
    for (const sample of seededSamples(arbitrary, seed)) {
      const bytes = encodeZipArchive(sample.archive, VSIX_NAMES);
      expectAgreement(
        sampleLabel("vsix", sample),
        compareInstalled(await drydockVsix(bytes), await vscodeInstall(bytes)),
      );
    }
  });
});

// --- PyPI ----------------------------------------------------------------------

const python = findPython();
const pythonMissing = `need Python 3.12+ (found ${python ? `${python.command} ${python.version}` : "none"}; set DRYDOCK_DIFFERENTIAL_PYTHON)`;
if (!python?.supported) {
  console.warn(`archive differential: PyPI cases skipped; ${pythonMissing}`);
}

// Locally a missing interpreter skips the PyPI block; CI must run it.
test.runIf(!python?.supported && Boolean(process.env.CI))(
  "archive differential: PyPI interpreter is available in CI",
  () => {
    expect.fail(`the PyPI differential cases cannot run: ${pythonMissing}`);
  },
);

describe.skipIf(!python?.supported)(
  `archive differential: PyPI (CPython ${python?.version} as pip reads)`,
  () => {
    const corpus = corpusArchives();
    const jobs = [];
    const enqueue = (kind, bytes) => jobs.push({ kind, bytes }) - 1;
    const corpusJobs = [
      ...corpus.sdist.map(({ name, files }) => ({
        name,
        kind: "sdist",
        bytes: sdistTarball(files),
      })),
      ...corpus.wheel.map(({ name, files }) => ({ name, kind: "wheel", bytes: zipOf(files) })),
    ].map((job) => ({ ...job, index: enqueue(job.kind, job.bytes) }));
    const caseJobs = PYPI_CASES.map((entry) => {
      const bytes = entry.bytes();
      return { entry, bytes, index: enqueue(entry.kind, bytes) };
    });
    // fast-check cannot drive an out-of-process consumer per run, so the samples
    // are drawn up front from the seed and checked in one interpreter.
    const samples = SEEDS.flatMap((seed) => [
      ...seededSamples(tarArchiveArbitrary(SDIST_NAMES), seed).map((sample) => ({
        ...sample,
        kind: "sdist",
        bytes: encodeTarArchive(sample.archive, {
          lead: [tarEntriesOnly(buildTar([PYPROJECT]))],
        }),
      })),
      ...seededSamples(zipArchiveArbitrary(WHEEL_NAMES, { dataDescriptors: false }), seed).map(
        (sample) => ({
          ...sample,
          kind: "wheel",
          bytes: encodeZipArchive(sample.archive, WHEEL_NAMES),
        }),
      ),
    ]).map((sample) => ({ ...sample, index: enqueue(sample.kind, sample.bytes) }));

    let results;
    // Long random runs batch thousands of archives into one interpreter.
    beforeAll(() => {
      results = pipInstallBatch(jobs);
    }, 600_000);

    const drydock = (kind, bytes) => (kind === "sdist" ? drydockSdist(bytes) : drydockWheel(bytes));

    test("security-corpus sdist and wheel layouts", async () => {
      for (const job of corpusJobs) {
        expectAgreement(
          job.name,
          compareInstalled(await drydock(job.kind, job.bytes), results[job.index]),
        );
      }
    });

    for (const job of caseJobs) {
      const { entry } = job;
      test(entry.name, async () => {
        expectAgreement(
          entry.name,
          compareInstalled(await drydock(entry.kind, job.bytes), results[job.index]),
        );
      });
    }

    for (const kind of ["sdist", "wheel"]) {
      test.each(SEEDS)(`structural ${kind} mutations (seed %i, ${RUNS} runs)`, async (seed) => {
        const mine = samples.filter((sample) => sample.kind === kind && sample.seed === seed);
        for (const sample of mine) {
          expectAgreement(
            sampleLabel(kind, sample),
            compareInstalled(await drydock(kind, sample.bytes), results[sample.index]),
          );
        }
      });
    }
  },
);
