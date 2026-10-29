import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";
import {
  NPM_ARCHIVE_DIRECTORY,
  npmArchivePrepareCommand,
  npmArchivePublishCommand,
} from "../server/lib/github-app/setup-npm-archives";

const requireBuiltin = createRequire(import.meta.url);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// @actions/exec accepts double quotes and preserves escapes other than escaped
// double quotes. Its parser does not implement POSIX single-quote semantics.
function actionArguments(command: string): string[] {
  const args: string[] = [];
  let token = "";
  let quoted = false;
  let escaped = false;
  for (const character of command) {
    if (character === '"' && !escaped) {
      quoted = !quoted;
      continue;
    }
    if (character === "\\" && quoted && !escaped) {
      escaped = true;
      continue;
    }
    if (escaped && character !== '"') token += "\\";
    if (character === " " && !quoted) {
      if (token) args.push(token);
      token = "";
    } else token += character;
    escaped = false;
  }
  if (token) args.push(token.trim());
  return args;
}

type CommandCall = { command: string; args: string[]; cwd: string };
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "drydock-archive-test-")));
  roots.push(root);
  const calls: CommandCall[] = [];
  const published = new Set<string>();
  const logs: string[] = [];
  let failPublication = 0;
  let publicationCount = 0;
  let githubSha = "a".repeat(40);
  let checkout = githubSha;
  function write(relative: string, value: unknown) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  }
  write("package.json", { name: "workspace", version: "0.0.0", private: true });
  write(".changeset/config.json", { access: "public", ignore: ["@demo/ignored"] });
  write(
    "pnpm-workspace.yaml",
    "packages:\n  - packages/*\n  - examples/*\n  - bench/fixtures/*\nminimumReleaseAgeExclude:\n  - '@changesets/cli@3.0.0'\n",
  );
  const childProcess = {
    spawnSync(command: string, args: string[], options: { cwd: string }) {
      calls.push({ command, args, cwd: options.cwd });
      if (command === "npm" && args[0] === "view")
        return published.has(args[1])
          ? { status: 0, stdout: '"1.0.0"', stderr: "" }
          : { status: 1, stdout: "", stderr: "E404" };
      if (command === "git" && args[0] === "rev-parse")
        return args[1] === "HEAD" ? { status: 0, stdout: checkout + "\n" } : { status: 1 };
      if (command === "npm" && args.includes("publish") && ++publicationCount === failPublication)
        return { status: 1, stdout: "", stderr: "Inert publication failure" };
      if (command === "pnpm" && args.includes("pack")) {
        const packageDirectory = args[args.indexOf("--dir") + 1];
        const destination = args[args.indexOf("--pack-destination") + 1];
        const pkg = JSON.parse(
          fs.readFileSync(path.join(packageDirectory, "package.json"), "utf8"),
        );
        fs.writeFileSync(path.join(destination, "packed.tgz"), "inert archive bytes: " + pkg.name);
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  };
  function execute(command: string, overrides: Record<string, unknown> = {}) {
    const args = actionArguments(command);
    expect(args.slice(0, 2)).toEqual(["node", "-e"]);
    expect(args).toHaveLength(3);
    const program = new Function("require", "process", "console", "Buffer", args[2]);
    program(
      (name: string) => {
        if (name === "node:child_process") return childProcess;
        if (name in overrides) return overrides[name];
        if (!["node:fs", "node:path", "node:crypto", "node:os"].includes(name))
          throw new Error("Repository imports are forbidden in the helper test");
        return requireBuiltin(name);
      },
      {
        cwd: () => root,
        env: { GITHUB_OUTPUT: path.join(root, "output"), GITHUB_SHA: githubSha },
        stdout: { write: (text: string) => logs.push(text) },
        stderr: { write: (text: string) => logs.push(text) },
      },
      { log: (text: string) => logs.push(text) },
      Buffer,
    );
  }
  function bundleFile(name: string) {
    return path.join(root, NPM_ARCHIVE_DIRECTORY, name);
  }
  function manifest() {
    return JSON.parse(fs.readFileSync(bundleFile("manifest.json"), "utf8")) as {
      schema: string;
      sourceCommit: string;
      packages: {
        name: string;
        version: string;
        archive: string;
        access: string;
        tag: string;
        sha256: string;
      }[];
    };
  }
  function rewriteManifest(value: ReturnType<typeof manifest>) {
    fs.writeFileSync(bundleFile("manifest.json"), JSON.stringify(value));
    const manifestHash = createHash("sha256")
      .update(fs.readFileSync(bundleFile("manifest.json")))
      .digest("hex");
    fs.writeFileSync(
      bundleFile("SHA256SUMS"),
      [
        manifestHash + "  manifest.json",
        ...value.packages.map((pkg) => pkg.sha256 + "  " + pkg.archive),
      ].join("\n") + "\n",
    );
  }
  return {
    root,
    calls,
    logs,
    published,
    write,
    execute,
    bundleFile,
    manifest,
    rewriteManifest,
    failPublicationAt: (index: number) => {
      failPublication = index;
    },
    setGithubSha: (sha: string) => {
      githubSha = sha;
    },
    setCheckout: (sha: string) => {
      checkout = sha;
    },
  };
}

function twoPackages(f: ReturnType<typeof fixture>) {
  f.write("packages/a/package.json", {
    name: "@demo/core",
    version: "1.0.0",
    scripts: { prepublishOnly: "npm run build", build: "never executed in this test" },
    dependencies: { "@demo/peer": "workspace:^" },
  });
  f.write("packages/b/package.json", {
    name: "@demo/peer",
    version: "2.0.0-rc.3",
    publishConfig: { access: "restricted" },
  });
}

describe("canonical reviewed npm archive commands", () => {
  test.each([
    npmArchivePrepareCommand,
    npmArchivePublishCommand("publish"),
    npmArchivePublishCommand("stage"),
  ])("shell and Actions execution preserve the identical program %#", (command) => {
    const parsed = actionArguments(command);
    // Only shell argument parsing runs here; neither Node nor any package is executed.
    const shell = spawnSync("/bin/sh", ["-c", "set -- " + command + '; printf "%s" "$3"'], {
      encoding: "utf8",
    });
    expect(shell.status).toBe(0);
    expect(shell.stdout).toBe(parsed[2]);
    expect(() => new Function(parsed[2])).not.toThrow();
  });

  test("selects the intended workspace set and builds before pnpm packing", () => {
    const f = fixture();
    twoPackages(f);
    f.write("packages/ignored/package.json", { name: "@demo/ignored", version: "1.0.0" });
    f.write("examples/private/package.json", {
      name: "private-demo",
      version: "1.0.0",
      private: true,
    });
    f.write("bench/fixtures/published/package.json", { name: "bench-demo", version: "1.0.0" });
    f.published.add("bench-demo@1.0.0");
    f.execute(npmArchivePrepareCommand);
    expect(f.manifest().packages.map(({ name, access, tag }) => ({ name, access, tag }))).toEqual([
      { name: "@demo/core", access: "public", tag: "latest" },
      { name: "@demo/peer", access: "restricted", tag: "rc" },
    ]);
    const commands = f.calls.filter((call) => call.command === "pnpm");
    expect(commands.map((call) => call.args[2])).toEqual(["run", "pack", "pack"]);
    expect(commands[0].args).toEqual([
      "--dir",
      path.join(f.root, "packages/a"),
      "run",
      "prepublishOnly",
    ]);
    expect(f.calls.every((call) => !call.args.includes("publish"))).toBe(true);
    expect(fs.readFileSync(path.join(f.root, "output"), "utf8")).toBe("has_packages=true\n");
  });

  test.each(["publish", "stage"] as const)(
    "%s uses only verified tarballs with scripts disabled and preserves release tags",
    (mode) => {
      const f = fixture();
      twoPackages(f);
      f.execute(npmArchivePrepareCommand);
      f.calls.length = 0;
      f.execute(npmArchivePublishCommand(mode));
      const publishes = f.calls.filter(
        (call) => call.command === "npm" && call.args.includes("publish"),
      );
      expect(publishes).toHaveLength(2);
      for (const [index, call] of publishes.entries())
        expect(call.args).toEqual([
          ...(mode === "stage" ? ["stage"] : []),
          "publish",
          f.bundleFile(f.manifest().packages[index].archive),
          "--ignore-scripts",
          "--provenance",
          "--access",
          index === 0 ? "public" : "restricted",
          "--tag",
          index === 0 ? "latest" : "rc",
          "--json",
        ]);
      expect(f.calls.some((call) => call.command === "pnpm")).toBe(false);
      expect(
        f.calls
          .filter((call) => call.command === "git" && call.args[0] === "tag")
          .map((call) => call.args),
      ).toEqual([
        ["tag", "@demo/core@1.0.0", "-m", "@demo/core@1.0.0"],
        ["tag", "@demo/peer@2.0.0-rc.3", "-m", "@demo/peer@2.0.0-rc.3"],
      ]);
      expect(f.logs).toContain("New tag: @demo/peer@2.0.0-rc.3");
    },
  );

  test("checks all archive bytes before the first publication", () => {
    const f = fixture();
    twoPackages(f);
    f.execute(npmArchivePrepareCommand);
    fs.appendFileSync(f.bundleFile(f.manifest().packages[1].archive), "changed");
    f.calls.length = 0;
    expect(() => f.execute(npmArchivePublishCommand("stage"))).toThrow(/digest/);
    expect(f.calls).toEqual([]);
  });

  test.each(["../escape.tgz", "/tmp/package-0001.tgz", "package-0001.tgz/child", "--registry.tgz"])(
    "refuses archive path %s before any command",
    (archive) => {
      const f = fixture();
      twoPackages(f);
      f.execute(npmArchivePrepareCommand);
      const manifest = f.manifest();
      manifest.packages[1].archive = archive;
      f.rewriteManifest(manifest);
      f.calls.length = 0;
      expect(() => f.execute(npmArchivePublishCommand("stage"))).toThrow(/archive|digest/);
      expect(f.calls).toEqual([]);
    },
  );

  test("refuses symlinks, missing manifests and unlisted files", () => {
    const f = fixture();
    twoPackages(f);
    f.execute(npmArchivePrepareCommand);
    const archive = f.bundleFile(f.manifest().packages[0].archive);
    fs.renameSync(archive, path.join(f.root, "archive"));
    fs.symlinkSync(path.join(f.root, "archive"), archive);
    expect(() => f.execute(npmArchivePublishCommand("stage"))).toThrow(/file/);
    fs.unlinkSync(archive);
    fs.renameSync(path.join(f.root, "archive"), archive);
    fs.writeFileSync(f.bundleFile("extra.tgz"), "unreviewed");
    expect(() => f.execute(npmArchivePublishCommand("stage"))).toThrow(/Unexpected/);
    fs.unlinkSync(f.bundleFile("manifest.json"));
    expect(() => f.execute(npmArchivePublishCommand("stage"))).toThrow();
  });

  test("refuses changed manifest options even when all tarballs are unchanged", () => {
    const f = fixture();
    twoPackages(f);
    f.execute(npmArchivePrepareCommand);
    const manifest = f.manifest();
    manifest.packages[0].access = "restricted";
    fs.writeFileSync(f.bundleFile("manifest.json"), JSON.stringify(manifest));
    f.calls.length = 0;
    expect(() => f.execute(npmArchivePublishCommand("stage"))).toThrow(/manifest digest/);
    expect(f.calls).toEqual([]);
  });

  test("skips versions published during review without tagging or restaging them", () => {
    const f = fixture();
    twoPackages(f);
    f.execute(npmArchivePrepareCommand);
    f.published.add("@demo/core@1.0.0");
    f.calls.length = 0;
    f.execute(npmArchivePublishCommand("stage"));
    expect(f.calls.filter((call) => call.args.includes("publish"))).toHaveLength(1);
    expect(f.logs).not.toContain("New tag: @demo/core@1.0.0");
  });

  test.each(["packages/**", "!packages/private", "../outside", "packages/{a,b}"])(
    "requires manual setup for workspace pattern %s",
    (pattern) => {
      const f = fixture();
      f.write("pnpm-workspace.yaml", "packages:\n  - " + pattern + "\n");
      expect(() => f.execute(npmArchivePrepareCommand)).toThrow(/workspace/);
      expect(f.calls).toEqual([]);
    },
  );

  test("empty selection produces a verifiable plan and a false job output", () => {
    const f = fixture();
    f.execute(npmArchivePrepareCommand);
    expect(f.manifest().packages).toEqual([]);
    expect(fs.readFileSync(path.join(f.root, "output"), "utf8")).toBe("has_packages=false\n");
    f.execute(npmArchivePublishCommand("stage"));
    expect(
      f.calls.every((call) => call.command === "git" && call.args.join(" ") === "rev-parse HEAD"),
    ).toBe(true);
  });

  test.each(["@demo/internal-*", "@demo/*", "!@demo/internal-tool", "**"])(
    "rejects nonliteral Changesets ignore entry %s before registry checks or builds",
    (pattern) => {
      const f = fixture();
      twoPackages(f);
      f.write("packages/internal/package.json", {
        name: "@demo/internal-tool",
        version: "1.0.0",
        scripts: { prepublishOnly: "must not run" },
      });
      f.write(".changeset/config.json", { access: "public", ignore: [pattern] });
      expect(() => f.execute(npmArchivePrepareCommand)).toThrow(/only literal package names/);
      expect(f.calls).toEqual([]);
    },
  );

  test("preserves only successful package tags when a later staging operation fails", () => {
    const f = fixture();
    twoPackages(f);
    f.execute(npmArchivePrepareCommand);
    f.failPublicationAt(2);
    f.calls.length = 0;
    expect(() => f.execute(npmArchivePublishCommand("stage"))).toThrow(/Command failed/);
    expect(f.logs).toContain("New tag: @demo/core@1.0.0");
    expect(f.logs).not.toContain("New tag: @demo/peer@2.0.0-rc.3");
    expect(f.calls.filter((call) => call.command === "git" && call.args[0] === "tag")).toHaveLength(
      1,
    );
  });

  test.each([
    (manifest: ReturnType<ReturnType<typeof fixture>["manifest"]>) => {
      manifest.packages[1].name = manifest.packages[0].name;
    },
    (manifest: ReturnType<ReturnType<typeof fixture>["manifest"]>) => {
      manifest.packages[1].archive = manifest.packages[0].archive;
    },
    (manifest: ReturnType<ReturnType<typeof fixture>["manifest"]>) => {
      manifest.packages[1].tag = "--registry=attacker";
    },
    (manifest: ReturnType<ReturnType<typeof fixture>["manifest"]>) => {
      manifest.packages[1].access = "other";
    },
  ])("rejects invalid metadata in the last entry before publishing the first %#", (change) => {
    const f = fixture();
    twoPackages(f);
    f.execute(npmArchivePrepareCommand);
    const manifest = f.manifest();
    change(manifest);
    f.rewriteManifest(manifest);
    f.calls.length = 0;
    expect(() => f.execute(npmArchivePublishCommand("stage"))).toThrow();
    expect(f.calls).toEqual([]);
  });

  test("rejects oversized manifest metadata without reading it or running commands", () => {
    const f = fixture();
    twoPackages(f);
    f.execute(npmArchivePrepareCommand);
    const boundedFs = {
      ...fs,
      lstatSync: (file: string) =>
        file.endsWith("manifest.json")
          ? { isFile: () => true, isSymbolicLink: () => false, size: 65537 }
          : fs.lstatSync(file),
    };
    f.calls.length = 0;
    expect(() => f.execute(npmArchivePublishCommand("stage"), { "node:fs": boundedFs })).toThrow(
      /oversized/,
    );
    expect(f.calls).toEqual([]);
  });

  test("packs a public root package and refuses unsupported post-publication hooks", () => {
    const f = fixture();
    fs.unlinkSync(path.join(f.root, "pnpm-workspace.yaml"));
    f.write("package.json", {
      name: "single-package",
      version: "1.2.3",
      scripts: { postpublish: "must not run" },
    });
    expect(() => f.execute(npmArchivePrepareCommand)).toThrow(/lifecycle/);
    expect(
      f.calls.every(
        (call) =>
          (call.command === "npm" && call.args[0] === "view") ||
          (call.command === "git" && call.args.join(" ") === "rev-parse HEAD"),
      ),
    ).toBe(true);
    f.write("package.json", { name: "single-package", version: "1.2.3" });
    f.execute(npmArchivePrepareCommand);
    expect(f.manifest().packages.map((pkg) => pkg.name)).toEqual(["single-package"]);
  });

  test("preparation refuses a checkout that differs from the CI source before registry checks or builds", () => {
    const f = fixture();
    twoPackages(f);
    f.setCheckout("b".repeat(40));
    expect(() => f.execute(npmArchivePrepareCommand)).toThrow(/checkout does not match/);
    expect(f.calls).toEqual([{ command: "git", args: ["rev-parse", "HEAD"], cwd: f.root }]);
  });

  test.each(["", "not-a-commit", "a".repeat(41)])("requires a valid CI source commit %s", (sha) => {
    const f = fixture();
    twoPackages(f);
    f.setGithubSha(sha);
    expect(() => f.execute(npmArchivePrepareCommand)).toThrow(/valid GITHUB_SHA/);
    expect(f.calls).toEqual([]);
  });

  test.each([40, 64])(
    "records and verifies the %i-character source commit across both jobs",
    (length) => {
      const f = fixture();
      twoPackages(f);
      const sha = "c".repeat(length);
      f.setGithubSha(sha);
      f.setCheckout(sha);
      f.execute(npmArchivePrepareCommand);
      expect(f.manifest().sourceCommit).toBe(sha);
      f.execute(npmArchivePublishCommand("stage"));
      expect(f.logs).toContain("New tag: @demo/core@1.0.0");
    },
  );

  test.each([true, false])(
    "refuses different publish checkout before publication and tag writes; CI changed=%s",
    (changeCi) => {
      const f = fixture();
      twoPackages(f);
      f.execute(npmArchivePrepareCommand);
      f.setCheckout("b".repeat(40));
      if (changeCi) f.setGithubSha("b".repeat(40));
      f.calls.length = 0;
      expect(() => f.execute(npmArchivePublishCommand("stage"))).toThrow(
        /different source commit|checkout does not match/,
      );
      expect(f.calls).toEqual([{ command: "git", args: ["rev-parse", "HEAD"], cwd: f.root }]);
      expect(f.logs.some((line) => line.startsWith("New tag:"))).toBe(false);
    },
  );
});
