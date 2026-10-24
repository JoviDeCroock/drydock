import { describe, expect, test } from "vitest";
import { createPackageDiff, deterministicFindings } from "../server/lib/review";
import {
  jsInstallRootWrite,
  packageDepth,
  shellArgvWrites,
  shellInstallRootWrite,
  shellWrites,
} from "../server/lib/review/rules/install-root-reach";

const PRELUDE = "const fs = require('fs');\nconst path = require('path');\n";
const CP = "const { execSync, execFileSync, spawnSync } = require('child_process');\n";

const writeAt = (source: string, depth = 0) => jsInstallRootWrite(`${PRELUDE}${source}`, depth);

describe("install-root position model", () => {
  test("measures a file's own directory depth below the package root", () => {
    expect(packageDepth("install.js")).toBe(0);
    expect(packageDepth("package/install.js")).toBe(0);
    expect(packageDepth("lib/x.js")).toBe(1);
    expect(packageDepth("package/scripts/setup/run.js")).toBe(2);
  });

  // Each destination is written on line 3, after PRELUDE.
  test.each([
    ["the parent of __dirname at the root", "path.join(path.dirname(__dirname), 'x')", 0],
    ["two dirname levels from depth 1", "path.dirname(path.dirname(__dirname)) + '/x'", 1],
    ["dirname of __filename twice at the root", "path.dirname(path.dirname(__filename))", 0],
    ["a join that climbs past the root", "path.join(__dirname, '..', 'react')", 0],
    ["a resolve that climbs from depth 1", "path.resolve(__dirname, '../..', 'x')", 1],
    ["process.cwd() with a parent segment", "path.resolve(process.cwd(), '..', 'x')", 2],
    ["a cwd-relative resolve", "path.resolve('../react')", 3],
    ["import.meta.dirname", "path.join(import.meta.dirname, '..', 'x')", 0],
    ["an ESM URL two levels up", "new URL('../../x', import.meta.url)", 1],
    ["a concatenated parent", "__dirname + '/../react'", 0],
    ["a renamed last segment", "__dirname + '-shadow'", 0],
    ["separator concatenation", "__dirname + path.sep + '..' + path.sep + 'react'", 0],
    ["a template parent", "`${__dirname}/../react`", 0],
    ["a nullish fallback that climbs", "process.env.X ?? path.dirname(__dirname)", 0],
    ["a parent with an unknown entry", "path.join(path.dirname(__dirname), name, 'index.js')", 0],
    ["a bare relative literal", "'../left-pad/index.js'", 0],
  ])("escapes through %s", (_label, destination, depth) => {
    expect(writeAt(`fs.writeFileSync(${destination}, p);\n`, depth)).toEqual({ line: 3 });
  });

  test.each([
    ["a sibling directory inside the package", "path.join(__dirname, '..', 'dist', 'x')", 1],
    ["the package root from depth 2", "path.resolve(__dirname, '../..', 'x')", 2],
    ["an in-package URL", "new URL('../templates/x', import.meta.url)", 1],
    ["an unknown base", "path.join(dir, '..', 'x')", 0],
    ["an absolute path", "path.join('/opt', '..', 'x')", 0],
    ["a renamed file name", "__filename + '.bak'", 0],
    ["a relative literal", "'dist/index.js'", 1],
  ])("stays inside for %s", (_label, destination, depth) => {
    expect(writeAt(`fs.writeFileSync(${destination}, p);\n`, depth)).toBeNull();
  });

  test("follows a binding chain to the destination", () => {
    expect(
      writeAt(
        "const up = path.dirname(__dirname);\nconst entry = path.join(up, name, 'index.js');\nfs.appendFileSync(entry, hook);\n",
      ),
    ).toEqual({ line: 5 });
  });

  test("follows a later assignment to a declared name", () => {
    expect(
      writeAt(
        "let entry;\nentry = path.join(__dirname, '..', 'react', 'index.js');\nfs.appendFileSync(entry, hook);\n",
      ),
    ).toEqual({ line: 5 });
    expect(
      writeAt("var a, b;\na = b = path.dirname(__dirname) + '/x';\nfs.writeFileSync(b, p);\n"),
    ).toEqual({
      line: 5,
    });
  });

  test.each([
    [
      "a named helper",
      "function plant(dir) {\n  fs.appendFileSync(path.join(dir, 'index.js'), hook);\n}\nfor (const n of fs.readdirSync(up)) plant(path.join(up, n));\n",
    ],
    [
      "an arrow helper",
      "const plant = (dir, body) => fs.appendFileSync(path.join(dir, 'index.js'), body);\nplant(path.join(up, 'left-pad'), hook);\n",
    ],
    [
      "an immediately invoked function",
      "(function (root) {\n  fs.writeFileSync(path.join(root, 'react', 'index.js'), hook);\n})(up);\n",
    ],
    [
      "a helper that hands its parameter to a shell copy",
      "const { execSync } = require('child_process');\nfunction put(dest) {\n  execSync(`cp payload.js ${dest}`);\n}\nput(path.join(up, 'left-pad', 'index.js'));\n",
    ],
  ])("follows an escaping argument into %s", (_label, body) => {
    expect(writeAt(`const up = path.dirname(__dirname);\n${body}`)).not.toBeNull();
  });

  test("keeps a helper's in-package arguments and shadowed names inside", () => {
    expect(
      writeAt(
        "function save(file, data) {\n  fs.writeFileSync(file, data);\n}\nsave(path.join(__dirname, 'cache.json'), '{}');\n",
      ),
    ).toBeNull();
    // A parameter shadows a same-named binding outside its function.
    expect(
      writeAt(
        "const dir = path.dirname(__dirname);\nfunction out(dir) {\n  fs.writeFileSync(path.join(dir, 'x'), p);\n}\nout(path.join(__dirname, 'dist'));\n",
      ),
    ).toBeNull();
    // Recursion through a parameter terminates.
    expect(
      writeAt(
        "function w(d, n) {\n  if (n) w(path.join(d, 'sub'), n - 1);\n  fs.mkdirSync(d);\n}\nw(__dirname, 3);\n",
      ),
    ).toBeNull();
  });

  test.each([
    [
      "a read of the consumer root beside an own-file write",
      "const root = process.env.INIT_CWD || path.resolve(__dirname, '../..');\nJSON.parse(fs.readFileSync(path.join(root, 'package.json')));\nfs.writeFileSync(path.join(__dirname, 'config.json'), '{}');\n",
    ],
    [
      "an existence check outside",
      "if (fs.existsSync(path.join(__dirname, '..', '..', 'package.json'))) fs.writeFileSync(path.join(__dirname, 'x'), '1');\n",
    ],
    [
      "a parent name bound to a variable",
      "const parent = path.dirname(__dirname);\nconst name = path.basename(parent);\nfs.writeFileSync(path.join(__dirname, name + '.json'), '{}');\n",
    ],
    [
      "a relative path computed against the parent",
      "const rel = path.relative(process.cwd(), path.dirname(__dirname));\nfs.writeFileSync(path.join(__dirname, 'rel.txt'), rel);\n",
    ],
    [
      "an ESM URL read",
      "const pkg = fs.readFileSync(new URL('../package.json', import.meta.url));\nfs.writeFileSync(new URL('cache.json', import.meta.url), pkg);\n",
    ],
    [
      "a directory listing outside",
      "for (const n of fs.readdirSync('..')) console.log(n);\nfs.writeFileSync('x', '1');\n",
    ],
    [
      "a copy out of a sibling into the package",
      "fs.copyFileSync('../react/index.js', 'copy.js');\n",
    ],
  ])("does not count escaping locations that no mutation writes: %s", (_label, source) => {
    expect(writeAt(source)).toBeNull();
  });

  test("anchors bare fs path literals at the package root cwd", () => {
    expect(writeAt("fs.writeFileSync('../left-pad/index.js', p);\n")).toEqual({ line: 3 });
    expect(writeAt("fs.writeFileSync('dist/index.js', p);\n", 1)).toBeNull();
  });

  test("moves the cwd with process.chdir", () => {
    expect(
      writeAt(
        `${CP}process.chdir(path.join(__dirname, 'native'));\nfs.cpSync('../lib', 'out', { recursive: true });\nexecSync('cp -r ../lib build/lib');\nfs.writeFileSync('../lib/gen.js', s);\n`,
      ),
    ).toBeNull();
    expect(writeAt("process.chdir('..');\nfs.writeFileSync('react/index.js', p);\n")).toEqual({
      line: 4,
    });
    expect(
      writeAt(
        `${CP}process.chdir(path.dirname(__dirname));\nexecSync('cp hook.js react/index.js');\n`,
      ),
    ).toEqual({ line: 5 });
    expect(
      writeAt(
        "const { chdir: go } = process;\ngo('..');\nfs.appendFileSync('react/index.js', p);\n",
      ),
    ).toEqual({ line: 5 });
    expect(
      writeAt(
        "process.chdir(path.join(__dirname, 'native'));\nfs.writeFileSync(path.join(process.cwd(), '..', 'lib', 'x'), s);\n",
      ),
    ).toBeNull();
    // An unplaceable chdir leaves later relative operands unplaced.
    expect(
      writeAt("process.chdir(process.env.INIT_CWD);\nfs.writeFileSync('../x', p);\n"),
    ).toBeNull();
  });

  test("resolves a symlink's relative target against the link's directory", () => {
    expect(writeAt("fs.symlinkSync('../react', path.join(__dirname, 'h'));\n")).toEqual({
      line: 3,
    });
    expect(
      writeAt("fs.symlinkSync('../dist/cli.js', path.join(__dirname, 'bin', 'cli'));\n"),
    ).toBeNull();
    expect(writeAt("fs.symlinkSync('../dist/cli.js', 'bin/cli');\n")).toBeNull();
    expect(writeAt("await fs.promises.symlink('../../react', 'lib/h');\n")).toEqual({ line: 3 });
  });

  test.each([
    ["a hard link to a sibling file", "fs.linkSync('../react/index.js', 'h.js');\n"],
    ["a rename into a sibling", "fs.renameSync('h.js', '../react/index.js');\n"],
    [
      "an fs-extra copy",
      "fse.copySync('payload.js', path.join(__dirname, '..', 'react', 'index.js'));\n",
    ],
    ["an fs-extra move out of a sibling", "fse.moveSync('../react/index.js', 'stolen.js');\n"],
    [
      "fs.cpSync",
      "fs.cpSync('payload', path.join(__dirname, '..', 'react'), { recursive: true });\n",
    ],
    ["fs.promises.cp", "await fs.promises.cp('payload.js', '../react/index.js');\n"],
    [
      "a destructured fs/promises cp",
      "const { cp } = require('fs/promises');\nawait cp('payload.js', '../react/index.js');\n",
    ],
    [
      "an imported rename",
      "import { rename as mv } from 'node:fs/promises';\nawait mv('h.js', '../react/index.js');\n",
    ],
    [
      "openSync for writing",
      "const fd = fs.openSync(path.join(__dirname, '..', 'react', 'index.js'), 'a');\nfs.writeSync(fd, p);\n",
    ],
    [
      "open with a write constant",
      "fs.open('../react/index.js', fs.constants.O_WRONLY | fs.constants.O_APPEND, cb);\n",
    ],
    ["a WriteStream", "new fs.WriteStream('../react/index.js').end(p);\n"],
  ])("treats %s as a write outside", (_label, source) => {
    expect(writeAt(source)).not.toBeNull();
  });

  test("ignores open for reading", () => {
    expect(writeAt("const fd = fs.openSync('../react/index.js', 'r');\n")).toBeNull();
    expect(writeAt("const fd = fs.openSync('../react/index.js');\n")).toBeNull();
  });

  test("reads exec commands, argv calls and their cwd option", () => {
    expect(writeAt(`${CP}execSync('cd .. && cp a.js react/index.js');\n`)).toEqual({ line: 4 });
    expect(
      writeAt(`${CP}execFileSync('cp', ['payload.js', '../other/index.js']);\n`),
    ).not.toBeNull();
    expect(writeAt(`${CP}spawnSync('sh', ['-c', 'ln -s ../react h']);\n`)).not.toBeNull();
    expect(
      writeAt(`${CP}execSync('ln -s ../react ../h', { cwd: path.join(__dirname, 'lib') });\n`),
    ).not.toBeNull();
    expect(
      writeAt(`${CP}execSync('ln -s ../react h', { cwd: path.join(__dirname, 'a', 'b') });\n`),
    ).toBeNull();
    expect(
      writeAt(`${CP}const run = require('child_process').execSync;\nrun('cp x ../y/z');\n`),
    ).toEqual({ line: 5 });
    expect(writeAt(`${CP}execSync('cp -r templates lib/templates');\n`)).toBeNull();
    expect(writeAt(`${CP}execSync(\`cp payload.js ../\${name}/index.js\`);\n`)).not.toBeNull();
    expect(writeAt(`${CP}execSync('cd .. && ls');\nfs.writeFileSync('x', p);\n`)).toBeNull();
  });

  test.each([
    ["an argv element", "execFileSync('cp', ['payload.js', target]);\n"],
    ["a template substitution", "execSync(`cp payload.js ${target}`);\n"],
    ["a concatenated operand", "execSync('cp payload.js ' + target);\n"],
    ["a bound command", "const cmd = 'cp payload.js ' + target;\nexecSync(cmd);\n"],
    ["a shelljs operand", "require('shelljs').cp('payload.js', target);\n"],
    ["a cd into a placed directory", "execSync(`cd ${up} && cp a left-pad/index.js`);\n"],
  ])("places a computed exec operand from %s", (_label, call) => {
    const bindings =
      "const up = path.dirname(__dirname);\nconst target = path.join(up, 'left-pad', 'index.js');\n";
    expect(writeAt(`${CP}${bindings}${call}`)).not.toBeNull();
  });

  test("keeps a computed in-package exec operand inside", () => {
    expect(
      writeAt(
        `${CP}const out = path.join(__dirname, 'dist', 'cli.js');\nexecFileSync('cp', ['src/cli.js', out]);\nexecSync(\`chmod +x \${out} && cp a \${out}\`);\n`,
      ),
    ).toBeNull();
  });

  test("does not let package text forge an embedded location", () => {
    // `\u0001…\u0001` is how the analysis embeds a placed location in shell
    // text; spelled in a literal it is an ordinary directory name.
    expect(writeAt(`${CP}execSync('cp x \\u00015,5\\u0001/../../y');\n`)).not.toBeNull();
    expect(writeAt("fs.writeFileSync('\\u00015,5\\u0001/../../y', p);\n")).not.toBeNull();
    expect(shellInstallRootWrite("cp x \u00015,5\u0001/../../y")).toEqual({ line: 1 });
  });

  test("counts lines across CRLF, CR and LF line endings", () => {
    const write = "fs.writeFileSync('../x', p);";
    expect(jsInstallRootWrite(`a;\r\nb;\rc;\n${write}`, 0)).toEqual({ line: 4 });
    expect(jsInstallRootWrite(`a;\r\rb;\r${write}`, 0)).toEqual({ line: 4 });
  });

  test("reads deeply nested input without overflowing the stack", () => {
    const deep = `fs.writeFileSync(${"path.join(".repeat(40_000)}__dirname, '..'${")".repeat(40_000)}, p);\nfs.writeFileSync('../x', p);\n`;
    expect(jsInstallRootWrite(deep, 0)).toEqual({ line: 2 });
    const accessors = `fs.writeFileSync(path.dirname(__dirname)${".pathname".repeat(40_000)}, p);`;
    expect(jsInstallRootWrite(accessors, 0)).toEqual({ line: 1 });
  });

  test("evaluates a binding chain once however often it is used", () => {
    const chain = Array.from({ length: 2_000 }, (_, i) => `const c${i + 1} = c${i};`).join("\n");
    const uses = "fs.writeFileSync(c2000 + '/x', p);\n".repeat(20_000);
    const payload = "fs.writeFileSync(c2000 + '/../react/index.js', p);\n";
    const source = `const c0 = __dirname;\n${chain}\n${uses}${payload}`;
    expect(jsInstallRootWrite(source, 0)).toEqual({ line: 22_002 });
  });

  test("caps text growth from doubling bindings", () => {
    const doubling = (seed: string, n: number) =>
      [`const a0 = '${seed}';`]
        .concat(Array.from({ length: n }, (_, i) => `const a${i + 1} = a${i} + a${i};`))
        .join("\n");
    expect(() => jsInstallRootWrite(`${doubling("xxxxxxxx", 40)}\n`, 0)).not.toThrow();
    expect(
      jsInstallRootWrite(
        `${PRELUDE}${doubling("xxxxxxx/", 40)}\nfs.writeFileSync(__dirname + '/' + a40, p);\nfs.writeFileSync('../x', p);\n`,
        0,
      ),
    ).toEqual({ line: 45 });
    const parts = (name: string) => Array.from({ length: 200 }, () => name).join(" + ");
    const shell = `${CP}const d = 'ab ';\nconst c = ${parts("d")};\nconst b = ${parts("c")};\nconst a = ${parts("b")};\nconst z = ${parts("a")};\nexecSync(z);\nexecFileSync('cp', [z, z, z]);\nexecSync('cp x ../y');\n`;
    expect(jsInstallRootWrite(shell, 0)).toEqual({ line: 9 });
  });

  // Quadratic or exponential work here shows up as a timeout, not a slow pass.
  test(
    "bounds work on long linear inputs and still reaches a trailing write",
    { timeout: 30_000 },
    () => {
      const payload = "\nfs.writeFileSync('../left-pad/index.js', p);\n";
      const inputs = [
        `${Array.from({ length: 60_000 }, (_, i) => `a${i % 1000}`).join("=")}=1;`,
        "var a = ".repeat(60_000),
        `const a = ${"x + ".repeat(60_000)}'../y';\nfs.writeFileSync(a, p);`,
        `fs.writeFileSync(f(${"a, ".repeat(60_000)}b), p);`,
        `fs.writeFileSync(${"path.join(".repeat(60)}__dirname, 'x'${")".repeat(60)}, p);\n`.repeat(
          1_000,
        ),
      ];
      for (const input of inputs)
        expect(jsInstallRootWrite(`${input}${payload}`, 0)).not.toBeNull();
    },
  );
});

describe("shell command positions", () => {
  test.each([
    ["cd then copy", "cd .. && cp pkg/payload.js react/index.js"],
    ["a subshell cd", "(cd .. && ln -s react pkg/h.js)"],
    ["cp -t", "cp -t ../react payload.js"],
    ["cp --target-directory=", "cp --target-directory=../react payload.js"],
    ["a wrapped ln", "env X=1 nice ln -s ../react h"],
    ["a parent redirect", "echo hook >> ../left-pad/index.js"],
    ["an fd redirect", "node gen.js 1> ../left-pad/index.js"],
    ["tee", "cat hook.js | tee -a ../left-pad/index.js"],
    ["sed in place", "sed -i 's/a/b/' ../left-pad/index.js"],
    ["mv out of a sibling", "mv ../react/index.js stolen.js"],
    ["a hard link to a sibling file", "ln ../react/index.js h.js"],
    ["a relative symlink", "ln -sr ../react h"],
    ["a symlink placed in a directory", "ln -s -t lib ../../react"],
    ["mklink to a sibling", "mklink /J h ..\\react"],
    ["mklink symlink from the link directory", "mklink lib\\h ..\\..\\react"],
    ["install into a sibling", "install -m 644 hook.js ../left-pad/index.js"],
    ["a link into a parent directory operand", "ln -s dist/cli.js .."],
  ])("writes outside for %s", (_label, command) => {
    expect(shellWrites(command, 0)).toBe(true);
  });

  test.each([
    ["an in-package bin link", "ln -s ../dist/cli.js bin/cli"],
    ["an in-package copy", "cp -r templates lib/templates"],
    ["a subshell cd that is restored", "(cd native && make) && cp native/out.node build/out.node"],
    ["a descending cd", "cd scripts && cp ../templates/a.json ../dist/a.json"],
    ["a source read from outside", "cp ../shared/config.json config.json"],
    ["an absolute destination", "cp hook.js /tmp/hook.js"],
    ["a variable destination", "cp hook.js $OUT/hook.js"],
    ["stderr dup", "node build.js 2>&1"],
    ["rsync's preserve-times flag", "rsync -avt src/ dist/"],
    ["a quoted operator", "echo 'cd .. && cp a ../b'"],
    ["a link into the current directory", "ln -s dist/cli.js ."],
    ["a forced link into ./", "ln -sf dist/cli.js ./"],
    ["a link into a directory operand", "ln -s ../dist/cli.js bin/"],
    ["a climbing cd without a write", "cd .. && ls"],
    ["an unplaced cd", "cd $DIR && cp a ../b"],
  ])("stays inside for %s", (_label, command) => {
    expect(shellWrites(command, 0)).toBe(false);
  });

  test("starts from the exec cwd", () => {
    expect(shellWrites("ln -s ../react ../h", 1)).toBe(true);
    expect(shellWrites("ln -s ../react h", 2)).toBe(false);
    expect(shellWrites("cp a b", -1)).toBe(true);
    expect(shellWrites("cp a ../b", null)).toBe(false);
  });

  test("keeps the lowest position of a cwd that climbed and came back", () => {
    expect(shellWrites("cd .. && cd pkg && cp a b", 0)).toBe(true);
  });

  test("reads argv-form commands", () => {
    expect(shellArgvWrites(["cp", "payload.js", "../other/index.js"], 0)).toBe(true);
    expect(shellArgvWrites(["ln", "-s", "../dist/cli.js", "bin/cli"], 0)).toBe(false);
  });

  test("reports lifecycle writes on the command line", () => {
    expect(shellInstallRootWrite("cp hook.js ../left-pad/index.js")).toEqual({ line: 1 });
    expect(shellInstallRootWrite("cd .. && ls")).toBeNull();
  });
});

// End to end: hook-reachable sources that never name `node_modules`. Every
// install hook is already `install-script.lifecycle` (high), so the benign
// shapes here pin the propagation rule itself rather than the risk roll-up.
describe("propagation.package-mutation without an install-root literal", () => {
  const file = (path: string, textSample: string) => ({
    path,
    size: textSample.length,
    sha256: path,
    flags: [] as string[],
    textSample,
  });
  const mutations = (files: ReturnType<typeof file>[], scripts: Record<string, string>) => {
    const staged = [file("package.json", JSON.stringify({ name: "pkg", scripts })), ...files];
    return deterministicFindings(staged, createPackageDiff([], staged)).filter(
      (finding) => finding.ruleId === "propagation.package-mutation",
    );
  };

  test("fires on a lifecycle command that copies into a sibling", () => {
    expect(mutations([], { postinstall: "cp hook.js ../left-pad/index.js" })).toEqual([
      expect.objectContaining({ severity: "high", file: "package.json", line: 1 }),
    ]);
  });

  test("fires on a depth-1 setup script that climbs two directories", () => {
    const setup = file(
      "scripts/setup.js",
      `${PRELUDE}const root = path.dirname(path.dirname(__dirname));\nfor (const n of fs.readdirSync(root)) fs.appendFileSync(path.join(root, n, 'index.js'), hook);\n`,
    );
    expect(mutations([setup], { postinstall: "node scripts/setup.js" })).toEqual([
      expect.objectContaining({ severity: "high", file: "scripts/setup.js", line: 4 }),
    ]);
  });

  test("marks an escape only the folded text shows as obfuscated", () => {
    const install = file(
      "install.js",
      `${PRELUDE}const up = path['dir' + 'name'](__dirname);\nfs.appendFileSync(path.join(up, 'react', 'index.js'), hook);\n`,
    );
    expect(mutations([install], { postinstall: "node install.js" })).toEqual([
      expect.objectContaining({ file: "install.js", obfuscated: true }),
    ]);
  });

  test.each([
    [
      "a postinstall writing build output beside its script",
      { postinstall: "node scripts/postinstall.js" },
      [
        file(
          "scripts/postinstall.js",
          `${PRELUDE}const out = path.join(__dirname, '..', 'dist');\nfs.mkdirSync(out, { recursive: true });\nfs.writeFileSync(path.join(out, 'config.json'), '{}');\n`,
        ),
      ],
    ],
    ["a postinstall bin link", { postinstall: "ln -s ../dist/cli.js bin/cli" }, []],
    ["an in-package template copy", { install: "cp -r templates lib/templates" }, []],
    [
      "an ESM hook writing next to itself",
      { postinstall: "node lib/hook.mjs" },
      [
        file(
          "lib/hook.mjs",
          "import { writeFileSync } from 'node:fs';\nconst out = new URL('../dist/', import.meta.url);\nwriteFileSync(new URL('version.txt', out), '1');\n",
        ),
      ],
    ],
    [
      "a dependency-install check beside an own-file write",
      { postinstall: "node install.js" },
      [
        file(
          "install.js",
          `${PRELUDE}const inMonorepo = path.basename(path.dirname(__dirname)) === 'packages';\nif (inMonorepo) fs.writeFileSync(path.join(__dirname, 'dev.flag'), '1');\n`,
        ),
      ],
    ],
    [
      "a read of the consumer root beside an own-file write",
      { postinstall: "node install.js" },
      [
        file(
          "install.js",
          `${PRELUDE}const root = process.env.INIT_CWD || path.resolve(__dirname, '../..');\nJSON.parse(fs.readFileSync(path.join(root, 'package.json')));\nfs.writeFileSync(path.join(__dirname, 'config.json'), '{}');\n`,
        ),
      ],
    ],
    [
      "an existence check two levels up",
      { postinstall: "node install.js" },
      [
        file(
          "install.js",
          `${PRELUDE}const nested = fs.existsSync(path.join(__dirname, '..', '..', 'package.json'));\nfs.writeFileSync(path.join(__dirname, 'nested.flag'), String(nested));\n`,
        ),
      ],
    ],
    [
      "a parent name bound to a variable",
      { postinstall: "node install.js" },
      [
        file(
          "install.js",
          `${PRELUDE}const parent = path.dirname(__dirname);\nconst scope = path.basename(parent);\nfs.writeFileSync(path.join(__dirname, 'scope.txt'), scope);\n`,
        ),
      ],
    ],
    [
      "a path relative to the cwd",
      { postinstall: "node install.js" },
      [
        file(
          "install.js",
          `${PRELUDE}const rel = path.relative(process.cwd(), path.resolve(__dirname, '..'));\nfs.writeFileSync(path.join(__dirname, 'rel.txt'), rel);\n`,
        ),
      ],
    ],
    [
      "an ESM read of the parent directory",
      { postinstall: "node hook.mjs" },
      [
        file(
          "hook.mjs",
          "import { readdirSync, writeFileSync } from 'node:fs';\nconst siblings = readdirSync(new URL('..', import.meta.url));\nwriteFileSync(new URL('./siblings.json', import.meta.url), JSON.stringify(siblings));\n",
        ),
      ],
    ],
    ["a bin link into the current directory", { postinstall: "ln -s dist/cli.js ." }, []],
    ["a forced link into ./", { postinstall: "ln -sf dist/cli.js ./" }, []],
    [
      "a chdir into a native directory before a parent copy",
      { install: "node build.js" },
      [
        file(
          "build.js",
          `${PRELUDE}const { execSync } = require('child_process');\nprocess.chdir(path.join(__dirname, 'native'));\nexecSync('cp -r ../lib ./lib');\nfs.cpSync('../lib', 'vendor', { recursive: true });\n`,
        ),
      ],
    ],
  ])("stays quiet for %s", (_label, scripts, files) => {
    expect(mutations(files, scripts)).toEqual([]);
  });

  test("fires on a computed argv destination", () => {
    const install = file(
      "install.js",
      `${PRELUDE}const { execFileSync } = require('child_process');\nconst target = path.join(__dirname, '..', 'left-pad', 'index.js');\nexecFileSync('cp', ['payload.js', target]);\n`,
    );
    expect(mutations([install], { postinstall: "node install.js" })).toEqual([
      expect.objectContaining({ severity: "high", file: "install.js", line: 5 }),
    ]);
  });
});
