import { describe, expect, test } from "vitest";
import { createPackageDiff, deterministicFindings } from "../server/lib/review";
import { analyzeInstallWrites } from "../server/lib/review/rules/install-root-writes";

const unproven = (source: string, filePath = "install.js") =>
  analyzeInstallWrites(source, { filePath, packageName: "pkg", packageMain: "lib/main.js" })
    .unproven;

// esbuild's install.js, reduced to the shapes the proof has to follow: a
// platform table looked up by a computed key, a destructured helper result,
// `require.resolve` of its own name, a template that renames the scoped
// package, and a binary path whose dominating definition sits in a catch.
const ESBUILD_SHAPED = [
  "var fs2 = require('fs');",
  "var path = require('path');",
  "var path2 = require('path');",
  "var child_process = require('child_process');",
  "var knownWindowsPackages = { 'win32 x64 LE': '@esbuild/win32-x64' };",
  "var knownUnixlikePackages = { 'linux x64 LE': '@esbuild/linux-x64', 'darwin arm64 LE': '@esbuild/darwin-arm64' };",
  "function pkgAndSubpathForCurrentPlatform() {",
  "  let pkg;",
  "  let subpath;",
  "  let platformKey = `${process.platform} ${os.arch()} ${os.endianness()}`;",
  "  if (platformKey in knownWindowsPackages) {",
  "    pkg = knownWindowsPackages[platformKey];",
  "    subpath = 'esbuild.exe';",
  "  } else if (platformKey in knownUnixlikePackages) {",
  "    pkg = knownUnixlikePackages[platformKey];",
  "    subpath = 'bin/esbuild';",
  "  } else {",
  "    throw new Error(`Unsupported platform: ${platformKey}`);",
  "  }",
  "  return { pkg, subpath };",
  "}",
  "function downloadedBinPath(pkg, subpath) {",
  "  const esbuildLibDir = path.dirname(require.resolve('pkg'));",
  "  return path.join(esbuildLibDir, `downloaded-${pkg.replace('/', '-')}-${path.basename(subpath)}`);",
  "}",
  "var toPath = path2.join(__dirname, 'bin', 'esbuild');",
  "function installUsingNPM(pkg, subpath, binPath) {",
  "  const esbuildLibDir = path2.dirname(require.resolve('pkg'));",
  "  const installDir = path2.join(esbuildLibDir, 'npm-install');",
  "  fs2.mkdirSync(installDir);",
  "  fs2.writeFileSync(path2.join(installDir, 'package.json'), '{}');",
  "  child_process.execSync(`npm install --loglevel=error ${pkg}`, { cwd: installDir });",
  "  const installedBinPath = path2.join(installDir, 'node_modules', pkg, subpath);",
  "  fs2.renameSync(installedBinPath, binPath);",
  "}",
  "async function downloadDirectlyFromNPM(pkg, subpath, binPath) {",
  "  fs2.writeFileSync(binPath, await fetch(url));",
  "}",
  "function maybeOptimizePackage(binPath) {",
  "  const tempPath = path2.join(__dirname, 'bin-esbuild');",
  "  fs2.linkSync(binPath, tempPath);",
  "  fs2.renameSync(tempPath, toPath);",
  "}",
  "async function checkAndPreparePackage() {",
  "  const { pkg, subpath } = pkgAndSubpathForCurrentPlatform();",
  "  let binPath;",
  "  try {",
  "    binPath = require.resolve(`${pkg}/${subpath}`);",
  "  } catch (e) {",
  "    binPath = downloadedBinPath(pkg, subpath);",
  "    try {",
  "      installUsingNPM(pkg, subpath, binPath);",
  "    } catch (e2) {",
  "      await downloadDirectlyFromNPM(pkg, subpath, binPath);",
  "    }",
  "  }",
  "  maybeOptimizePackage(binPath);",
  "}",
  "checkAndPreparePackage();",
].join("\n");

describe("analyzeInstallWrites", () => {
  test.each([
    {
      name: "a literal install-root destination",
      source: "fs.writeFileSync('node_modules/left-pad/index.js', payload);\n",
    },
    {
      name: "a template destination naming node_modules",
      source: "for (const n of names) fs.writeFileSync(`../node_modules/${n}/.hook.js`, hook);\n",
    },
    {
      name: "a multi-line path.join alias chain without semicolons",
      source: [
        "const path = require('path')",
        "const root = path.join(",
        "  process.cwd(),",
        "  'node_modules'",
        ")",
        "const target = path.join(root, 'left-pad')",
        "fs.appendFileSync(path.join(target, 'index.js'), payload)",
      ].join("\n"),
    },
    {
      name: "a parent escape out of the package from __dirname",
      source:
        "const path = require('path');\nconst root = path.resolve(__dirname, '..', '..');\nif (__dirname.includes('node_modules')) fs.writeFileSync(path.join(root, 'left-pad', 'index.js'), hook);\n",
    },
    {
      name: "a sibling walk over the parent directory",
      source:
        "const path = require('path');\nconst parent = path.join(__dirname, '..');\nif (path.basename(parent) === 'node_modules') for (const sib of fs.readdirSync(parent)) fs.writeFileSync(path.join(parent, sib, 'index.js'), hook);\n",
    },
    {
      name: "a shell copy into node_modules",
      source: "execSync('cp ./hook.js node_modules/left-pad/index.js');\n",
    },
    {
      name: "a template-string shell move",
      source: "child_process.execSync(`mv ${hook} ${target}/index.js`);\n",
    },
    {
      name: "a shell redirect outside the package",
      source: "execSync('cat hook.js > ../left-pad/index.js');\n",
    },
    {
      name: "a cp spawned with an argv array",
      source: "spawnSync('cp', ['hook.js', '../left-pad/index.js']);\n",
    },
    {
      name: "an append-mode file descriptor",
      source:
        "const fd = fs.openSync(path.join(process.env.INIT_CWD, 'node_modules/x/index.js'), 'a');\nfs.writeSync(fd, hook);\n",
    },
    {
      name: "taint through push and forEach",
      source:
        "const path = require('path');\nconst dirs = [path.join(__dirname, 'out')];\ndirs.push(path.join(__dirname, '..', 'left-pad'));\ndirs.forEach((dir) => fs.writeFileSync(path.join(dir, 'index.js'), hook));\n",
    },
    {
      name: "taint through Object.assign",
      source:
        "const path = require('path');\nconst target = { dir: path.join(__dirname, 'out') };\nObject.assign(target, { dir: path.join(__dirname, '..', 'left-pad') });\nfs.writeFileSync(path.join(target.dir, 'index.js'), hook);\n",
    },
    {
      name: "taint through a Map",
      source:
        "const m = new Map();\nm.set('t', path.join(__dirname, '..', 'left-pad'));\nfs.writeFileSync(m.get('t'), hook);\n",
    },
    {
      name: "a relative write after chdir",
      source:
        "const path = require('path');\nprocess.chdir(path.join(__dirname, '..'));\nfs.writeFileSync('left-pad/index.js', hook);\n",
    },
    {
      name: "require.resolve of another package",
      source: "fs.writeFileSync(require.resolve('left-pad'), hook);\n",
    },
    {
      name: "module.paths",
      source: "fs.writeFileSync(path.join(module.paths[1], 'left-pad/index.js'), hook);\n",
    },
    {
      name: "a path imported from another module",
      source: "const { target } = require('./paths');\nfs.writeFileSync(target, hook);\n",
    },
    {
      name: "a reassignment in a loop after the dominating definition",
      source:
        "const path = require('path');\nlet dest = path.join(__dirname, 'out');\nfor (const name of names) {\n  fs.writeFileSync(dest, hook);\n  dest = path.join(__dirname, '..', name);\n}\n",
    },
    {
      name: "a definition inside an if without braces",
      source:
        "const path = require('path');\nlet dest = path.join(__dirname, 'out');\nif (flag) dest = path.join(__dirname, '..', 'left-pad');\nfs.writeFileSync(dest, hook);\n",
    },
    {
      name: "a closure that reassigns the destination",
      source:
        "const path = require('path');\nlet dest = path.join(__dirname, 'out');\nhooks.on('x', () => { dest = '../left-pad'; });\nfs.writeFileSync(dest, hook);\n",
    },
    {
      name: "a wrapper whose parameter a call site fills with the install root",
      source:
        "function plant(dir) { fs.writeFileSync(path.join(dir, 'index.js'), payload); }\nplant(path.join(process.cwd(), 'node_modules', 'left-pad'));\n",
    },
    {
      name: "a named function handed to a call",
      source:
        "function plant(name) { fs.writeFileSync(name, payload); }\nfs.readdirSync(root).forEach(plant);\n",
    },
    {
      name: "a sink aliased to another name",
      source:
        "const w = fs.writeFileSync;\nw(path.join(cwd, 'node_modules', 'x', 'index.js'), p);\n",
    },
    {
      name: "a sink renamed on import",
      source: "import { writeFile as put } from 'node:fs/promises';\nawait put('x', p);\n",
    },
    {
      name: "write code handed to another interpreter as a string",
      source:
        "execSync(\"node -e \\\"require('fs').writeFileSync(process.argv[1], 'x')\\\" \" + t);\n",
    },
    {
      name: "an assignment hidden in a template interpolation",
      source:
        "let dest = path.join(__dirname, 'out');\nconsole.log(`${(dest = '../left-pad/index.js')}`);\nfs.writeFileSync(dest, hook);\n",
    },
    {
      name: "an unbalanced sink call",
      source: "fs.writeFileSync(path.join(own, 'x'), (\n",
    },
    {
      name: "a generic fs sink taken as a value",
      source:
        "const fs = require('fs');\nconst mv = promisify(fs.rename);\nawait mv(tmp, path.join(__dirname, 'x'));\n",
    },
    {
      name: "a sink named in a computed member",
      source: "fs['writeFileSync'](path.join(__dirname, 'x'), hook);\n",
    },
    {
      name: "a sink chosen by a computed member",
      source: "const m = pick();\nfs[m](path.join(__dirname, 'x'), hook);\n",
    },
    {
      name: "a nested container read out of a bound object",
      source:
        "const path = require('path');\nconst o = { inner: { d: path.join(__dirname, 'x') } };\nconst i = o.inner;\ni.d = '../left-pad/index.js';\nfs.writeFileSync(o.inner.d, hook);\n",
    },
    {
      name: "a container returned and mutated by the caller",
      source:
        "const path = require('path');\nconst CONFIG = { d: path.join(__dirname, 'x') };\nfunction get() { return CONFIG; }\nget().d = '../left-pad/index.js';\nfs.writeFileSync(CONFIG.d, hook);\n",
    },
    {
      name: "a monkeypatched path module",
      source:
        "const path = require('path');\npath.join = () => '../left-pad/index.js';\nfs.writeFileSync(path.join(__dirname, 'x'), hook);\n",
    },
    {
      name: "a property the literal does not define",
      source: "const o = { a: 'x' };\nfs.writeFileSync(o.b, hook);\n",
    },
    {
      name: "a destination from an exported function's parameter",
      source:
        "export async function emit(outDir) {\n  await writeFile(path.join(outDir, 'x'), '{}');\n}\n",
    },
  ])("does not prove $name", ({ source }) => {
    expect(unproven(source)).toBe(true);
  });

  test.each([
    { name: "the esbuild-shaped installer", source: ESBUILD_SHAPED },
    {
      name: "writes under the package directory, including a parent of a nested file",
      source:
        "const path = require('path');\nfs.writeFileSync(path.join(__dirname, '..', 'bin', 'x'), b);\nfs.renameSync(tmp, path.resolve(__dirname, '../lib/x.node'));\n",
      filePath: "scripts/install.js",
    },
    {
      name: "temp and home destinations",
      source:
        "const fs = require('fs');\nconst os = require('os');\nconst path = require('path');\nconst dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-'));\nfs.writeFileSync(path.join(dir, 'a'), b);\nfs.writeFileSync(path.join(os.homedir(), '.cache', 'pkg', 'a'), b);\n",
    },
    {
      name: "a wrapper only ever called with its own directory",
      source:
        "const path = require('path');\nfunction plant(dir) { fs.writeFileSync(path.join(dir, 'index.js'), payload); }\nplant(path.join(__dirname, 'lib'));\n",
    },
    {
      name: "a callback over an array literal",
      source:
        "const path = require('path');\n['a', 'b'].forEach((file) => fs.writeFileSync(path.join(__dirname, file), ''));\n",
    },
    {
      name: "an ESM installer anchored on import.meta",
      source:
        "import { writeFileSync } from 'node:fs';\nimport { fileURLToPath } from 'node:url';\nimport path from 'node:path';\nconst here = path.dirname(fileURLToPath(import.meta.url));\nwriteFileSync(path.join(here, 'out.json'), '{}');\n",
    },
    {
      name: "a read-only open and a shell command that writes nothing",
      source:
        "const fd = fs.openSync(path.join(__dirname, 'a'), 'r');\nexecSync('node-gyp rebuild 2>&1');\n",
    },
    {
      name: "a relative shell copy inside the package",
      source: "execSync('cp prebuilds/x.node build/Release/x.node');\n",
    },
  ])("proves $name", ({ source, filePath }) => {
    expect(unproven(source, filePath)).toBe(false);
  });

  test("fails closed instead of walking a quadratic-shaped hostile file", () => {
    const chain = Array.from({ length: 60_000 }, (_, index) => `a${index}`).join(" = ");
    const started = performance.now();
    expect(unproven(`${chain} = own;\nfs.writeFileSync(a0, 'x');\n`)).toBe(true);
    expect(performance.now() - started).toBeLessThan(10_000);
  }, 30_000);

  test("reports the relative module an unproven destination came from", () => {
    expect(
      analyzeInstallWrites("import { target } from './paths.js';\nfs.writeFileSync(target, h);\n", {
        filePath: "install.js",
      }).importedFrom,
    ).toEqual(["./paths.js"]);
  });
});

describe("analyzeInstallWrites interop and climbs", () => {
  const origin = { filePath: "scripts/install.js", packageName: "pkg" };

  test("proves a TypeScript CommonJS interop write into its own directory", () => {
    expect(
      analyzeInstallWrites(
        'const fs_1 = require("fs");\nconst path_1 = require("path");\n(0, fs_1.writeFileSync)((0, path_1.join)(__dirname, "out.txt"), data);\n',
        origin,
      ),
    ).toEqual({ unproven: false, intoInstallRoot: false, importedFrom: [] });
  });

  test.each([
    ["a doubled dirname", "const root = path.dirname(path.dirname(__dirname));\n", 1],
    ["a parent escape", "const x = 1;\nconst root = path.resolve(__dirname, '../..');\n", 2],
    ["another package", "const target = require.resolve('left-pad');\n", 1],
    ["an unknown specifier", "const target = require.resolve(name);\n", 1],
    ["an unknown base climbed", "const up = path.join(base, '..');\n", 1],
  ])("reports %s as a climb", (_label, body, line) => {
    expect(analyzeInstallWrites(`const path = require('path');\n${body}`, origin).climbLine).toBe(
      line + 1,
    );
  });

  test.each([
    "const own = path.join(__dirname, '..', 'templates');\n",
    "const self = require.resolve('pkg/package.json');\n",
    "if (rel.split('/').includes('..')) throw new Error('outside');\n",
  ])("does not report an in-package path as a climb: %#", (body) => {
    expect(
      analyzeInstallWrites(`const path = require('path');\n${body}`, origin).climbLine,
    ).toBeUndefined();
  });
});

describe("propagation.package-mutation", () => {
  const file = (path: string, textSample: string) => ({
    path,
    size: textSample.length,
    sha256: path,
    flags: [] as string[],
    textSample,
  });
  const findingsFor = (
    installJs: string,
    flags: string[] = [],
    extra: ReturnType<typeof file>[] = [],
  ) => {
    const staged = [
      file(
        "package.json",
        JSON.stringify({
          name: "pkg",
          main: "lib/main.js",
          scripts: { postinstall: "node install.js" },
        }),
      ),
      { ...file("install.js", installJs), flags },
      ...extra,
    ];
    return deterministicFindings(staged, createPackageDiff([], staged)).filter(
      (finding) => finding.ruleId === "propagation.package-mutation",
    );
  };

  test("stays quiet for an install hook that writes only into its own directory", () => {
    expect(
      findingsFor(
        "const path = require('path');\nconst tmp = path.join(__dirname, 'npm-install');\nfs.writeFileSync(path.join(tmp, 'package.json'), '{}');\nconst bin = path.join(tmp, 'node_modules', '@x/bin', 'x');\nfs.renameSync(bin, path.join(__dirname, 'bin', 'x'));\n",
      ),
    ).toEqual([]);
  });

  test("stays quiet for the esbuild-shaped installer", () => {
    expect(findingsFor(ESBUILD_SHAPED)).toEqual([]);
  });

  test("fires on the install-root literal line for a write into a sibling package", () => {
    expect(
      findingsFor(
        "const fs = require('fs');\nconst target = path.join(process.cwd(), 'node_modules', 'left-pad', 'index.js');\nfs.writeFileSync(target, payload);\n",
      ),
    ).toEqual([expect.objectContaining({ severity: "high", file: "install.js", line: 2 })]);
  });

  test.each([
    "const path = require('path');\nconst root = path.resolve(__dirname, '..', '..');\nfs.writeFileSync(path.join(root, 'left-pad', 'index.js'), hook);\n",
    "fs.writeFileSync(require.resolve('left-pad'), hook);\n",
    "process.chdir(process.env.INIT_CWD);\nfs.writeFileSync('node_modules/left-pad/index.js', hook);\n",
    "fs.writeFileSync(path.join(module.paths[1], 'left-pad', 'index.js'), hook);\n",
    "execSync(`cp hook.js ${process.env.INIT_CWD}/node_modules/left-pad/index.js`);\n",
  ])("fires when the file climbs to the install root without naming it: %#", (installJs) => {
    expect(findingsFor(installJs)).toEqual([
      expect.objectContaining({ severity: "high", file: "install.js" }),
    ]);
  });

  test("fires when the destination comes from a sibling module that reaches the install root", () => {
    const paths = file(
      "paths.js",
      "const path = require('path');\nexports.target = path.join(__dirname, '..', 'left-pad', 'index.js');\n",
    );
    expect(
      findingsFor(
        "const { target } = require('./paths');\nfs.writeFileSync(target, hook);\n",
        [],
        [paths],
      ),
    ).toEqual([expect.objectContaining({ severity: "high", file: "install.js" })]);
  });

  test("fires on a sibling walk that climbs out with a single dirname and never names the root", () => {
    expect(
      findingsFor(
        "const fs = require('fs');\nconst path = require('path');\nconst parent = path.dirname(__dirname);\nfor (const name of fs.readdirSync(parent)) fs.appendFileSync(path.join(parent, name, 'index.js'), hook);\n",
      ),
    ).toEqual([expect.objectContaining({ severity: "high", file: "install.js", line: 4 })]);
  });

  test("stays quiet when an unproven destination has nothing to do with the install root", () => {
    expect(findingsFor("fs.writeFileSync(process.argv[2], report);\n")).toEqual([]);
  });

  test.each([
    "const helpers = require('../shared/helpers');\nimport { log } from '../log.js';\nfs.writeFileSync(process.argv[2], report);\n",
    "if (rel.startsWith('..') || rel.split('/').includes('..')) throw new Error('outside');\nfs.writeFileSync(dest, report);\n",
    "const path = require('path');\nconst template = path.join(__dirname, 'lib', '..', 'templates', 'a.txt');\nfs.writeFileSync(dest, fs.readFileSync(template));\n",
    "const path = require('path');\nconst types = require.resolve('./lib/types.js');\nfs.writeFileSync(dest, types);\n",
  ])(
    "does not count own-module loads, traversal guards, or in-package `..` as a climb: %#",
    (installJs) => {
      expect(findingsFor(installJs)).toEqual([]);
    },
  );

  test("follows TypeScript CommonJS interop calls to the install root", () => {
    expect(
      findingsFor(
        'const fs_1 = require("fs");\nconst path_1 = require("path");\n(0, fs_1.writeFileSync)((0, path_1.join)(__dirname, "..", "left-pad", "index.js"), hook);\n',
      ),
    ).toEqual([expect.objectContaining({ severity: "high", file: "install.js", line: 3 })]);
  });

  test.each([
    [
      "a symlink into its own dir",
      "const fs = require('fs');\nconst path = require('path');\nfs.symlinkSync(path.join(__dirname, '..', '..', 'node_modules', 'react'), path.join(__dirname, 'vendor'));\nfs.appendFileSync(path.join(__dirname, 'vendor', 'index.js'), p);\n",
    ],
    [
      "a relative symlink",
      "const fs = require('fs');\nfs.symlinkSync('../../node_modules', 'nm');\nfs.appendFileSync('nm/react/index.js', p);\n",
    ],
    [
      "fs.promises.symlink",
      "const fs = require('fs');\nconst path = require('path');\nawait fs.promises.symlink('../../node_modules/react', path.join(__dirname, 'vendor'));\nawait fs.promises.appendFile(path.join(__dirname, 'vendor', 'index.js'), p);\n",
    ],
    [
      "a symlink to the global npm",
      "const fs = require('fs');\nconst path = require('path');\nfs.symlinkSync('/usr/lib/node_modules/npm', path.join(__dirname, 'g'));\nfs.appendFileSync(path.join(__dirname, 'g', 'index.js'), p);\n",
    ],
    [
      "a shell symlink",
      "const { execSync } = require('child_process');\nexecSync('ln -s ../../node_modules/react vendor');\nrequire('fs').appendFileSync('vendor/index.js', p);\n",
    ],
    [
      "a hardlink to a sibling file",
      "const fs = require('fs');\nconst path = require('path');\nconst own = path.join(__dirname, 'h.js');\nfs.linkSync(path.join(__dirname, '..', 'react', 'index.js'), own);\nfs.appendFileSync(own, p);\n",
    ],
    [
      "a hardlink renamed in one function and written in a later one",
      "const fs = require('fs');\nconst path = require('path');\nconst own = path.join(__dirname, 'h.js');\nfunction a() { const tmp = path.join(__dirname, 't'); fs.linkSync(require.resolve('react'), tmp); fs.renameSync(tmp, own); }\nfunction b() { fs.appendFileSync(own, p); }\na();\nb();\n",
    ],
    [
      "a hardlink written from a callback",
      "const fs = require('fs');\nconst path = require('path');\nconst own = path.join(__dirname, 'h.js');\nfunction b() { fs.appendFileSync(own, p); }\nsetTimeout(b, 10);\nfs.linkSync(require.resolve('react'), own);\n",
    ],
    [
      "a TMPDIR redirect",
      "const fs = require('fs');\nconst os = require('os');\nconst path = require('path');\nprocess.env.TMPDIR = path.resolve(__dirname, '..', '..', 'node_modules', 'react');\nfs.appendFileSync(path.join(os.tmpdir(), 'index.js'), p);\n",
    ],
    [
      "a HOME redirect",
      "const fs = require('fs');\nconst os = require('os');\nconst path = require('path');\nprocess.env['HOME'] = path.resolve(__dirname, '..', '..', 'node_modules', 'react');\nfs.appendFileSync(path.join(os.homedir(), 'index.js'), p);\n",
    ],
    [
      "a TMPDIR from INIT_CWD",
      "const fs = require('fs');\nconst os = require('os');\nprocess.env.TMPDIR = process.env.INIT_CWD + '/node_modules/react';\nfs.appendFileSync(os.tmpdir() + '/index.js', p);\n",
    ],
    [
      "an aliased chdir",
      "const fs = require('fs');\nconst { chdir: go } = process;\ngo('../../node_modules/react');\nfs.appendFileSync('index.js', p);\n",
    ],
    [
      "a Reflect.apply chdir",
      "const fs = require('fs');\nReflect.apply(process.chdir, process, ['../../node_modules/react']);\nfs.appendFileSync(require('path').join(process.cwd(), 'index.js'), p);\n",
    ],
    [
      "an ~/.npmrc registry hijack",
      "const fs = require('fs');\nconst os = require('os');\nconst path = require('path');\nfs.appendFileSync(path.join(os.homedir(), '.npmrc'), 'registry=https://evil.example/\\n');\n",
    ],
    [
      "a shell rc append",
      "const fs = require('fs');\nconst os = require('os');\nfs.appendFileSync(`${os.homedir()}/.bashrc`, 'node ~/.x/run.js\\n');\n",
    ],
  ])("fires on %s", (_label, installJs) => {
    expect(
      analyzeInstallWrites(installJs, { filePath: "install.js", packageName: "pkg" }).unproven,
    ).toBe(true);
    expect(findingsFor(installJs)).toEqual([
      expect.objectContaining({ severity: "high", file: "install.js" }),
    ]);
  });

  test.each([
    "const fs = require('fs');\nconst path = require('path');\nfs.symlinkSync('lib/cli.js', path.join(__dirname, 'bin', 'cli'));\nfs.writeFileSync(path.join(__dirname, 'bin', 'version'), v);\n",
    "const fs = require('fs');\nconst os = require('os');\nconst path = require('path');\nspawnSync('node', ['x.js'], { env: { ...process.env, FORCE_COLOR: '1' } });\nconst { HOME } = process.env;\nfs.writeFileSync(path.join(os.tmpdir(), 'pkg-cache.json'), data);\n",
    "const fs = require('fs');\nconst os = require('os');\nconst path = require('path');\nfs.mkdirSync(path.join(os.homedir(), '.cache', 'pkg'), { recursive: true });\nfs.writeFileSync(path.join(os.homedir(), '.cache', 'pkg', 'bin'), data);\n",
    // esbuild's shape: the override that writes the binary runs and returns
    // before the step that hardlinks a sibling's binary over it.
    "const fs = require('fs');\nconst path = require('path');\nconst toPath = path.join(__dirname, 'bin', 'x');\nfunction override() { fs.writeFileSync(toPath, shim); }\nfunction optimize() { const tmp = path.join(__dirname, 'bin-x'); fs.linkSync(require.resolve('@x/bin/x'), tmp); fs.renameSync(tmp, toPath); }\nfunction main() { if (env) { override(); return; } optimize(); }\nmain();\n",
  ])(
    "proves an own-dir symlink, an env read, a home cache write, a write before a link: %#",
    (installJs) => {
      expect(
        analyzeInstallWrites(installJs, { filePath: "install.js", packageName: "pkg" }),
      ).toEqual(expect.objectContaining({ unproven: false, intoInstallRoot: false }));
    },
  );

  test("keeps the co-occurrence verdict when the sample was truncated", () => {
    expect(
      findingsFor(
        "const nm = 'node_modules';\nfs.writeFileSync(path.join(__dirname, 'own.txt'), 'x');\n",
        ["truncated"],
      ),
    ).toHaveLength(1);
  });

  test("follows constant-folded install-root paths and marks them obfuscated", () => {
    expect(
      findingsFor(
        "const root = path.join(process.cwd(), 'node' + '_modules');\nfs.writeFileSync(path.join(root, 'left-pad', 'index.js'), payload);\n",
      ),
    ).toEqual([expect.objectContaining({ obfuscated: true })]);
  });
});
