import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  DETONATION_PYTHON,
  encodePyPiPrepareBundle,
  readPyPiProvenance,
  selectPyPiDetonationArtifacts,
  wheelScore,
  type PyPiProvenanceArtifact,
} from "../server/lib/detonation/pypi";

const harness = await import("../containers/detonation/pypi.mjs");

const SHA = "a".repeat(64);
const bytes = (text: string) => new TextEncoder().encode(text);

function provenance(paths: string[]): PyPiProvenanceArtifact[] {
  return paths.map((path) => ({
    path,
    kind: path.endsWith(".whl") ? "wheel" : "sdist",
    sha256: SHA,
  }));
}

describe("PyPI prepare bundle", () => {
  test("round-trips from the parent's encoder to the harness decoder", () => {
    const encoded = encodePyPiPrepareBundle([
      { name: "demo-1.0.0-py3-none-any.whl", kind: "wheel", bytes: bytes("wheel bytes") },
      { name: "demo-1.0.0.tar.gz", kind: "sdist", bytes: bytes("sdist") },
    ]);
    const decoded = harness.decodePyPiBundle(Buffer.from(encoded));
    expect(
      decoded?.map((file) => [file.name, file.kind, new TextDecoder().decode(file.bytes)]),
    ).toEqual([
      ["demo-1.0.0-py3-none-any.whl", "wheel", "wheel bytes"],
      ["demo-1.0.0.tar.gz", "sdist", "sdist"],
    ]);
  });

  test.each([
    ["a path instead of a filename", "../demo-1.0.0-py3-none-any.whl", "wheel"],
    ["a nested path", "dist/demo-1.0.0-py3-none-any.whl", "wheel"],
    ["a wheel name that is not PEP 427", "demo.whl", "wheel"],
    ["an sdist with the wrong suffix", "demo-1.0.0.zip", "sdist"],
    ["a dotfile", ".pth-1.0.0.tar.gz", "sdist"],
  ] as const)("refuses %s", (_name, name, kind) => {
    const encoded = encodePyPiPrepareBundle([{ name, kind, bytes: bytes("x") }]);
    expect(harness.decodePyPiBundle(Buffer.from(encoded))).toBeNull();
  });

  test("refuses two files of one kind, trailing bytes, and short bodies", () => {
    const two = encodePyPiPrepareBundle([
      { name: "a-1.0.0-py3-none-any.whl", kind: "wheel", bytes: bytes("x") },
      { name: "b-1.0.0-py3-none-any.whl", kind: "wheel", bytes: bytes("y") },
    ]);
    expect(harness.decodePyPiBundle(Buffer.from(two))).toBeNull();
    const one = encodePyPiPrepareBundle([
      { name: "a-1.0.0-py3-none-any.whl", kind: "wheel", bytes: bytes("x") },
    ]);
    expect(
      harness.decodePyPiBundle(Buffer.concat([Buffer.from(one), Buffer.from("!")])),
    ).toBeNull();
    expect(harness.decodePyPiBundle(Buffer.from(one).subarray(0, one.length - 1))).toBeNull();
    expect(harness.decodePyPiBundle(Buffer.alloc(3))).toBeNull();
  });
});

describe("wheel selection for the sandbox interpreter", () => {
  test("prefers the exact CPython ABI on a manylinux x86-64 platform, as pip would", () => {
    const selection = selectPyPiDetonationArtifacts(
      provenance([
        "dist/pkg-1.0-py3-none-any.whl",
        "dist/pkg-1.0-cp311-abi3-manylinux_2_17_x86_64.manylinux2014_x86_64.whl",
        "dist/pkg-1.0-cp311-cp311-manylinux_2_28_x86_64.whl",
        "dist/pkg-1.0.tar.gz",
      ]),
    );
    expect(selection.wheel?.path).toBe("dist/pkg-1.0-cp311-cp311-manylinux_2_28_x86_64.whl");
    expect(selection.sdist?.path).toBe("dist/pkg-1.0.tar.gz");
  });

  test.each([
    "pkg-1.0-cp312-cp312-manylinux_2_17_x86_64.whl",
    "pkg-1.0-cp311-cp311-win_amd64.whl",
    "pkg-1.0-cp311-cp311-macosx_11_0_arm64.whl",
    "pkg-1.0-cp311-cp311-musllinux_1_1_x86_64.whl",
    "pkg-1.0-cp311-cp311-manylinux_2_17_aarch64.whl",
    "pkg-1.0-cp311-cp311-manylinux_2_39_x86_64.whl",
    "pkg-1.0-cp312-abi3-manylinux_2_17_x86_64.whl",
    "pkg-1.0-py2-none-any.whl",
    "not-a-wheel.whl",
  ])("cannot run %s", (filename) => {
    expect(wheelScore(filename)).toBe(0);
  });

  test.each([
    "pkg-1.0-py3-none-any.whl",
    "pkg-1.0-py2.py3-none-any.whl",
    "pkg-1.0-py311-none-any.whl",
    "pkg-1.0-cp38-abi3-manylinux2014_x86_64.whl",
    "pkg-1.0-1build-cp311-cp311-linux_x86_64.whl",
  ])("can run %s", (filename) => {
    expect(wheelScore(filename)).toBeGreaterThan(0);
  });

  test("runs the sdist alone when no wheel fits, and nothing when there is neither", () => {
    expect(
      selectPyPiDetonationArtifacts(
        provenance(["pkg-1.0-cp311-cp311-win_amd64.whl", "pkg-1.0.tgz"]),
      ),
    ).toMatchObject({ wheel: null, sdist: { path: "pkg-1.0.tgz" } });
    expect(
      selectPyPiDetonationArtifacts(provenance(["pkg-1.0-cp311-cp311-win_amd64.whl"])),
    ).toEqual({ wheel: null, sdist: null });
  });

  test("never selects a filename the harness would refuse", () => {
    // The harness rejects the whole bundle on one bad name, which would also
    // stop the wheel from running.
    const selected = selectPyPiDetonationArtifacts(
      provenance(["dist/_pkg-1.0-py3-none-any.whl", "dist/Pkg-1.0.TAR.GZ"]),
    );
    expect(selected).toEqual({ wheel: null, sdist: null });
    const accepted = selectPyPiDetonationArtifacts(
      provenance(["dist/pkg-1.0-py3-none-any.whl", "dist/pkg-1.0.tar.gz"]),
    );
    const files = [accepted.wheel, accepted.sdist].map((artifact) => ({
      name: artifact!.path.slice("dist/".length),
      kind: artifact!.kind,
      bytes: bytes("x"),
    }));
    expect(harness.decodePyPiBundle(Buffer.from(encodePyPiPrepareBundle(files)))).not.toBeNull();
  });

  test("pins the base image its wheel selection assumes", () => {
    // Bookworm's python3 is CPython 3.11; a base-image bump must move both.
    // This only pins the pairing: the local harness run checks the real interpreter.
    const dockerfile = readFileSync(
      new URL("../containers/detonation/Dockerfile", import.meta.url),
      "utf8",
    );
    expect(dockerfile).toMatch(/^FROM node:[0-9.]+-bookworm-slim$/m);
    expect(DETONATION_PYTHON).toEqual({ major: 3, minor: 11 });
  });

  test("ships every Python helper the harness names into the image", () => {
    const dockerfile = readFileSync(
      new URL("../containers/detonation/Dockerfile", import.meta.url),
      "utf8",
    );
    const helpers = readdirSync(new URL("../containers/detonation/py", import.meta.url));
    for (const helper of helpers) expect(dockerfile).toContain(`py/${helper}`);
    for (const script of [
      harness.RUNNER,
      harness.BUILDER,
      harness.BUILD_SYSTEM_READER,
      harness.OBSERVER,
    ]) {
      expect(helpers).toContain(script.slice(script.lastIndexOf("/") + 1));
    }
    expect(dockerfile).toContain("pypi.mjs");
  });

  test("spawns root-run binaries by absolute path, never through the package's PATH", () => {
    // A step's env carries a PATH the package can write (`node_modules/.bin`,
    // the venv's `bin`); a bare `setpriv` or `strace` there would run as root.
    const source = readFileSync(
      new URL("../containers/detonation/harness.mjs", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/["'](?:setpriv|strace)["']/);
    expect(source).toContain('"/usr/bin/setpriv"');
    expect(source).toContain('"/usr/bin/strace"');
  });
});

describe("dependencies of the reviewed wheel", () => {
  test("keeps index requirements and drops direct references pip would build", () => {
    const metadata = [
      "Metadata-Version: 2.1",
      "Name: demo",
      "Requires-Dist: requests (>=2.0)",
      'Requires-Dist: tomli ; python_version < "3.11"',
      "Requires-Dist: evil @ file:///work/dist/demo-1.0.tar.gz",
      "Requires-Dist: other @ https://files.pythonhosted.org/packages/x/other-1.0.tar.gz",
      "Requires-Dist: --index-url=https://evil.invalid",
      'Requires-Dist: pytest ; extra == "test"',
      "",
      "Requires-Dist: in-the-description",
    ].join("\n");
    expect(harness.requiresDist(metadata)).toEqual({
      requirements: ["requests (>=2.0)", 'tomli ; python_version < "3.11"'],
      dropped: 3,
    });
  });
});

describe("PyPI provenance", () => {
  const summary = (artifacts: unknown, extra: Record<string, unknown> = {}) => ({
    stagedPublish: {
      provenance: { ecosystem: "pypi", mode: "workflow_gate", artifacts, ...extra },
    },
  });

  test("reads the reviewed digests a gate scan recorded", () => {
    expect(
      readPyPiProvenance(
        summary([{ path: "dist/a-1.0-py3-none-any.whl", kind: "wheel", sha256: SHA }]),
      ),
    ).toEqual([{ path: "dist/a-1.0-py3-none-any.whl", kind: "wheel", sha256: SHA }]);
  });

  test.each([
    ["no provenance", { stagedPublish: {} }],
    ["an npm provenance", summary([], { ecosystem: "npm" })],
    ["a malformed digest", summary([{ path: "a.whl", kind: "wheel", sha256: "abc" }])],
    ["an unknown kind", summary([{ path: "a.zip", kind: "zip", sha256: SHA }])],
    ["no artifacts", summary([])],
  ])("has nothing to bind a run to with %s", (_name, value) => {
    expect(readPyPiProvenance(value)).toBeNull();
  });
});

describe("installed distribution metadata", () => {
  test("lists importable top-level names from RECORD, own package first, hooks excluded", () => {
    const record = [
      "cook.pth,,",
      "cook.py,sha256=x,1",
      "sitecustomize.py,,",
      "zeta/__init__.py,,",
      "litellm/__init__.py,,",
      "litellm/proxy/x.py,,",
      "_speedups.cpython-311-x86_64-linux-gnu.so,,",
      '"quoted,name/__init__.py",,',
      "../escape.py,,",
      "litellm-1.107.0.dist-info/RECORD,,",
      "litellm-1.107.0.data/scripts/x,,",
    ].join("\n");
    expect(harness.topLevelModules(record, "LiteLLM")).toEqual([
      "litellm",
      "_speedups",
      "cook",
      "zeta",
    ]);
  });

  test("keeps only console and GUI scripts with plain dotted references", () => {
    const text = [
      "[console_scripts]",
      "litellm = litellm.proxy:run_server",
      "extra = pkg.cli:main [cli]",
      "evil = os:system('id')",
      "noattr = pkg.cli",
      "-flag = pkg:main",
      "[gui_scripts]",
      "gui = pkg.gui:App.run",
      "[other]",
      "skip = pkg:main",
    ].join("\n");
    expect(harness.parseEntryPoints(text)).toEqual([
      { name: "litellm", module: "litellm.proxy", attr: "run_server" },
      { name: "extra", module: "pkg.cli", attr: "main" },
      { name: "gui", module: "pkg.gui", attr: "App.run" },
    ]);
  });

  test("finds the reviewed wheel's dist-info by normalized name and exact version", () => {
    const entries = [
      "Other-1.0.dist-info",
      "lite_llm-1.107.0.dist-info",
      "lite_llm-1.106.0.dist-info",
    ];
    expect(harness.findDistInfo(entries, { name: "Lite.LLM", version: "1.107.0" })).toBe(
      "lite_llm-1.107.0.dist-info",
    );
    expect(harness.findDistInfo(entries, { name: "lite-llm", version: "2.0" })).toBeNull();
  });
});

describe("sdist build system", () => {
  test.each([
    ["setuptools>=61", true],
    ["hatchling", true],
    ["poetry-core>=1.0.0,<2", true],
    ["setuptools_scm[toml] >= 6.2", true],
    ['wheel; python_version < "3.12"', true],
    ["evil @ https://example.invalid/evil.whl", false],
    ["--index-url=https://example.invalid", false],
    ["-e .", false],
    ["./local-dir", false],
    ["", false],
  ])("treats %j as safe to hand to pip: %s", (requirement, safe) => {
    expect(harness.isSafeRequirement(requirement)).toBe(safe);
  });

  test("falls back to setuptools' legacy backend when nothing is declared", () => {
    expect(harness.narrowBuildSystem(null)).toEqual({
      requires: ["setuptools>=40.8.0"],
      backend: "setuptools.build_meta:__legacy__",
      backendPath: [],
      dropped: 0,
    });
  });

  test("drops unsafe requirements and backend paths that leave the sdist", () => {
    expect(
      harness.narrowBuildSystem({
        requires: ["hatchling", "x @ https://example.invalid/x.whl"],
        backend: "backend:build",
        backendPath: ["_build", "../outside", "/abs"],
      }),
    ).toEqual({
      requires: ["hatchling"],
      backend: "backend:build",
      backendPath: ["_build"],
      dropped: 1,
    });
  });

  test("plans no build for a backend that is not a plain reference", () => {
    expect(harness.narrowBuildSystem({ backend: "os:system('id')" }).backend).toBe("");
    expect(harness.isBackendReference("a.b:c.d")).toBe(true);
    expect(harness.isBackendReference("a:b:c")).toBe(false);
  });
});

describe("PyPI step plan", () => {
  const env = { HOME: "/home/pkg" };
  const plans = harness.planPyPiSteps(
    {
      distribution: "Startup_Hook.Thief",
      installed: true,
      modules: ["startup_hook_thief", "cook"],
      entryPoints: [{ name: "thief", module: "startup_hook_thief.cli", attr: "main" }],
      build: {
        root: "/work/sdist/thief-1.0",
        backend: "setuptools.build_meta:__legacy__",
        backendPath: [],
      },
    },
    env,
  );

  test("starts a bare interpreter first, which is when .pth files and sitecustomize run", () => {
    expect(plans[0]).toMatchObject({
      step: "startup",
      target: "startup-hook-thief:startup",
      argv: [harness.VENV_PYTHON, "-c", "pass"],
    });
    expect(plans.map((plan: { step: string }) => plan.step)).toEqual([
      "startup",
      "import",
      "import",
      "build",
      "bin",
    ]);
  });

  test("passes package-chosen names as arguments, never as code", () => {
    for (const plan of plans.slice(1)) {
      expect(plan.argv).not.toContain("-c");
      expect(plan.reviewed).toBe(true);
    }
    expect(plans[1].argv).toEqual([
      harness.VENV_PYTHON,
      "-P",
      harness.RUNNER,
      "import",
      "startup_hook_thief",
    ]);
    expect(plans[4].argv).toEqual([
      harness.VENV_PYTHON,
      "-P",
      harness.RUNNER,
      "entry",
      "startup_hook_thief.cli",
      "main",
      "thief",
    ]);
  });

  test("builds the sdist with the image's interpreter, outside the run's environment", () => {
    const build = plans[3];
    expect(build.argv[0]).toBe(harness.SYSTEM_PYTHON);
    expect(build.cwd).toBe("/work/sdist/thief-1.0");
    expect(build.env.PYTHONPATH).toBe(harness.BUILD_ENV);
  });

  test("plans only the build when the wheel did not install", () => {
    const only = harness.planPyPiSteps(
      {
        distribution: "x",
        installed: false,
        modules: [],
        entryPoints: [],
        build: { root: "/work/sdist/x-1", backend: "flit_core.buildapi", backendPath: [] },
      },
      env,
    );
    expect(only.map((plan: { step: string }) => plan.step)).toEqual(["build"]);
  });

  test("loads the observer before ordinary package .pth files", () => {
    const names = [
      "cook.pth",
      "_virtualenv.pth",
      "distutils-precedence.pth",
      "Zope-nspkg.pth",
      harness.OBSERVER_PTH_NAME,
    ];
    expect(names.sort()[0]).toBe(harness.OBSERVER_PTH_NAME);
    expect(harness.OBSERVER_PTH.startsWith("import ")).toBe(true);
  });
});
