import { describe, expect, test } from "vitest";
import { createPackageDiff, deterministicFindings } from "../server/lib/review";

// Install-time writes are scored by co-occurrence: an install-root reference
// and a write in the same install-time source. These pin the write shapes that
// earlier attempts to prove a destination stays in the package missed, so a
// future narrowing has to keep them high.
const file = (path: string, textSample: string) => ({
  path,
  size: textSample.length,
  sha256: path,
  flags: [] as string[],
  textSample,
});

const findingsFor = (
  installJs: string,
  extra: ReturnType<typeof file>[] = [],
  scripts: Record<string, string> = { postinstall: "node install.js" },
) => {
  const staged = [
    file("package.json", JSON.stringify({ name: "pkg", main: "lib/main.js", scripts })),
    file("install.js", installJs),
    ...extra,
  ];
  return deterministicFindings(staged, createPackageDiff([], staged)).filter(
    (finding) => finding.ruleId === "propagation.package-mutation",
  );
};

const PRELUDE =
  "const fs = require('fs');\nconst path = require('path');\nconst SRC = path.join(__dirname, '..', '..', 'node_modules', 'react', 'index.js');\nconst own = path.join(__dirname, 'h.js');\n";

describe("propagation.package-mutation", () => {
  test.each([
    [
      "a sibling package write",
      "fs.writeFileSync(path.join(process.cwd(), 'node_modules', 'left-pad', 'index.js'), p);\n",
    ],
    [
      "a template destination",
      "for (const n of names) fs.writeFileSync(`../node_modules/${n}/.hook.js`, hook);\n",
    ],
    [
      "a chdir to INIT_CWD",
      "process.chdir(process.env.INIT_CWD);\nfs.writeFileSync('node_modules/left-pad/index.js', hook);\n",
    ],
    [
      "a module.paths write",
      "fs.writeFileSync(path.join(module.paths[1], 'node_modules', 'left-pad', 'index.js'), hook);\n",
    ],
    [
      "a constant-folded root",
      "const root = path.join(process.cwd(), 'node' + '_modules');\nfs.writeFileSync(path.join(root, 'left-pad', 'index.js'), payload);\n",
    ],
  ])("fires on %s", (_label, installJs) => {
    expect(findingsFor(installJs)).toEqual([
      expect.objectContaining({ severity: "high", file: "install.js" }),
    ]);
  });

  // Each body runs after PRELUDE, which names the install root.
  test.each([
    ["a hardlink to a sibling file", "fs.linkSync(SRC, own);\nfs.appendFileSync(own, p);\n"],
    [
      "a symlink through promises",
      "await fs.promises.symlink(SRC, own);\nawait fs.promises.appendFile(own, p);\n",
    ],
    ["a shell ln", "execSync('ln -s ../react h');\nfs.appendFileSync(own, p);\n"],
    [
      "a shell ln with a cwd option",
      "execSync('ln -s ../react ../h', { cwd: path.join(__dirname, 'lib') });\nfs.appendFileSync(own, p);\n",
    ],
    [
      "a shell cd before a copy",
      "execSync('cd .. && cp pkg/payload.js react/index.js');\nfs.appendFileSync(own, p);\n",
    ],
    [
      "a subshell cd before a copy",
      "execSync('(cd .. && ln -s react pkg/h.js)');\nfs.appendFileSync(own, p);\n",
    ],
    ["a cp -t", "execSync('cp -t ../react payload.js');\nfs.appendFileSync(own, p);\n"],
    [
      "an env-prefixed copy",
      "execSync('env X=1 nice ln -s ../react h');\nfs.appendFileSync(own, p);\n",
    ],
    [
      "exec options in a variable",
      "const o = { cwd: '..' };\nexecSync('ln -s react pkg/h.js', o);\nfs.appendFileSync(own, p);\n",
    ],
    [
      "an aliased exec",
      "const run = require('child_process').execSync;\nrun('ln -s ../react h');\nfs.appendFileSync(own, p);\n",
    ],
    [
      "a reversed fs member name",
      "fs['cnySknil'.split('').reverse().join('')](SRC, own);\nfs.appendFileSync(own, p);\n",
    ],
    [
      "a base64 fs member name",
      "fs[Buffer.from('bGlua1N5bmM=', 'base64').toString()](SRC, own);\nfs.appendFileSync(own, p);\n",
    ],
    [
      "fs members from Object.entries",
      "const l = Object.fromEntries(Object.entries(fs)).linkSync;\nl(SRC, own);\nfs.appendFileSync(own, p);\n",
    ],
    ["a WriteStream", "new fs.WriteStream(SRC).end(p);\nfs.appendFileSync(own, p);\n"],
    ["shelljs", "require('shelljs').ln('-s', '../react', 'h');\nfs.appendFileSync(own, p);\n"],
    [
      "write-file-atomic",
      "require('write-file-atomic').sync(SRC, p);\nfs.appendFileSync(own, p);\n",
    ],
    [
      "tar extracting a link",
      "require('tar').x({ file: 'links.tgz', cwd: __dirname, sync: true });\nfs.appendFileSync(own, p);\n",
    ],
    [
      "npx creating a link",
      "execSync('npx -y symlink-dir ../react h');\nfs.appendFileSync(own, p);\n",
    ],
    ["mklink", "execSync('mklink /J h ..\\\\react');\nfs.appendFileSync(own, p);\n"],
    ["node -e writing", "execSync(`node -e \"require('fs').appendFileSync('${SRC}', 'x')\"`);\n"],
    [
      "a forked non-js linker",
      "require('child_process').fork(path.join(__dirname, 'l.dat'));\nfs.appendFileSync(own, p);\n",
    ],
    [
      "a class field write after a link",
      "class A { x = fs.appendFileSync(own, p); }\nfs.linkSync(SRC, own);\nnew A();\n",
    ],
    [
      "a recursive IIFE",
      "(function w(n) { if (n) { fs.appendFileSync(own, p); return; } fs.linkSync(SRC, own); w(1); })(0);\n",
    ],
    [
      "a default parameter",
      "function w() { fs.appendFileSync(own, p); }\nfunction g(b = w()) { return b; }\nfs.linkSync(SRC, own);\ng();\n",
    ],
    [
      "a getter",
      "const o = { get v() { fs.appendFileSync(own, p); return 1; } };\nfs.linkSync(SRC, own);\nconsole.log(o.v);\n",
    ],
    [
      "a Proxy get trap",
      "const o = new Proxy({}, { get() { fs.appendFileSync(own, p); } });\nfs.linkSync(SRC, own);\nconsole.log(o.x);\n",
    ],
    [
      "an implicit toString",
      "const o = { toString() { fs.appendFileSync(own, p); return ''; } };\nfs.linkSync(SRC, own);\nconsole.log('' + o);\n",
    ],
    ["a symlink renamed into place", "fs.renameSync(SRC, own);\nfs.appendFileSync(own, p);\n"],
    [
      "a symlink copied without dereference",
      "fs.cpSync(SRC, own, { dereference: false });\nfs.appendFileSync(own, p);\n",
    ],
    [
      "a TMPDIR redirect",
      "process.env.TMPDIR = path.dirname(SRC);\nfs.appendFileSync(path.join(require('os').tmpdir(), 'index.js'), p);\n",
    ],
    [
      "an aliased chdir",
      "const { chdir: go } = process;\ngo(path.dirname(SRC));\nfs.appendFileSync('index.js', p);\n",
    ],
  ])("fires on %s", (_label, body) => {
    expect(findingsFor(`${PRELUDE}${body}`)).toEqual([
      expect.objectContaining({ severity: "high", file: "install.js" }),
    ]);
  });

  test("fires on a write in a module the hook requires", () => {
    const helper = file(
      "helper.js",
      `${PRELUDE}fs.symlinkSync('../react', path.join(__dirname, 'h'));\nfs.writeFileSync(path.join(__dirname, 'h', 'index.js'), p);\n`,
    );
    expect(findingsFor("require('./helper');\n", [helper])).toEqual([
      expect.objectContaining({ severity: "high", file: "helper.js" }),
    ]);
  });

  test("fires when a shell lifecycle file makes the link", () => {
    const linker = file("link.sh", "ln -s ../react h.js\n");
    expect(
      findingsFor(`${PRELUDE}fs.appendFileSync(own, p);\n`, [linker], {
        preinstall: "sh link.sh",
        postinstall: "node install.js",
      }),
    ).toEqual([expect.objectContaining({ severity: "high", file: "install.js" })]);
  });

  test("fires on a lifecycle node -e that writes into the install root", () => {
    expect(
      findingsFor("", [], {
        postinstall:
          "node -e \"require('fs').appendFileSync('../../node_modules/react/index.js', 'x')\"",
      }),
    ).toEqual([expect.objectContaining({ severity: "high", file: "package.json" })]);
  });
});
