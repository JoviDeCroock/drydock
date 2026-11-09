import { createHash } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { main } from "../cli/src/main.mjs";
import { parseAdmissionLock } from "../cli/src/admission-lockfile.mjs";

const OLD = "inert old archive bytes: never execute";
const NEW = "inert new archive bytes: never execute";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const sri = (text: string) => `sha512-${createHash("sha512").update(text).digest("base64")}`;
function entry(name: string, version: string, bytes: string) {
  return {
    version,
    resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
    integrity: sri(bytes),
  };
}
function lock(entries: Record<string, unknown>, root: Record<string, unknown> = {}) {
  return JSON.stringify({ lockfileVersion: 3, packages: { "": root, ...entries } });
}
function evidence(name = "demo", from = "1.0.0", to = "1.1.0") {
  return {
    ecosystem: "npm",
    packageName: name,
    fromVersion: from,
    toVersion: to,
    fromPackageJson: { name, version: from },
    toPackageJson: { name, version: to } as {
      name: string;
      version: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    },
    artifactDigests: { from: { sha256: sha(OLD) }, to: { sha256: sha(NEW) } },
    analysisVersion: "npm:v6:rules=test:risk=1",
    cachedAt: "2026-11-08T00:00:00Z",
    risk: { releaseRisk: "low" },
    notices: [] as string[],
    textSamplesOmitted: false,
    diff: [{ path: "index.js", status: "modified", flags: [] as string[] }],
    findings: [],
    packageJsonDiff: {
      scripts: [] as Array<{ key: string; status: string }>,
      dependencies: [] as Array<{ key: string; status: string }>,
      bin: [] as Array<{ key: string; status: string }>,
    },
  };
}
function harness(
  options: {
    baseline?: string;
    target?: string;
    diff?: unknown;
    manifest?: string;
    tarball?: (url: string) => Response;
    mutate?: (files: Map<string, string>) => void;
  } = {},
) {
  const files = new Map([
    [
      "trusted.json",
      options.baseline ?? lock({ "node_modules/demo": entry("demo", "1.0.0", OLD) }),
    ],
    [
      "package-lock.json",
      options.target ?? lock({ "node_modules/demo": entry("demo", "1.1.0", NEW) }),
    ],
  ]);
  files.set(
    "package.json",
    options.manifest ?? JSON.stringify(JSON.parse(files.get("package-lock.json")!).packages[""]),
  );
  const out: string[] = [];
  const err: string[] = [];
  let clock = 0;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    expect(init?.redirect).toBe("manual");
    expect(init?.credentials).toBe("omit");
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    if (url.startsWith("https://registry.npmjs.org/"))
      return options.tarball?.(url) ?? new Response(url.includes("1.0.0") ? OLD : NEW);
    options.mutate?.(files);
    return new Response(JSON.stringify(options.diff ?? evidence()));
  });
  const io = {
    env: { DRYDOCK_API_KEY: `ddk_${"k".repeat(43)}`, DRYDOCK_URL: "https://drydock.test" },
    fetch: fetcher as typeof fetch,
    stdout: (s: string) => {
      out.push(s);
    },
    stderr: (s: string) => {
      err.push(s);
    },
    readFile: async (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return value;
    },
    writeFile: async (path: string, data: string) => {
      files.set(path, data);
    },
    writeNewFile: async (path: string, data: string) => {
      if (files.has(path)) throw new Error("exists");
      files.set(path, data);
    },
    sleep: async (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
  return {
    files,
    fetcher,
    out,
    err,
    run: () =>
      main(
        ["admit", "package-lock.json", "--baseline", "trusted.json", "--output", "receipt.json"],
        io,
      ),
  };
}

describe("npm pre-install admission", () => {
  test("binds both reviewed archives to SHA512 lock pins without executing any artifact", async () => {
    const h = harness();
    expect(await h.run()).toBe(0);
    expect(h.fetcher).toHaveBeenCalledTimes(3);
    const receipt = JSON.parse(h.files.get("receipt.json")!);
    expect(receipt).toMatchObject({
      status: "admitted",
      targetLockSha256: sha(h.files.get("package-lock.json")!),
      trustedBaselineLockSha256: sha(h.files.get("trusted.json")!),
      targetDependencyEntries: 1,
      trustedEntries: 0,
      reviewed: [{ fromSha256: sha(OLD), toSha256: sha(NEW) }],
    });
    expect(h.fetcher.mock.calls.at(-1)?.[0]).toContain("/api/public/v1/package-diff?");
  });
  test("trusts unchanged identities only when source AND integrity match the explicit baseline", async () => {
    const body = lock({ "node_modules/demo": entry("demo", "1.0.0", OLD) });
    const h = harness({ target: body });
    expect(await h.run()).toBe(0);
    expect(h.fetcher).not.toHaveBeenCalled();
    const replaced = harness({
      target: lock({ "node_modules/demo": entry("demo", "1.0.0", NEW) }),
    });
    expect(await replaced.run()).toBe(3);
    expect(replaced.fetcher).not.toHaveBeenCalled();
    expect(replaced.out.join("")).toContain("same-version-artifact-changed");
  });
  test("holds first-time transitive packages before exposing any package names", async () => {
    const h = harness({
      target: lock({
        "node_modules/demo": { ...entry("demo", "1.1.0", NEW), dependencies: { extra: "1.0.0" } },
        "node_modules/extra": entry("extra", "1.0.0", NEW),
      }),
    });
    expect(await h.run()).toBe(3);
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(h.out.join("")).toContain("new-package-needs-manual-review");
  });
  test.each([
    "https://private.example/demo.tgz",
    "https://user:secret@registry.npmjs.org/demo/-/demo-1.1.0.tgz",
    "git+https://github.com/example/demo",
    "https://registry.npmjs.org/demo/-/demo-1.1.0.tgz?token=secret",
  ])("rejects unsupported sources locally: %s", async (resolved) => {
    const h = harness({
      target: lock({ "node_modules/demo": { ...entry("demo", "1.1.0", NEW), resolved } }),
    });
    expect(await h.run()).toBe(1);
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(h.files.has("receipt.json")).toBe(false);
  });
  test("does not disclose private npm names to Drydock when anonymous artifact retrieval fails", async () => {
    const h = harness({ tarball: () => new Response("private", { status: 403 }) });
    expect(await h.run()).toBe(1);
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(h.files.has("receipt.json")).toBe(false);
  });
  test.each([
    "archive-integrity",
    "reviewed-baseline-digest",
    "reviewed-target-digest",
    "identity",
    "missing-coverage",
    "unknown-risk",
  ])("fails closed on %s", async (kind) => {
    const diff = evidence();
    let tarball: ((url: string) => Response) | undefined;
    if (kind === "archive-integrity") tarball = () => new Response("wrong bytes");
    if (kind === "reviewed-baseline-digest") diff.artifactDigests.from.sha256 = "0".repeat(64);
    if (kind === "reviewed-target-digest") diff.artifactDigests.to.sha256 = "0".repeat(64);
    if (kind === "identity") diff.toPackageJson.name = "another";
    if (kind === "missing-coverage") Reflect.deleteProperty(diff, "notices");
    if (kind === "unknown-risk") diff.risk.releaseRisk = "safe";
    const h = harness({ diff, tarball });
    expect(await h.run()).toBe(1);
    expect(h.files.has("receipt.json")).toBe(false);
  });
  test.each(["risk", "coverage", "native", "install-script", "added-dependency"])(
    "holds policy change %s",
    async (kind) => {
      const diff = evidence();
      if (kind === "risk") diff.risk.releaseRisk = "high";
      if (kind === "coverage") diff.notices = ["archive tail not inspected"];
      if (kind === "native") diff.diff[0].flags = ["native-elf"];
      if (kind === "install-script")
        diff.packageJsonDiff.scripts = [{ key: "postinstall", status: "added" }];
      if (kind === "added-dependency")
        diff.packageJsonDiff.dependencies = [{ key: "extra", status: "added" }];
      const h = harness({ diff });
      expect(await h.run()).toBe(3);
      expect(JSON.parse(h.files.get("receipt.json")!).status).toBe("held");
    },
  );
  test.each(["package-lock.json", "trusted.json", "package.json"])(
    "rejects moving input %s",
    async (path) => {
      const h = harness({
        mutate: (files) => {
          files.set(path, `${files.get(path)} `);
        },
      });
      expect(await h.run()).toBe(1);
      expect(h.err.join("")).toContain("inputs changed");
      expect(h.files.has("receipt.json")).toBe(false);
    },
  );
  test("refuses an existing receipt before network access", async () => {
    const h = harness();
    h.files.set("receipt.json", '{"status":"admitted","old":true}');
    expect(await h.run()).toBe(2);
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(h.files.get("receipt.json")).toContain('"old":true');
  });
  test.each([302, 429, 500])("blocks evidence HTTP %s", async (status) => {
    const h = harness({ tarball: () => new Response("", { status }) });
    expect(await h.run()).toBe(1);
    expect(h.files.has("receipt.json")).toBe(false);
  });
  test("rejects oversized response before consuming it", async () => {
    const h = harness({
      tarball: () =>
        new Response("small", { headers: { "content-length": String(65 * 1024 * 1024) } }),
    });
    expect(await h.run()).toBe(1);
    expect(h.err.join("")).toContain("byte budget");
  });
  test("checks unresolved root dev dependencies and shrinkwraps instead of guessing graph coverage", () => {
    expect(() => parseAdmissionLock(lock({}, { devDependencies: { missing: "1.0.0" } }))).toThrow(
      /unresolved/,
    );
    expect(() =>
      parseAdmissionLock(
        lock({ "node_modules/demo": { ...entry("demo", "1.0.0", OLD), hasShrinkwrap: true } }),
      ),
    ).toThrow(/unsupported/);
  });
  test("refuses package-lock when an active shrinkwrap takes precedence", async () => {
    const h = harness();
    h.files.set("npm-shrinkwrap.json", lock({}));
    expect(await h.run()).toBe(2);
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  test("rechecks active shrinkwrap precedence after network evidence", async () => {
    const h = harness({
      mutate: (files) => {
        files.set("npm-shrinkwrap.json", lock({}));
      },
    });
    expect(await h.run()).toBe(2);
    expect(h.files.has("receipt.json")).toBe(false);
  });
  test("terminal output escapes remote bidirectional controls while receipt preserves exact JSON", async () => {
    const diff = evidence();
    diff.analysisVersion += "\u202ehostile";
    const h = harness({ diff });
    expect(await h.run()).toBe(0);
    expect(h.out.join("")).not.toContain("\u202e");
    expect(JSON.parse(h.files.get("receipt.json")!).reviewed[0].analysisVersion).toContain(
      "\u202e",
    );
  });
  test("holds a native extension even when the parser supplies no native flags", async () => {
    const diff = evidence();
    diff.diff[0].path = "addon.node";
    const h = harness({ diff });
    expect(await h.run()).toBe(3);
  });
  test("rejects unknown capability-change status instead of silently ignoring it", async () => {
    const diff = evidence();
    diff.packageJsonDiff.scripts = [{ key: "postinstall", status: "unknown" }];
    const h = harness({ diff });
    expect(await h.run()).toBe(1);
  });
  test.each([
    "npm-shrinkwrap.json",
    "node_modules/nested/index.js",
    "lib/node_modules/other/index.js",
  ])("holds hidden install graph source %s even when lock metadata omits it", async (path) => {
    const diff = evidence();
    diff.diff[0].path = path;
    const h = harness({ diff });
    expect(await h.run()).toBe(3);
    expect(h.out.join("")).toContain("unsupported-nested-install-graph");
  });
  test("accepts the modern npm v2 packages graph and ignores its legacy compatibility tree", () => {
    const modern = JSON.parse(lock({ "node_modules/demo": entry("demo", "1.0.0", OLD) }));
    modern.lockfileVersion = 2;
    modern.dependencies = { legacy: { version: "different" } };
    expect(parseAdmissionLock(JSON.stringify(modern)).size).toBe(1);
  });
  test("rejects missing strong integrity in an otherwise unchanged trusted node", async () => {
    const body = lock({
      "node_modules/demo": { ...entry("demo", "1.0.0", OLD), integrity: undefined },
    });
    const h = harness({ baseline: body, target: body });
    expect(await h.run()).toBe(1);
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  test("rejects the root graph when its complete dependency list exceeds the entry cap", () => {
    const entries = Object.fromEntries(
      Array.from({ length: 2001 }, (_, i) => [
        `node_modules/demo${i}`,
        entry(`demo${i}`, "1.0.0", OLD),
      ]),
    );
    expect(() => parseAdmissionLock(lock(entries))).toThrow(/2000/);
  });
  test.each([
    "file:../outside",
    "git+https://private.example/source",
    "npm:other@1.0.0",
    "workspace:*",
  ])("rejects nonregistry declarations even beside a trusted public node: %s", async (spec) => {
    const body = lock(
      { "node_modules/demo": entry("demo", "1.0.0", OLD) },
      { dependencies: { demo: spec } },
    );
    const h = harness({ baseline: body, target: body });
    expect(await h.run()).toBe(1);
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  test("nested development declarations are not consumer install edges", () => {
    expect(
      parseAdmissionLock(
        lock({
          "node_modules/demo": {
            ...entry("demo", "1.0.0", OLD),
            devDependencies: { uninstalled: "^1.0.0" },
          },
        }),
      ).size,
    ).toBe(1);
  });
  test("blocks a same-version file replacement in the actual package.json before remote reads", async () => {
    const trusted = lock(
      { "node_modules/demo": entry("demo", "1.0.0", OLD) },
      { dependencies: { demo: "1.0.0" } },
    );
    const h = harness({
      baseline: trusted,
      target: trusted,
      manifest: JSON.stringify({ dependencies: { demo: "file:replacement.tgz" } }),
    });
    expect(await h.run()).toBe(1);
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(h.files.has("receipt.json")).toBe(false);
  });
  test.each(["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"])(
    "binds actual manifest %s to the lock snapshot",
    async (section) => {
      const h = harness({ manifest: JSON.stringify({ [section]: { demo: "^1.1.0" } }) });
      expect(await h.run()).toBe(1);
      expect(h.fetcher).not.toHaveBeenCalled();
    },
  );
  test.each([
    "overrides",
    "workspaces",
    "resolutions",
    "pnpm",
    "installConfig",
    "futureResolverField",
  ])("refuses unbound manifest resolver input %s", async (field) => {
    const h = harness({ manifest: JSON.stringify({ [field]: { demo: "file:replacement.tgz" } }) });
    expect(await h.run()).toBe(1);
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  test("allows harmless metadata and lifecycle declarations without executing them, and records raw manifest hash", async () => {
    const manifest = JSON.stringify({
      description: "ordinary metadata",
      scripts: { postinstall: "must never execute" },
      exports: "./index.js",
      engines: { node: ">=22" },
    });
    const h = harness({ manifest });
    expect(await h.run()).toBe(0);
    expect(JSON.parse(h.files.get("receipt.json")!).packageJsonSha256).toBe(sha(manifest));
  });
  test("binds optional peer metadata", async () => {
    const h = harness({
      manifest: JSON.stringify({ peerDependenciesMeta: { demo: { optional: true } } }),
    });
    expect(await h.run()).toBe(1);
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  test("rejects a reviewed package's hidden alternate dependency source", async () => {
    const diff = evidence();
    diff.toPackageJson.dependencies = { hidden: "file:replacement.tgz" };
    const h = harness({ diff });
    expect(await h.run()).toBe(1);
    expect(h.files.has("receipt.json")).toBe(false);
  });
  test("rejects registry package declarations omitted from target lock metadata", async () => {
    const diff = evidence();
    diff.toPackageJson.dependencies = { hidden: "1.0.0" };
    const h = harness({ diff });
    expect(await h.run()).toBe(1);
    expect(h.err.join("")).toContain("complete graph is unproven");
  });
  test("ignores reviewed package development declarations that npm ci does not install for dependencies", async () => {
    const diff = evidence();
    diff.toPackageJson.devDependencies = { dev: "file:local" };
    const h = harness({ diff });
    expect(await h.run()).toBe(0);
  });
  test("holds same-version lock dependency metadata drift instead of grandfathering the artifact", async () => {
    const nodes = {
      "node_modules/demo": entry("demo", "1.0.0", OLD),
      "node_modules/extra": entry("extra", "1.0.0", OLD),
    };
    const h = harness({
      baseline: lock(nodes),
      target: lock({
        ...nodes,
        "node_modules/demo": { ...nodes["node_modules/demo"], dependencies: { extra: "1.0.0" } },
      }),
    });
    expect(await h.run()).toBe(3);
    expect(h.fetcher).not.toHaveBeenCalled();
  });
});
