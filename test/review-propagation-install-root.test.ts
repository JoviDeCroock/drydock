import { describe, expect, test } from "vitest";
import { createPackageDiff, deterministicFindings } from "../server/lib/review";
import { writesIntoInstallRoot } from "../server/lib/review/rules/install-root-writes";

const INSTALL_ROOT = [/\bnode_modules\b/];
const writes = (source: string) => writesIntoInstallRoot(source, INSTALL_ROOT);

describe("writesIntoInstallRoot", () => {
  test.each([
    {
      name: "a literal install-root destination",
      source:
        "const fs = require('fs');\nfs.writeFileSync('node_modules/left-pad/index.js', payload);\n",
    },
    {
      name: "a template destination naming node_modules",
      source: "for (const n of names) writeFileSync(`../node_modules/${n}/.hook.js`, hook);\n",
    },
    {
      name: "a multi-line path.join alias chain without semicolons",
      source: [
        "const root = path.join(",
        "  process.cwd(),",
        "  'node_modules'",
        ")",
        "const target = path.join(root, 'left-pad')",
        "const file = path.join(target, 'index.js')",
        "fs.appendFileSync(file, payload)",
      ].join("\n"),
    },
    {
      name: "a destructured binding",
      source:
        "const { modules } = { modules: path.resolve(cwd, 'node_modules') };\nfs.writeFileSync(path.join(modules, 'x', 'index.js'), p);\n",
    },
    {
      name: "a for-of binding over the install root",
      source:
        "const nm = path.join(process.cwd(), 'node_modules');\nfor (const name of fs.readdirSync(nm)) {\n  const manifest = path.join(nm, name, 'package.json');\n  fs.writeFileSync(manifest, JSON.stringify(hooked));\n}\n",
    },
    {
      name: "a wrapper whose parameter a local call site fills with the install root",
      source:
        "function plant(dir) {\n  fs.writeFileSync(path.join(dir, 'index.js'), payload);\n}\nplant(path.join(process.cwd(), 'node_modules', 'left-pad'));\n",
    },
    {
      name: "a callback handed to a call over the install root",
      source:
        "fs.readdirSync(path.join(cwd, 'node_modules')).map((name) => path.join(cwd, 'x', name)).forEach((file) => fs.writeFileSync(file, payload));\n",
    },
    {
      name: "a named function handed to a call over the install root",
      source:
        "const root = 'node_modules';\nfunction plant(name) { fs.writeFileSync(name, payload); }\nfs.readdirSync(root).forEach(plant);\n",
    },
    {
      name: "a helper whose return value is the install root",
      source:
        "function modulesDir() { return path.join(process.env.INIT_CWD, 'node_modules'); }\nfs.writeFileSync(path.join(modulesDir(), 'x.js'), payload);\n",
    },
    {
      name: "a rename into the consumer's node_modules",
      source:
        "const fs = require('fs');\nfs.writeFileSync(path.join(tmp, 'package.json'), '{}');\nfs.renameSync(path.join(tmp, 'pkg'), path.resolve(process.env.INIT_CWD, 'node_modules', '@scope/pkg'));\n",
    },
    {
      name: "a member-assignment alias",
      source:
        "this.root = path.join(cwd, 'node_modules');\nfs.writeFileSync(path.join(this.root, 'a', 'index.js'), p);\n",
    },
    {
      name: "write code handed to another interpreter as a string",
      source:
        "execSync(\"node -e \\\"require('fs').writeFileSync(process.argv[1], 'x')\\\" \" + target);\nconst nm = 'node_modules';\n",
    },
    {
      name: "a sink aliased to another name",
      source:
        "const w = fs.writeFileSync;\nfs.writeFileSync(path.join(__dirname, 'ok'), '');\nw(path.join(cwd, 'node_modules', 'x', 'index.js'), p);\n",
    },
    {
      name: "a sink renamed on import",
      source:
        "import { writeFile as put } from 'node:fs/promises';\nconst nm = 'node_modules';\nawait put(`${nm}/x/index.js`, p);\n",
    },
    {
      name: "an unbalanced sink call",
      source: "const nm = 'node_modules';\nfs.writeFileSync(path.join(own, 'x'), (\n",
    },
  ])("flags $name", ({ source }) => {
    expect(writes(source)).toBe(true);
  });

  test("keeps an esbuild-shaped temp-dir install that only reads node_modules quiet", () => {
    const source = [
      "var toPath = path.join(__dirname, 'bin', 'esbuild');",
      "function installUsingNPM(pkg, subpath, binPath) {",
      "  const installDir = path.join(__dirname, 'npm-install');",
      "  fs.mkdirSync(installDir);",
      "  fs.writeFileSync(path.join(installDir, 'package.json'), '{}');",
      "  child_process.execSync(`npm install ${pkg}`, { cwd: installDir });",
      "  const installedBinPath = path.join(installDir, 'node_modules', pkg, subpath);",
      "  binaryIntegrityCheck(pkg, subpath, fs.readFileSync(installedBinPath));",
      "  fs.renameSync(installedBinPath, binPath);",
      "}",
      "function binaryIntegrityCheck(pkg, subpath, bytes) { verify(bytes); }",
      "async function downloadDirectlyFromNPM(pkg, subpath, binPath) {",
      "  const bytes = await fetch(url);",
      "  fs.writeFileSync(binPath, bytes);",
      "}",
      "function downloadedBinPath(pkg, subpath) {",
      "  return path.join(path.dirname(require.resolve('esbuild')), `downloaded-${pkg}`);",
      "}",
      "async function main() {",
      "  const binPath = downloadedBinPath(pkg, subpath);",
      "  try { installUsingNPM(pkg, subpath, binPath); }",
      "  catch { await downloadDirectlyFromNPM(pkg, subpath, binPath); }",
      "  fs.writeFileSync(toPath, shim);",
      "}",
      "main();",
    ].join("\n");
    expect(writes(source)).toBe(false);
  });

  test("keeps a pnpm-shaped realpath comparison against node_modules quiet", () => {
    const source = [
      "import { wrapperDir } from './native-binary.mjs'",
      "function rewriteBin (binMap) {",
      "  const pkgJsonPath = path.join(wrapperDir, 'package.json')",
      "  const tempPath = `${pkgJsonPath}.tmp`",
      "  fs.writeFileSync(tempPath, JSON.stringify(binMap))",
      "  fs.renameSync(tempPath, pkgJsonPath)",
      "}",
      "function findPrefix () {",
      "  const prefix = process.env.npm_config_local_prefix",
      "  let realModulesDir",
      "  try {",
      "    realModulesDir = fs.realpathSync(path.join(prefix, 'node_modules'))",
      "  } catch {",
      "    return null",
      "  }",
      "  const relative = path.relative(realModulesDir, wrapperDir)",
      "  if (relative.split(path.sep)[0] === '..') return null",
      "  return prefix",
      "}",
      "rewriteBin({ pnpm: 'pnpm.exe' })",
      "findPrefix()",
    ].join("\n");
    expect(writes(source)).toBe(false);
  });

  test.each([
    {
      name: "a wrapper only ever called with its own directory",
      source:
        "const nm = path.join(cwd, 'node_modules');\nconsole.log(fs.existsSync(nm));\nfunction plant(dir) { fs.writeFileSync(path.join(dir, 'index.js'), payload); }\nplant(path.join(__dirname, 'lib'));\n",
    },
    {
      name: "sinks imported or destructured under their own names",
      source:
        "import { mkdir, writeFile } from 'fs/promises';\nconst { writeFileSync } = require('fs');\nconst srcFiles = inputs.filter((p) => !p.includes(`${path.sep}node_modules${path.sep}`));\nawait writeFile(path.join(functionPath, 'package.json'), '{}');\nwriteFileSync(path.join(__dirname, 'out.json'), JSON.stringify(srcFiles));\n",
    },
    {
      name: "a callback over a list unrelated to the install root",
      source:
        "const nm = 'node_modules';\nconsole.log(nm);\n['a', 'b'].forEach((file) => fs.writeFileSync(path.join(__dirname, file), ''));\n",
    },
  ])("keeps $name quiet", ({ source }) => {
    expect(writes(source)).toBe(false);
  });

  test("treats a quadratic-shaped hostile file as writing instead of walking it", () => {
    const chain = Array.from({ length: 60_000 }, (_, index) => `a${index}`).join(" = ");
    const started = performance.now();
    expect(writes(`${chain} = own;\nfs.writeFileSync(a0, 'node_modules');\n`)).toBe(true);
    expect(performance.now() - started).toBeLessThan(10_000);
  }, 30_000);

  test("does not taint an exported helper's parameters from other modules", () => {
    const source =
      "const skip = (p) => p.includes(`${path.sep}node_modules${path.sep}`);\nexport async function emit(outDir) {\n  await writeFile(path.join(outDir, 'package.json'), '{}');\n}\n";
    expect(writes(source)).toBe(false);
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
  const findingsFor = (installJs: string, flags: string[] = []) => {
    const staged = [
      file("package.json", JSON.stringify({ scripts: { postinstall: "node install.js" } })),
      { ...file("install.js", installJs), flags },
    ];
    return deterministicFindings(staged, createPackageDiff([], staged)).filter(
      (finding) => finding.ruleId === "propagation.package-mutation",
    );
  };

  test("stays quiet for an install hook that writes only into its own directory", () => {
    expect(
      findingsFor(
        "const tmp = path.join(__dirname, 'npm-install');\nfs.writeFileSync(path.join(tmp, 'package.json'), '{}');\nconst bin = path.join(tmp, 'node_modules', '@x/bin', 'x');\nfs.renameSync(bin, path.join(__dirname, 'bin', 'x'));\n",
      ),
    ).toEqual([]);
  });

  test("fires on the install-root literal line for a write into a sibling package", () => {
    expect(
      findingsFor(
        "const fs = require('fs');\nconst target = path.join(process.cwd(), 'node_modules', 'left-pad', 'index.js');\nfs.writeFileSync(target, payload);\n",
      ),
    ).toEqual([expect.objectContaining({ severity: "high", file: "install.js", line: 2 })]);
  });

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
